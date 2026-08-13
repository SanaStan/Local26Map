/*
 * Aimbridge Hospitality careers scraper.
 *
 * Aimbridge is a third-party hotel management company (not a brand) —
 * several nominally "independent" hotels on this project's list turn out
 * to actually be Aimbridge-managed, posting jobs through Aimbridge's own
 * careers site rather than any brand's. careers.aimbridge.fountain.com
 * runs on Fountain, an ATS whose JSON API (`aimbridge.fountain.com/
 * internal_api/career_site/...`) is public and unauthenticated — plain
 * `fetch()` works cold, no session/cookies/CSRF needed, closer to
 * Hilton's setup than Hyatt's or Accor's.
 *
 * Search is a Google-Places-based radius search: resolve a location
 * string to a `place_id`, then page through openings sorted by distance
 * from it. `radius` only accepts the literal string `"any"` in practice
 * — passing a mile figure (tried 5–100) returns zero results — so this
 * pages through the *entire* nationwide portfolio (sorted nearest-first)
 * and relies on distance sorting plus a page cap to stay efficient,
 * filtering to the right metro area client-side by property name, same
 * as every other brand here.
 *
 * The location-suggest endpoint that resolves a place name to its Place
 * ID (`search/funnels_by_location`) 500s under plain Node `fetch()` but
 * works fine under Playwright's `context.request` — same class of
 * fetch-vs-browser fingerprinting issue as Hyatt/Omni. Since this
 * project only ever cares about the Boston metro, it's not worth taking
 * on a Playwright dependency just for one geocode lookup: Google Place
 * IDs are stable, so Boston's is hardcoded below instead.
 */

const API_BASE = 'https://aimbridge.fountain.com/internal_api/career_site';
const ACCOUNT_SLUG = 'aimbridge';
const PAGE_SIZE = 10;

/** Google Place ID for "Boston, MA, USA" — stable, resolved once via
 * Aimbridge's own location-suggest endpoint. */
export const BOSTON_PLACE_ID = 'ChIJGzE9DS1l44kRoOhiASS_fHg';

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Aimbridge API ${res.status} for ${url}`);
  return res.json();
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

const PAY_RE = /\$([\d,]+(?:\.\d+)?)(?:\s*-\s*\$([\d,]+(?:\.\d+)?))?\s*\/\s*(hour|year)/i;

/** pay_rate is a clean structured field (e.g. "$28.00 - $32.00/hour",
 * "$110,000.00/year") — no freeform-description parsing needed, unlike
 * Omni/Accor. The /hour vs /year label is occasionally a data-entry typo
 * in Aimbridge's own system (observed: "$120,000.00 - $130,000.00/hour",
 * "$16.00/year"), so magnitude — not the label — decides payUnit, same
 * heuristic as everywhere else this comes up. */
export function parsePay(payRateText) {
  if (!payRateText) return null;
  const m = payRateText.match(PAY_RE);
  if (!m) return null;
  const payMin = parseFloat(m[1].replace(/,/g, ''));
  const payMax = m[2] ? parseFloat(m[2].replace(/,/g, '')) : payMin;
  const payUnit = payMax >= 200 ? 'annual' : undefined;
  return payUnit ? { payMin, payMax, payUnit } : { payMin, payMax };
}

/**
 * Fetches every job opening "near" `placeId`, paginating through results
 * sorted by distance from it. Since `radius=any` covers Aimbridge's
 * entire ~1,450-job nationwide portfolio, `maxPages` is what actually
 * keeps this scoped to a metro area — verified empirically that 20 pages
 * (200 jobs) comfortably covers all of Massachusetts from a Boston
 * center point before results drift into Connecticut/other states, with
 * plenty of margin. The caller still filters by property name rather
 * than relying on this cutoff for correctness.
 */
export async function scrapeAimbridgeLocation(placeId, { maxPages = 20 } = {}) {
  const jobs = [];
  for (let page = 1; page <= maxPages; page++) {
    const url =
      `${API_BASE}/openings?career_site%5Baccount_slug%5D=${ACCOUNT_SLUG}` +
      `&career_site%5Bplace_id%5D=${encodeURIComponent(placeId)}` +
      `&career_site%5Bis_jobs_from_current_location%5D=true` +
      `&page=${page}&radius=any&sort_by=distance&category=any&compensation_type=any&location=current_location&locale=en-US`;
    const data = await fetchJson(url);
    const openings = data.openings || [];
    for (const o of openings) {
      jobs.push({
        id: o.id,
        // Aimbridge's own `title` field is always "{Property} - {Position}"
        // (no separate position field on this endpoint) — strip the
        // property-name prefix since every other scraper here returns a
        // clean position-only title and the property name is already
        // shown as the hotel heading in the UI.
        title: o.title.startsWith(`${o.location} - `) ? o.title.slice(o.location.length + 3) : o.title,
        propertyName: o.location,
        payRate: o.pay_rate,
        applyUrl: o.apply_url,
      });
    }
    if (!data.pagination || !data.pagination.next_page || openings.length < PAGE_SIZE) break;
  }
  return jobs;
}

/**
 * Confirms a job posting is still live — closed/removed postings 404
 * cleanly (a live one 302-redirects into the full apply flow), so a
 * plain status check is enough.
 */
export async function verifyJobLive(applyUrl) {
  const res = await fetch(applyUrl, { redirect: 'manual' });
  if (res.status >= 400) return null;
  return { url: applyUrl };
}
