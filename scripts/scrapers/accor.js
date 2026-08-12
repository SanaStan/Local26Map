/*
 * Accor careers scraper (for Accor-family brands — Fairmont, Raffles,
 * Sofitel, etc. — not just hotels literally branded "Accor").
 *
 * careers.accor.com runs on the Attrax recruitment platform. Search
 * results render entirely client-side; unlike Hilton/Omni/Hyatt, no
 * isolated XHR/JSON endpoint carries the job list — the query-string-
 * bearing page itself is what gets hydrated — so this drives a full
 * Playwright page and scrapes the rendered DOM, like Marriott.
 *
 * Search is keyword-based (`?q=<property name>`), which reliably narrows
 * to just that property's jobs (no cross-property false positives
 * observed in testing). Pagination is driven by calling the page's own
 * global `pagination(n)` JS function directly — a plain URL navigation to
 * `&page=N` gets aborted; this "NoReload" widget only accepts being
 * driven through its own client-side router, not query-string navigation.
 *
 * Each result tile's CSS classes carry structured data for free — a
 * `sector-<slug>` class gives the job's category, no separate lookup
 * needed — but pay isn't one of them (the tile has a dedicated salary
 * field in the markup, always empty in practice); it only ever shows up
 * as freeform text in the job's own detail page description, same
 * situation as Omni.
 */

const BASE = 'https://careers.accor.com';
const SEARCH_PATH = '/global/en/jobs';
const TILE_SELECTOR = '.attrax-vacancy-tile';

async function dismissCookieBanner(page) {
  await page
    .locator('text=Continue without Accepting')
    .first()
    .click({ timeout: 3000 })
    .catch(() => {});
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

const DOLLAR_RE = /\$([\d,]+(?:\.\d+)?)/g;

/** Same approach as Omni's parsePay — pay isn't a structured field, it's a
 * sentence embedded in the free-text job description. Every dollar figure
 * observed across a range of hourly/salaried/ranged postings was
 * pay-related. */
export function parsePay(bodyText) {
  if (!bodyText) return null;
  const nums = [...bodyText.matchAll(DOLLAR_RE)].map((m) => parseFloat(m[1].replace(/,/g, '')));
  if (nums.length === 0) return null;
  const payMin = Math.min(...nums);
  const payMax = Math.max(...nums);
  const payUnit = payMax >= 200 ? 'annual' : undefined;
  return payUnit ? { payMin, payMax, payUnit } : { payMin, payMax };
}

function categoryFromClasses(classAttr) {
  const sector = (classAttr || '').split(/\s+/).find((c) => c.startsWith('sector-') && c !== 'sector-all');
  if (!sector) return null;
  return sector
    .replace('sector-', '')
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

async function readTiles(page) {
  try {
    return await page.$$eval(TILE_SELECTOR, (els) =>
      els.map((el) => ({
        jobId: el.dataset.jobid,
        title: el.querySelector('.attrax-vacancy-tile__title')?.textContent.trim(),
        href: el.querySelector('.attrax-vacancy-tile__title')?.getAttribute('href'),
        // location-freetext is a full address ("Property Name, City, Country") — only the
        // property-name segment before the first comma is meaningful for matching.
        location: el.querySelector('.attrax-vacancy-tile__location-freetext .attrax-vacancy-tile__item-value')?.textContent.trim().split(',')[0].trim(),
        classes: el.className,
      })),
    );
  } catch (err) {
    // pagination(n) occasionally triggers a real (not just DOM-patching)
    // navigation, which can destroy the JS execution context mid-read —
    // treat that as "not ready yet" so the polling loop just retries.
    if (/execution context was destroyed/i.test(err.message)) return [];
    throw err;
  }
}

/**
 * Searches for `propertyName` and returns every matching raw job record,
 * already filtered to jobs whose own listed location matches (a safety
 * net, same as the other scrapers, in case the keyword search ever
 * resolves loosely).
 */
export async function scrapeAccorProperty(page, propertyName, { maxPages = 10 } = {}) {
  await page.goto(`${BASE}${SEARCH_PATH}?q=${encodeURIComponent(propertyName)}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await dismissCookieBanner(page);
  await page.waitForSelector(TILE_SELECTOR, { timeout: 15000 }).catch(() => {});

  const all = [];
  const seenIds = new Set();
  let prevFirstId = null;
  for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
    if (pageNum > 1) {
      // The page occasionally does a real navigation instead of an in-place
      // DOM patch when paginating (see readTiles), which can make this call
      // itself throw (e.g. the global `pagination` function isn't defined on
      // whatever page loaded mid-transition) — that's usually transient, so
      // retry a couple of times before accepting whatever's already been
      // collected as the final (partial) result rather than losing later
      // pages to a one-off timing glitch.
      let paginated = false;
      for (let attempt = 0; attempt < 3 && !paginated; attempt++) {
        try {
          await page.evaluate((n) => {
            pagination(n);
          }, pageNum);
          paginated = true;
        } catch {
          await page.waitForTimeout(1000);
        }
      }
      if (!paginated) break;
      // Wait for a non-empty tile set whose first job differs from the
      // previous page's — empty reads happen transiently while a real
      // navigation is still settling (see readTiles) and shouldn't be
      // mistaken for "tiles changed, move on".
      const deadline = Date.now() + 10000;
      for (;;) {
        const probe = await readTiles(page);
        if (probe.length > 0 && probe[0].jobId !== prevFirstId) break;
        if (Date.now() >= deadline) break;
        await page.waitForTimeout(300);
      }
    }
    const tiles = await readTiles(page);
    if (tiles.length === 0) break;
    const firstId = tiles[0].jobId;
    if (firstId === prevFirstId) break; // pagination didn't advance — no more pages
    prevFirstId = firstId;

    for (const t of tiles) {
      if (t.jobId && !seenIds.has(t.jobId)) {
        seenIds.add(t.jobId);
        all.push(t);
      }
    }
    if (tiles.length < 12) break; // fewer than a full page — this was the last one
  }

  return all
    .filter((t) => propertyMatches(t.location, propertyName))
    .map((t) => ({
      id: t.jobId,
      title: t.title,
      url: `${BASE}${t.href}`,
      category: categoryFromClasses(t.classes),
    }));
}

/**
 * Visits a job's own detail page to confirm it's still live (closed
 * postings 404 cleanly — no need for Hyatt-style page-text inspection)
 * and to parse pay out of the rendered description.
 */
export async function verifyJobLive(page, url) {
  const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  if (!res || !res.ok()) return null;
  await page.waitForSelector('#headertext', { timeout: 15000 }).catch(() => {});
  await dismissCookieBanner(page);
  const text = await page.locator('body').innerText();
  return { url, pay: parsePay(text) };
}
