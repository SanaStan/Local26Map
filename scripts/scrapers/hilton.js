/*
 * Hilton careers scraper.
 *
 * Unlike careers.marriott.com, jobs.hilton.com is a thin wrapper around a
 * standard Oracle Recruiting Cloud ("Candidate Experience") instance at
 * efet.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1009.
 * Its REST API is public and completely unprotected — no Akamai/bot
 * fingerprinting, works from a plain `fetch()` with no session or
 * cookies. So this doesn't need Playwright at all, just the search and
 * detail JSON endpoints directly:
 *   - recruitingCESearchAutoSuggestions  — resolve a city name to a
 *     LocationId (geocoding for the radius search below).
 *   - recruitingCEJobRequisitions        — location-radius job search,
 *     returns each hit's exact property name via workLocation[0].
 *   - recruitingCEJobRequisitionDetails  — per-job detail, used both to
 *     verify the requisition is still live (empty `items` = gone, same
 *     "verify before including" rule as Marriott) and to pull the real
 *     job Category and Salary text, which the search results don't
 *     include.
 * Pay is entered as freeform text by each property's HR team (not a
 * structured min/max field), so parsePay() below has to handle a wide
 * variety of formats — see the format list this was built against in the
 * project README.
 */

const BASE = 'https://efet.fa.us2.oraclecloud.com/hcmRestApi/resources/latest';
const SITE_NUMBER = 'CX_1009';
const SITE_URL = 'https://efet.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1009';

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Hilton API ${res.status} for ${url}`);
  return res.json();
}

const PAY_NUM_RE = /\$?\s*([\d,]+(?:\.\d+)?)\s*(k)?/gi;

export function parsePay(salaryText) {
  if (!salaryText) return null;
  const text = salaryText.trim();
  if (/week/i.test(text)) return null; // weekly pay isn't modeled in the data schema; too rare to be worth adding

  const isHourly = /hour/i.test(text);
  const isAnnual = !isHourly && /annual|yearly|salary/i.test(text);

  const nums = [];
  let m;
  PAY_NUM_RE.lastIndex = 0;
  while ((m = PAY_NUM_RE.exec(text))) {
    const val = parseFloat(m[1].replace(/,/g, ''));
    if (Number.isNaN(val)) continue;
    nums.push(m[2] ? val * 1000 : val);
  }
  if (nums.length === 0) return null;

  const payMin = nums[0];
  const payMax = nums.length > 1 ? nums[1] : nums[0];
  // No unit words at all (e.g. "$85,000 - $90,000"): fall back to magnitude —
  // every observed hourly wage is under $200, every observed salary is over it.
  const payUnit = isAnnual || (!isHourly && payMax >= 200) ? 'annual' : undefined;
  return payUnit ? { payMin, payMax, payUnit } : { payMin, payMax };
}

export function normalizePropertyName(s) {
  return s
    .toLowerCase()
    .replace(/[&,.-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** propertyMatch may be a single name or an array of aliases (for hotels that
 * are really two co-located, separately-ATS-listed brands, e.g. a combined
 * Hampton Inn & Homewood Suites building). */
export function propertyMatches(propertyName, propertyMatch) {
  if (!propertyName || !propertyMatch) return false;
  const aliases = Array.isArray(propertyMatch) ? propertyMatch : [propertyMatch];
  const normalized = normalizePropertyName(propertyName);
  return aliases.some((alias) => normalizePropertyName(alias) === normalized);
}

/** Resolves a city name to Oracle's internal LocationId for the given state. */
export async function geocodeLocationId(cityQuery, stateAbbr) {
  const url = `${BASE}/recruitingCESearchAutoSuggestions?expand=all&onlyData=true&finder=findByLoc;string=${encodeURIComponent(cityQuery)}&limit=20`;
  const data = await fetchJson(url);
  const items = data.items || [];
  const match = items.find((i) => i.State === stateAbbr) || items[0];
  return match ? match.Id : null;
}

/**
 * Fetches every job requisition within `radius` miles of `locationId`.
 * Returns raw (unmatched) job records with each hit's property name.
 */
export async function scrapeHiltonLocation(locationId, { radius = 25, limit = 100 } = {}) {
  const jobs = [];
  let offset = 0;
  for (;;) {
    const url = `${BASE}/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList.workLocation&finder=findReqs;siteNumber=${SITE_NUMBER},limit=${limit},offset=${offset},locationId=${locationId},radius=${radius},radiusUnit=MI,sortBy=POSTING_DATES_DESC`;
    const data = await fetchJson(url);
    const item = data.items?.[0];
    const list = item?.requisitionList || [];
    for (const r of list) {
      const wl = r.workLocation?.[0];
      jobs.push({
        id: r.Id,
        title: r.Title,
        propertyName: wl ? wl.LocationName : null,
        postedDate: r.PostedDate || null,
      });
    }
    const total = item?.TotalJobsCount || 0;
    offset += list.length;
    if (list.length === 0 || offset >= total) break;
  }
  return jobs;
}

/**
 * Visits a job's own detail endpoint to confirm it's still live (search
 * results can lag behind a requisition being closed — same "verify before
 * including" rule as Marriott) and to pull its Category and Salary text,
 * neither of which the search-results endpoint returns. Returns null if
 * the requisition no longer exists.
 */
export async function fetchJobDetail(jobId) {
  const url = `${BASE}/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;Id=%22${jobId}%22,siteNumber=${SITE_NUMBER}`;
  const data = await fetchJson(url);
  const item = data.items?.[0];
  if (!item) return null;
  const salaryField = (item.requisitionFlexFields || []).find((f) => f.Prompt === 'Salary');
  return {
    category: item.Category || null,
    salaryText: salaryField ? salaryField.Value : null,
    postedDate: item.ExternalPostedStartDate ? item.ExternalPostedStartDate.slice(0, 10) : null,
    url: `${SITE_URL}/job/${jobId}`,
  };
}
