/*
 * Paycom ATS careers-portal scraper.
 *
 * Courtyard by Marriott Downtown/North Station (nominally `brand:
 * "marriott"`, previously only found on third-party boards, not
 * careers.marriott.com) runs its own dedicated Paycom career portal
 * instead — confirmed via the portal's own `company-name` API
 * returning the hotel's exact name, and via the job posting's own
 * description text ("Promote Fontainebleau Development and Courtyard
 * marketing programs") plus independent web research: the hotel is
 * owned/operated by Fontainebleau Development (with Related Beal as
 * co-developer).
 *
 * The portal page (`paycomonline.net/v4/ats/web.php/portal/{portalId}/
 * career-page`) is client-rendered, but — like Hireology — it embeds a
 * short-lived signed JWT directly in the initial server-rendered HTML
 * (`var configsFromHost = {"sessionJWT":"..."}`, no JS execution
 * needed to read it) that the app sends as a plain `Authorization`
 * header (no `Bearer ` prefix, unlike most JWT-bearer APIs) to the
 * actual data API, `portal-applicant-tracking.us-cent.paycomonline.net`.
 * That token has to be scraped fresh off the HTML page before each API
 * call, but no browser is needed for either step, plain `fetch()`
 * works for both.
 *
 * The list endpoint (`job-posting-previews/search`, POST) returns
 * title/location/truncated-description but no pay or clean per-job
 * URL — those come from a per-job detail fetch
 * (`job-postings/{jobId}`, GET), which also gives the pay as freeform
 * text (`"$33.98 - $33.98 Hourly"`) rather than a structured field —
 * same shape as Marriott's own pay text, parsed the same way. No
 * category field has been populated on any job seen so far
 * (`jobCategory: ""`).
 */

const API_BASE = 'https://portal-applicant-tracking.us-cent.paycomonline.net/api/ats';

function portalBase(portalId) {
  return `https://www.paycomonline.net/v4/ats/web.php/portal/${portalId}`;
}

const PAY_HOURLY_RE = /\$([\d,]+\.?\d*)\s*-\s*\$([\d,]+\.?\d*)\s*Hourly/i;
const PAY_ANNUAL_RE = /\$([\d,]+\.?\d*)\s*-\s*\$([\d,]+\.?\d*)\s*(?:Annually|Yearly|Salary)/i;

export function parsePay(salaryRangeText) {
  if (!salaryRangeText) return null;
  let m = salaryRangeText.match(PAY_HOURLY_RE);
  if (m) return { payMin: parseFloat(m[1].replace(/,/g, '')), payMax: parseFloat(m[2].replace(/,/g, '')) };
  m = salaryRangeText.match(PAY_ANNUAL_RE);
  if (m) return { payMin: parseFloat(m[1].replace(/,/g, '')), payMax: parseFloat(m[2].replace(/,/g, '')), payUnit: 'annual' };
  return null;
}

async function fetchSessionJWT(portalId) {
  const res = await fetch(`${portalBase(portalId)}/career-page`, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' } });
  if (!res.ok) throw new Error(`Paycom career page ${res.status}`);
  const html = await res.text();
  const m = html.match(/"sessionJWT":"([^"]+)"/);
  if (!m) throw new Error('Paycom sessionJWT not found in career page HTML');
  return m[1];
}

export async function scrapePaycomJobs(portalId) {
  const token = await fetchSessionJWT(portalId);
  const headers = { Authorization: token, Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' };
  const res = await fetch(`${API_BASE}/job-posting-previews/search`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      skip: 0,
      take: 100,
      filtersForQuery: { distanceFrom: 0, workEnvironments: [], positionTypes: [], educationLevels: [], categories: [], travelTypes: [], shiftTypes: [], otherFilters: [], keywordSearchText: '', location: '', sortOption: '' },
    }),
  });
  if (!res.ok) throw new Error(`Paycom job search ${res.status}`);
  const json = await res.json();
  const jobs = [];
  for (const preview of json.jobPostingPreviews || []) {
    const detailRes = await fetch(`${API_BASE}/job-postings/${preview.jobId}`, { headers });
    if (!detailRes.ok) continue; // removed/closed posting — drop it (verify-before-including rule)
    const detail = (await detailRes.json()).jobPosting;
    jobs.push({
      id: String(preview.jobId),
      title: (preview.jobTitle || '').trim(),
      url: `${portalBase(portalId)}/jobs/${preview.jobId}`,
      pay: parsePay(detail.salaryRange),
      category: detail.jobCategory || null,
      locations: preview.locations,
    });
  }
  return jobs;
}
