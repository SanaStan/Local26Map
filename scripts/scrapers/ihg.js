/*
 * IHG (InterContinental Hotels Group) careers scraper.
 *
 * careers.ihg.com's "Search jobs" link goes to a stock Oracle Recruiting
 * Cloud instance — the same ATS product as Hilton's, just a different
 * hostname (fa-evax-saasfaprod1.fa.ocs.oraclecloud.com) and site number
 * (CX_1001 vs Hilton's CX_1009). Same public, unauthenticated REST API,
 * same endpoints, same overall shape as scripts/scrapers/hilton.js —
 * see that file for the fuller writeup of how this ATS works. The
 * differences worth calling out:
 *   - The per-job "Hiring Salary" flex field (Hilton's is just called
 *     "Salary") has no `$` sign and no unit suffix at all, just
 *     "USD 30.00 - 32.20" or "USD 75,000.00 - 81,000.00" — magnitude
 *     alone decides payUnit here, there's no unit word to even
 *     cross-check against.
 *   - Job titles carry a redundant "- {Hotel Name}" suffix with
 *     inconsistent hyphen spacing (e.g. "Front Desk Agent -
 *     InterContinental Boston" vs "Executive Steward- InterContinental
 *     Boston") — stripped by the caller in run-scrape.js, which has the
 *     hotel's display name on hand; not handled here since this module
 *     doesn't otherwise know what "clean" should look like per property.
 */

const BASE = 'https://fa-evax-saasfaprod1.fa.ocs.oraclecloud.com/hcmRestApi/resources/latest';
const SITE_NUMBER = 'CX_1001';
const SITE_URL = 'https://fa-evax-saasfaprod1.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001';

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`IHG API ${res.status} for ${url}`);
  return res.json();
}

const PAY_RE = /USD\s*([\d,]+(?:\.\d+)?)(?:\s*-\s*([\d,]+(?:\.\d+)?))?/i;

export function parsePay(salaryText) {
  if (!salaryText) return null;
  const m = salaryText.match(PAY_RE);
  if (!m) return null;
  const payMin = parseFloat(m[1].replace(/,/g, ''));
  const payMax = m[2] ? parseFloat(m[2].replace(/,/g, '')) : payMin;
  const payUnit = payMax >= 200 ? 'annual' : undefined;
  return payUnit ? { payMin, payMax, payUnit } : { payMin, payMax };
}

export function normalizePropertyName(s) {
  return s
    .toLowerCase()
    .replace(/[,.]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function propertyMatches(propertyName, propertyMatch) {
  if (!propertyName || !propertyMatch) return false;
  const aliases = Array.isArray(propertyMatch) ? propertyMatch : [propertyMatch];
  const normalized = normalizePropertyName(propertyName);
  return aliases.some((alias) => normalizePropertyName(alias) === normalized);
}

export async function geocodeLocationId(cityQuery, stateAbbr) {
  const url = `${BASE}/recruitingCESearchAutoSuggestions?expand=all&onlyData=true&finder=findByLoc;string=${encodeURIComponent(cityQuery)}&limit=20`;
  const data = await fetchJson(url);
  const items = data.items || [];
  const match = items.find((i) => i.State === stateAbbr) || items[0];
  return match ? match.Id : null;
}

export async function scrapeIhgLocation(locationId, { radius = 25, limit = 100 } = {}) {
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

export async function fetchJobDetail(jobId) {
  const url = `${BASE}/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;Id=%22${jobId}%22,siteNumber=${SITE_NUMBER}`;
  const data = await fetchJson(url);
  const item = data.items?.[0];
  if (!item) return null;
  const salaryField = (item.requisitionFlexFields || []).find((f) => /salary/i.test(f.Prompt || ''));
  return {
    category: item.Category || null,
    salaryText: salaryField ? salaryField.Value : null,
    postedDate: item.ExternalPostedStartDate ? item.ExternalPostedStartDate.slice(0, 10) : null,
    url: `${SITE_URL}/job/${jobId}`,
  };
}
