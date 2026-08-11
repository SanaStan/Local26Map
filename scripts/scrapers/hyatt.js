/*
 * Hyatt careers scraper.
 *
 * careers.hyatt.com runs on Oracle Taleo (the older, non-"Recruiting
 * Cloud" ATS product — a different Oracle product than Hilton's). Unlike
 * Hilton, its `careersection/rest/jobboard/searchjobs` endpoint 500s on
 * any request that isn't driven by genuine UI interaction (verified: a
 * byte-identical POST body/headers, replayed via `context.request` or an
 * in-page `fetch()`, still 500s — only a real typed-and-clicked search
 * succeeds). So, like Marriott, this drives the actual page with
 * Playwright rather than calling the API directly.
 *
 * The site is also organized around three parallel "portals" (career
 * sections) — 21860210089, 22260210089, 68160210089 — that all get
 * queried on every search; a property's jobs can land in any one of
 * them, so results from all three are merged.
 *
 * Search works by typing a property's exact name into the combined
 * keyword/location box and clicking the top (organization-type)
 * autocomplete suggestion, which applies an ORGANIZATION facet filter
 * server-side — much more precise than a location-radius search, but it
 * only surfaces properties that currently have at least one open
 * requisition (confirmed: a property with zero live postings doesn't
 * appear in the suggestion list at all, even though the site also ships
 * a ~3000-entry static checkbox list of properties that turned out to be
 * the same currently-posting subset, not a full portfolio directory).
 */

const SEARCH_URL = 'https://careers.hyatt.com/en-us/careers/search';
const PORTALS = ['21860210089', '22260210089', '68160210089'];
const JOB_DETAIL_BASE = 'https://careers.hyatt.com/en-us/careers/jobdetails/10780';

const PAY_TITLE_RE = /\$([\d,]+\.?\d*)\s*(?:[-–]\s*\$?([\d,]+\.?\d*))?\s*\/?\s*(hour|hourly|hr|yearly|annual|annually|year|salary)/i;

/** Pay only ever shows up (inconsistently, at each poster's discretion) embedded
 * in the job title, e.g. "Guest Service Agent (Full Time, $33.20 hourly)" — the
 * detail page itself just says "Hourly US Dollar (USD) pay basis" with no number.
 * Most Hyatt jobs won't match this at all, which is expected, not a bug. */
export function parsePay(title) {
  if (!title) return null;
  const m = title.match(PAY_TITLE_RE);
  if (!m) return null;
  const payMin = parseFloat(m[1].replace(/,/g, ''));
  const payMax = m[2] ? parseFloat(m[2].replace(/,/g, '')) : payMin;
  const isHourly = /hour|hr/i.test(m[3]);
  return isHourly ? { payMin, payMax } : { payMin, payMax, payUnit: 'annual' };
}

export function normalizePropertyName(s) {
  return s
    .toLowerCase()
    .replace(/[&,.-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function propertyMatches(propertyName, propertyMatch) {
  if (!propertyName || !propertyMatch) return false;
  const aliases = Array.isArray(propertyMatch) ? propertyMatch : [propertyMatch];
  const normalized = normalizePropertyName(propertyName);
  return aliases.some((alias) => normalizePropertyName(alias) === normalized);
}

function parsePostedDate(text) {
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * Searches for `propertyName` on the Hyatt careers site and returns every
 * matching raw job record (title/category/location/postedDate/contestNo),
 * already filtered to jobs whose own property name matches (a safety net
 * in case the autocomplete ever resolves to something looser than an
 * exact organization filter).
 */
export async function scrapeHyattProperty(page, propertyName) {
  const input = page.locator('#keywordLocation');
  await input.click();
  await input.fill('');
  await input.fill(propertyName);
  // The dropdown shows a "Enter at least 2 characters..." loading placeholder
  // (with a big pile of embedded animation-script junk text) before the real
  // autocomplete results replace it — a fixed delay races that debounce and
  // intermittently clicks the placeholder instead, silently applying no
  // filter at all. Wait for an actual short, real suggestion string instead.
  await page
    .waitForFunction(
      () => {
        const items = document.querySelectorAll('#keywordLocation_list li[role="option"]');
        return [...items].some((li) => {
          const t = li.textContent.trim();
          return t.length > 0 && t.length < 200 && !t.includes('Enter at least');
        });
      },
      { timeout: 8000 },
    )
    .catch(() => {});

  const option = page.locator('#keywordLocation_list li[role="option"]').first();
  if ((await option.count()) === 0) {
    return []; // no autocomplete match at all — property currently has zero live postings
  }

  // Register one waitForResponse per portal *before* clicking, so each is
  // ready to catch the very next matching response the click triggers.
  // (`page.waitForLoadState('networkidle')` doesn't work here — it's tied to
  // navigation lifecycle, not ongoing same-page XHRs, so it resolves
  // instantly and was silently skipping the actual wait.) Doing this after
  // the previous property's search has already fully resolved — which the
  // sequential loop in scrapeHyattBrand guarantees — means there's no
  // leftover in-flight request from an earlier search left to be
  // misattributed here.
  const responsePromises = PORTALS.map((portal) =>
    page
      .waitForResponse((res) => res.url().includes('jobboard/searchjobs') && res.url().includes(`portal=${portal}`), { timeout: 15000 })
      .catch(() => null),
  );
  await option.click();
  const rawResponses = await Promise.all(responsePromises);

  const responses = [];
  for (const res of rawResponses) {
    if (!res) continue; // this portal never responded in time — treated as 0 jobs from it
    try {
      responses.push(await res.json());
    } catch {
      // non-JSON (error) response — ignore, treated as "no jobs from this portal"
    }
  }

  const jobs = [];
  for (const json of responses) {
    for (const r of json.requisitionList || []) {
      const [title, property, category, locationRaw, postedRaw] = r.column;
      if (!propertyMatches(property, propertyName)) continue;
      jobs.push({
        contestNo: r.contestNo,
        title,
        category: category || null,
        location: locationRaw,
        postedDate: parsePostedDate(postedRaw),
      });
    }
  }
  return jobs;
}

/**
 * Visits a job's own detail page to confirm it's still live — Taleo
 * returns HTTP 200 even for closed requisitions, just with "THE JOB IS NO
 * LONGER AVAILABLE" in the page body, so that text is the actual signal
 * (same "verify before including" rule as Marriott/Hilton, different
 * failure shape).
 */
export async function verifyJobLive(page, contestNo) {
  const url = `${JOB_DETAIL_BASE}/${contestNo}`;
  // networkidle, not domcontentloaded: the page is an Angular SPA that
  // fetches and renders the "no longer available" state client-side after
  // load, so reading body text too early misses it.
  const res = await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  if (!res || !res.ok()) return null;
  const text = await page.locator('body').innerText();
  if (/no longer available/i.test(text)) return null;
  return { url };
}
