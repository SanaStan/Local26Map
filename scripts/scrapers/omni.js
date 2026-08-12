/*
 * Omni Hotels careers scraper.
 *
 * jobs.dayforcehcm.com/en-US/ohmc/CANDIDATEPORTAL is a Dayforce (Ceridian)
 * candidate portal — a different ATS platform than Marriott, Hilton, or
 * Hyatt. Its JSON API (`api/geo/ohmc/...`) is real and returns clean
 * structured data, but requires an `x-csrf-token` header sourced from
 * `api/auth/csrf`, and — like Hyatt's Taleo API, unlike Hilton's — plain
 * Node `fetch()`/`curl` get 403'd on the POST endpoints even with a valid
 * token and realistic UA, while Playwright's `context.request` (still no
 * full page render needed) works fine cold. So this takes a Playwright
 * `request` context (i.e. `browserContext.request`) rather than either a
 * bare-fetch design like Hilton's or a page-driving one like Hyatt's.
 *
 * Search is radius-based like Hilton, except the location lookup
 * (`location/search?filter=<query>`) resolves directly to a *property*
 * (with its own locationId), not a city — searching a city name like
 * "Boston" happens to return exactly the matching hotels directly. A
 * 15-mile radius search from either Boston property returns both
 * properties' jobs combined, so one search covers every tracked Omni
 * hotel in a metro area, same as Hilton's per-city search.
 */

const BASE = 'https://jobs.dayforcehcm.com';
const NAMESPACE = 'ohmc';
const JOB_BOARD_CODE = 'CANDIDATEPORTAL';
const PAGE_SIZE = 25;

async function getCsrfToken(request) {
  const res = await request.get(`${BASE}/api/auth/csrf`, { headers: { Accept: 'application/json' } });
  const { csrfToken } = await res.json();
  return csrfToken;
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

/** Pay isn't a structured field — it's a sentence embedded in the free-text job
 * description (e.g. "The hourly rate for this position is $32.21.", "Salary
 * range for this position is $95,000 - $110,000 per year."). Every dollar
 * figure found in a description was, in practice, pay-related (no stray
 * bonus/tip mentions observed), including step-scale postings that list a
 * starting *and* a later-raise rate — taking the overall min/max span across
 * every figure found is a reasonable single range for either case. */
export function parsePay(descriptionHtml) {
  if (!descriptionHtml) return null;
  const text = descriptionHtml.replace(/&nbsp;/g, ' ');
  const nums = [...text.matchAll(DOLLAR_RE)].map((m) => parseFloat(m[1].replace(/,/g, '')));
  if (nums.length === 0) return null;
  const payMin = Math.min(...nums);
  const payMax = Math.max(...nums);
  // Every hourly figure seen is a two-digit wage; every annual figure is in
  // the tens/hundreds of thousands — same magnitude heuristic as Hilton.
  const payUnit = payMax >= 200 ? 'annual' : undefined;
  return payUnit ? { payMin, payMax, payUnit } : { payMin, payMax };
}

/** Resolves a query (city or property name) to Dayforce's location search
 * results — for Boston this happens to return exactly the matching Omni
 * properties directly, each with its own locationId. */
export async function geocodeLocations(request, query) {
  const token = await getCsrfToken(request);
  const res = await request.post(`${BASE}/api/geo/${NAMESPACE}/location/search?filter=${encodeURIComponent(query)}`, {
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-csrf-token': token },
    data: { clientNamespace: NAMESPACE, isoCultureCode: 'en-US', jobBoardId: 1 },
  });
  if (!res.ok()) return [];
  return res.json();
}

/**
 * Fetches every job posting within `distance` miles of the given location,
 * paginating through results. Returns raw job records with each hit's
 * property name (from postingLocations) and description (needed for pay,
 * since it's not a separate field).
 */
export async function scrapeOmniLocation(request, { locationId, locationString, distance = 15 } = {}) {
  const token = await getCsrfToken(request);
  const jobs = [];
  let start = 0;
  for (;;) {
    const res = await request.post(`${BASE}/api/geo/${NAMESPACE}/jobposting/search`, {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-csrf-token': token },
      data: {
        clientNamespace: NAMESPACE,
        jobBoardCode: JOB_BOARD_CODE,
        cultureCode: 'en-US',
        locationId,
        locationString,
        locationType: 1,
        distance,
        distanceUnit: 0,
        paginationStart: start,
      },
    });
    if (!res.ok()) break;
    const json = await res.json();
    const list = json.jobPostings || [];
    for (const r of list) {
      const loc = r.postingLocations?.[0];
      jobs.push({
        id: r.jobPostingId,
        title: r.jobTitle.trim(),
        description: r.jobDescription,
        propertyName: loc ? loc.formattedAddress.split(',')[0].trim() : null,
        postedDate: r.postingStartTimestampUTC ? r.postingStartTimestampUTC.slice(0, 10) : null,
      });
    }
    start += list.length;
    if (list.length === 0 || start >= (json.maxCount || 0)) break;
  }
  return jobs;
}

/**
 * Confirms a job posting is still live — unlike Hyatt's Taleo, Dayforce's
 * job detail page 404s cleanly for a closed/removed requisition, so a plain
 * status check is enough (no need to inspect rendered page text).
 */
export async function verifyJobLive(request, jobId) {
  const url = `${BASE}/en-US/${NAMESPACE}/${JOB_BOARD_CODE}/jobs/${jobId}`;
  // Generous timeout: this specific request has been observed completing its
  // headers quickly but taking a while to finish downloading the (gzipped,
  // Cloudflare-fronted) body.
  const res = await request.get(url, { headers: { Accept: 'text/html' }, timeout: 60000 });
  if (!res.ok()) return null;
  return { url };
}
