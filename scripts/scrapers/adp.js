/*
 * ADP Workforce Now recruitment-widget scraper.
 *
 * The Lenox Hotel embeds an ADP "recruitment-current-openings" web
 * component on its own careers page (lenoxhotel.com/careers) rather
 * than posting through any brand or management-company site. That
 * component is keyed by two IDs pulled from its markup — a `cid`
 * (client ID, identifies the whole ADP account) and a `ccId` (career
 * center ID, identifies this specific widget/job-board view within that
 * account) — and calls a plain public JSON endpoint under those IDs, no
 * browser/JS execution needed to read it.
 *
 * Notable: the same `cid` spans other locations too (a `LOCATION` facet
 * in the response's own `meta.links` lists "Somerville/Cambridge" and
 * "Revere" alongside "Lenox, Boston, MA, US"), meaning this ADP account
 * covers more than just this one hotel — Saunders Hotel Group (Lenox's
 * owner) likely manages properties there too, worth a look for whether
 * any belong on Local 26's list. Each job's own `requisitionLocations`
 * is what's actually used to confirm it belongs to this hotel, same
 * verify-per-job pattern as every other scraper here, rather than
 * trusting the widget's `ccId` scope blindly.
 *
 * Pay unit comes from an explicit `SalaryType` code field (`shortName`
 * "Hourly" observed on every current posting) rather than Hotel AKA's
 * `Salaried` boolean or Highgate/IHG's magnitude-inference heuristic —
 * more reliable when present, so it's authoritative; magnitude is only
 * a fallback if that field is ever missing.
 *
 * The clean per-job URL isn't in the list response (`links` is always
 * empty there) — confirmed by watching a real click in a browser: it
 * opens `.../mdf/recruitment/recruitment.html?cid=...&ccId=...&jobId=
 * {ExternalJobID}&jwId={jobWidget.itemID}`, both pulled from fields
 * already present in the same list response.
 */

const API_BASE = 'https://workforcenow.adp.com/mascsr/default/careercenter/public/events/staffing/v1/job-requisitions';
const DETAIL_BASE = 'https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html';

function findStringField(job, code) {
  return job.customFieldGroup?.stringFields?.find((f) => f.nameCode?.codeValue === code)?.stringValue;
}

function findCodeField(job, code) {
  return job.customFieldGroup?.codeFields?.find((f) => f.nameCode?.codeValue === code);
}

/** SalaryType's shortName ("Hourly") is authoritative when present —
 * magnitude inference (same threshold as highgate.js/ihg.js) is only a
 * fallback for the shape this hasn't been observed to produce. */
export function parsePay(job) {
  const range = job.payGradeRange;
  if (!range) return null;
  const min = range.minimumRate?.amountValue;
  const max = range.maximumRate?.amountValue;
  if (min == null && max == null) return null;
  const payMin = min ?? max;
  const payMax = max ?? min;
  if (payMin === 0 && payMax === 0) return null;
  const salaryType = findCodeField(job, 'SalaryType');
  const isHourly = salaryType ? salaryType.shortName === 'Hourly' : payMax < 200;
  const payUnit = isHourly ? undefined : 'annual';
  return payUnit ? { payMin, payMax, payUnit } : { payMin, payMax };
}

export function jobDetailUrl(cid, ccId, job, jobWidgetItemId) {
  const jobId = findStringField(job, 'ExternalJobID');
  const params = new URLSearchParams({ cid, ccId, lang: 'en_US', jobId: jobId || '', jwId: jobWidgetItemId || '' });
  return `${DETAIL_BASE}?${params.toString()}`;
}

export function locationMatches(locations, locationSubstring) {
  return (locations || []).some((loc) => (loc.nameCode?.shortName || '').includes(locationSubstring));
}

export async function scrapeAdpJobRequisitions(cid, ccId) {
  const url = `${API_BASE}?${new URLSearchParams({ cid, ccId, lang: 'en_US', locale: 'en_US', $top: '100', isWidget: 'true' })}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
  if (!res.ok) throw new Error(`ADP job-requisitions ${res.status}`);
  const json = await res.json();
  const jobWidgetItemId = json.jobWidget?.itemID;
  return (json.jobRequisitions || []).map((job) => ({
    id: findStringField(job, 'ExternalJobID') || job.itemID,
    title: (job.requisitionTitle || '').trim(),
    url: jobDetailUrl(cid, ccId, job, jobWidgetItemId),
    pay: parsePay(job),
    datePosted: job.postDate || null,
    locations: job.requisitionLocations || [],
  }));
}
