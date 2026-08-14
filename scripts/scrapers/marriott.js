/*
 * Marriott careers scraper.
 *
 * careers.marriott.com has a real JSON API (/api/get-jobs) but it sits
 * behind Akamai bot protection that 403s even an in-page fetch() call —
 * only requests the site's own script initiates (page load, pagination
 * clicks) carry whatever sensor/fingerprint data Akamai wants. So this
 * scrapes the rendered DOM instead, driving pagination with real clicks
 * rather than URL navigation — a plain fetch of /jobs/page/2 silently
 * drops the location filter and falls back to the full 13,000+ job list.
 * Clicking the in-page "next" control does not have this problem because
 * it's a client-side route change, not a fresh page load.
 *
 * domcontentloaded, not networkidle: same class of issue already seen on
 * Hyatt — this page's continuous background analytics/tracking traffic
 * can prevent networkidle from ever settling (observed repeated 60s
 * timeouts starting 2026-08-14). Safe to drop since the results list is
 * waited for explicitly by selector right after — confirmed the results
 * list renders ~2s after domcontentloaded, well before any fixed delay
 * would have fired anyway. Also confirmed the site always renders
 * *something* for any location string, even a nonsense one (falls back
 * to "these results are close to ..." against the full nationwide list
 * rather than showing zero), so waiting for that selector can't hang on
 * a genuinely-empty result set — the per-hotel property-name match
 * downstream is what actually filters out that noise for an unmatched
 * location.
 */

const PAY_HOURLY_RE = /\$([\d,]+\.\d{2})\s*-\s*\$([\d,]+\.\d{2})\s*per hour/i;
const PAY_ANNUAL_RE = /\$([\d,]+)\s*-\s*\$([\d,]+)\s*annually/i;

export function parsePay(payText) {
  if (!payText) return null;
  let m = payText.match(PAY_HOURLY_RE);
  if (m) return { payMin: parseFloat(m[1].replace(/,/g, '')), payMax: parseFloat(m[2].replace(/,/g, '')) };
  m = payText.match(PAY_ANNUAL_RE);
  if (m) return { payMin: parseInt(m[1].replace(/,/g, ''), 10), payMax: parseInt(m[2].replace(/,/g, ''), 10), payUnit: 'annual' };
  return null;
}

export function normalizePropertyName(s) {
  return s
    .toLowerCase()
    .replace(/[,.]/g, '')
    .replace(/\bby marriott\b/g, '')
    .replace(/\bthe\b/g, '')
    .replace(/\bhotel\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function propertyMatches(propertyName, propertyMatch) {
  if (!propertyName || !propertyMatch) return false;
  return normalizePropertyName(propertyName) === normalizePropertyName(propertyMatch);
}

/**
 * Scrapes every job listed for a location-filtered Marriott careers search,
 * paging through all result pages. Returns raw (unmatched) job records.
 */
export async function scrapeMarriottLocation(page, locationName, { maxPages = 20 } = {}) {
  const url = `https://careers.marriott.com/jobs?location_type=2&location_name=${encodeURIComponent(locationName)}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('li.results-list__item', { timeout: 30000 });

  const pageSizeSelect = page.locator('#page-size-select');
  if (await pageSizeSelect.count()) {
    await pageSizeSelect.selectOption('20');
    await page.waitForTimeout(1500);
  }

  const seenUrls = new Set();
  const jobs = [];
  let pageNum = 1;

  while (pageNum <= maxPages) {
    const pageJobs = await page.$$eval('li.results-list__item', (items) =>
      items.map((li) => {
        const titleLink = li.querySelector('.results-list__item-title--link');
        const refEl = li.querySelector('.reference');
        const propEl = li.querySelector('.results-list__item-location--label');
        const payEl = li.querySelector('.results-list__item-pay--label');
        const streetEl = li.querySelector('.results-list__item-street--label');
        return {
          title: titleLink ? titleLink.textContent.trim() : null,
          url: titleLink ? titleLink.href.split('?')[0] : null,
          jobId: refEl ? refEl.textContent.trim() : null,
          propertyName: propEl ? propEl.textContent.trim() : null,
          payText: payEl ? payEl.textContent.trim() : null,
          address: streetEl ? streetEl.textContent.trim() : null,
        };
      })
    );

    for (const j of pageJobs) {
      if (j.url && !seenUrls.has(j.url)) {
        seenUrls.add(j.url);
        jobs.push(j);
      }
    }

    const nextBtn = page.locator('[data-testid="jobs-pagination_link_next"]');
    if ((await nextBtn.count()) === 0) break;
    const ariaDisabled = await nextBtn.getAttribute('aria-disabled');
    if (ariaDisabled === 'true') break;

    await nextBtn.click();
    await page.waitForTimeout(1500);
    pageNum++;
  }

  return jobs;
}

/**
 * Visits a job's own detail page to confirm it's actually live (per the
 * project's "verify before including" rule — search results can be stale)
 * and to pull datePosted from Marriott's own JobPosting structured data,
 * which is a more trustworthy "posted since" signal than anything inferred
 * from our own scrape cadence. Returns null if the listing 404s or the
 * structured data is missing/unparseable.
 */
export async function fetchJobDetail(page, jobUrl) {
  try {
    const res = await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (!res || !res.ok()) return null;
    const ldJson = await page.evaluate(() => {
      const el = document.querySelector('script[type="application/ld+json"]');
      return el ? el.textContent : null;
    });
    if (!ldJson) return { datePosted: null };
    const parsed = JSON.parse(ldJson);
    return { datePosted: parsed.datePosted || null };
  } catch {
    return null;
  }
}
