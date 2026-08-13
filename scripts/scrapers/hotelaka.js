/*
 * Hotel AKA careers scraper.
 *
 * Hotel AKA (a small boutique/extended-stay chain, ~11 properties
 * nationwide including the two Boston ones on this project's list) runs
 * its own careers site on UKG Pro Recruiting (tenant "SHK1500SHKM") — a
 * fifth distinct ATS platform, no relation to any of the others scraped
 * so far. Its search API (`JobBoardView/LoadSearchResults`) is public
 * and unauthenticated, plain `fetch()` works cold — closer to Hilton's
 * setup than Hyatt's/Accor's. With only ~28 jobs across the entire
 * chain, one unfiltered search page (`Top: 50`) covers every property at
 * once; no per-city/radius search needed.
 *
 * Pay isn't in the search results, only on each job's own detail page —
 * and that page isn't a JSON API either, it's a server-rendered HTML
 * page with the full job data embedded as a single minified JS object
 * literal (`var opportunity = new US.Opportunity.CandidateOpportunityDetail({...})`).
 * Since it's genuinely present in the raw HTML (not client-fetched
 * after load), a plain `fetch()` + regex/brace-matching extraction
 * works — no browser needed. Two separate pay shapes depending on
 * `Salaried`: hourly roles carry a single rate in `CompensationAmount`,
 * salaried roles carry a real min/max in `PayRange` — never both.
 */

const BASE = 'https://shkmngt.rec.pro.ukg.net/SHK1500SHKM/JobBoard/635285d1-2897-495a-b0bc-2b2c63e45d20';
const DETAIL_MARKER = 'US.Opportunity.CandidateOpportunityDetail(';

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

/** `detail` is the parsed CandidateOpportunityDetail object. Hourly and
 * salaried postings use entirely different fields, never both. */
export function parsePay(detail) {
  if (detail.Salaried) {
    const min = detail.PayRange?.PayRangeMinimum;
    const max = detail.PayRange?.PayRangeMaximum;
    if (min == null && max == null) return null;
    const payMin = parseFloat(min ?? max);
    const payMax = parseFloat(max ?? min);
    if (Number.isNaN(payMin) || Number.isNaN(payMax)) return null;
    return { payMin, payMax, payUnit: 'annual' };
  }
  const val = detail.CompensationAmount?.Value;
  if (val == null) return null;
  const payMin = parseFloat(val);
  if (Number.isNaN(payMin)) return null;
  return { payMin, payMax: payMin };
}

/** Every observed job's JobCategoryName is the literal placeholder
 * "All", not a real per-job category — treated as absent. */
export async function scrapeAkaJobs() {
  const body = {
    opportunitySearch: {
      Top: 50,
      Skip: 0,
      QueryString: '',
      OrderBy: [{ Value: 'postedDateDesc', PropertyName: 'PostedDate', Ascending: false }],
      Filters: [
        { t: 'TermsSearchFilterDto', fieldName: 4, extra: null, values: [] },
        { t: 'TermsSearchFilterDto', fieldName: 5, extra: null, values: [] },
        { t: 'TermsSearchFilterDto', fieldName: 6, extra: null, values: [] },
        { t: 'TermsSearchFilterDto', fieldName: 37, extra: null, values: [] },
      ],
    },
    matchCriteria: { PreferredJobs: [], Educations: [], LicenseAndCertifications: [], Skills: [], hasNoLicenses: false, SkippedSkills: [] },
  };
  const res = await fetch(`${BASE}/JobBoardView/LoadSearchResults`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Hotel AKA API ${res.status}`);
  const data = await res.json();
  return (data.opportunities || []).map((o) => ({
    id: o.Id,
    title: o.Title,
    propertyName: o.Locations?.[0]?.LocalizedName || null,
    postedDate: o.PostedDate ? o.PostedDate.slice(0, 10) : null,
  }));
}

/** Extracts a balanced `{...}` JSON object starting at `text[openIndex]`
 * (which must be `{`), respecting quoted strings so a stray `}` or `);`
 * inside a job description's free text can't truncate it early — this
 * data is embedded in a JS statement, not returned as clean JSON, so a
 * naive regex isn't safe here. */
function extractBalancedJson(text, openIndex) {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(openIndex, i + 1);
    }
  }
  return null;
}

/**
 * Visits a job's own detail page to confirm it's still live and to pull
 * pay — a removed/invalid posting still returns HTTP 200, just without
 * the embedded data object at all (checked here) or with
 * `OpportunityIsClosed: true` (a real but closed requisition).
 */
export async function fetchJobDetail(jobId) {
  const url = `${BASE}/OpportunityDetail?opportunityId=${jobId}`;
  const res = await fetch(url, { headers: { Accept: 'text/html' } });
  if (!res.ok) return null;
  const html = await res.text();
  const markerIdx = html.indexOf(DETAIL_MARKER);
  if (markerIdx === -1) return null;
  const openIdx = markerIdx + DETAIL_MARKER.length;
  const jsonStr = extractBalancedJson(html, openIdx);
  if (!jsonStr) return null;
  let detail;
  try {
    detail = JSON.parse(jsonStr);
  } catch {
    return null;
  }
  if (detail.OpportunityIsClosed) return null;
  return { pay: parsePay(detail), url };
}
