/*
 * SmartRecruiters public postings API scraper.
 *
 * Encore Boston Harbor (nominally `brand: "independent"`) is actually
 * Wynn Resorts-managed. Wynn's own careers site (wynnresorts.com/
 * careers/open-roles) funnels all job data through a Next.js Server
 * Action (a POST back to the same page URL, `next-action: <hash>`
 * header) rather than a stable REST endpoint — that hash is tied to a
 * specific build/deployment and would break on Wynn's next redeploy,
 * confirmed by capturing the real browser's network traffic (no
 * separate XHR to any jobs API was ever made). Bypassed entirely:
 * SmartRecruiters (the underlying ATS, confirmed via the site's own
 * "JOIN LAS VEGAS/BOSTON NETWORK" links pointing at
 * join.smartrecruiters.com/WynnResorts/...) exposes its own stable
 * public postings API directly, `api.smartrecruiters.com/v1/companies/
 * {company}/postings`, no auth needed and works from a plain `fetch()`
 * with none of Wynn's frontend involved at all.
 *
 * That API spans Wynn's whole portfolio (Las Vegas, Macau, Boston,
 * etc.) in one un-filterable-by-property call, so results are filtered
 * client-side by `location.region`/`location.city` (Encore Boston
 * Harbor is the only Massachusetts property) — same
 * filter-after-fetch-everything pattern as Highgate. Each job's own
 * `customField` "Company" entry (e.g. "Encore Boston Harbor") gives a
 * second, direct per-job confirmation beyond just location.
 *
 * Pay and the clean postingUrl aren't in the list response — only a
 * per-job detail fetch (`.../postings/{id}`) has `compensation.{min,max,
 * period}` and `postingUrl`, so (like Highgate/Millennium/IHG) each
 * matched job gets a detail fetch to enrich and verify it's still live.
 */

const LIST_BASE = 'https://api.smartrecruiters.com/v1/companies';

export function parsePay(compensation) {
  if (!compensation) return null;
  const { min, max } = compensation;
  if (min == null && max == null) return null;
  // Same "only one side given" fallback as highgate.js/ihg.js — a
  // posting can specify just a floor or a ceiling (e.g. "up to $X").
  const payMin = min ?? max;
  const payMax = max ?? min;
  const payUnit = compensation.period === 'YEARLY' ? 'annual' : undefined;
  return payUnit ? { payMin, payMax, payUnit } : { payMin, payMax };
}

export async function scrapeSmartRecruitersPostings(companyIdentifier) {
  const jobs = [];
  let offset = 0;
  const limit = 200;
  for (;;) {
    const params = new URLSearchParams({ offset: String(offset), limit: String(limit) });
    const res = await fetch(`${LIST_BASE}/${companyIdentifier}/postings?${params}`, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`SmartRecruiters postings ${res.status}`);
    const json = await res.json();
    for (const job of json.content || []) {
      jobs.push({
        id: job.id,
        title: (job.name || '').trim(),
        city: job.location?.city || null,
        region: job.location?.region || null,
        companyField: job.customField?.find((f) => f.fieldLabel === 'Company')?.valueLabel || null,
      });
    }
    offset += (json.content || []).length;
    if (offset >= json.totalFound || !json.content?.length) break;
  }
  return jobs;
}

export async function fetchJobDetail(companyIdentifier, jobId) {
  const res = await fetch(`${LIST_BASE}/${companyIdentifier}/postings/${jobId}`, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
  });
  if (!res.ok) return null; // removed/closed posting
  const json = await res.json();
  return {
    url: json.postingUrl || null,
    pay: parsePay(json.compensation),
    datePosted: json.releasedDate || null,
    category: json.function?.label || null,
  };
}
