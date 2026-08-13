/*
 * Millennium Hotels & Resorts careers scraper.
 *
 * The Bostonian Hotel Boston is managed by Millennium Hotels & Resorts —
 * a management relationship, not a brand one (same pattern as the
 * Aimbridge-managed hotels: an "independent"-labeled/differently-named
 * hotel still posts through a larger operator's own careers site). Runs
 * on Recruitee, a sixth distinct ATS. Its JSON API
 * (careers-usa.millenniumhotels.com/api/v3/...) is public and
 * unauthenticated — plain fetch() works cold; the Cloudflare
 * bot-challenge widget visible elsewhere on the page doesn't appear to
 * guard this endpoint.
 *
 * Search filters by a numeric "department" ID (Recruitee's name for
 * property/location groupings here), not free text — a string value is
 * rejected outright (`"department[0]" must be a number`). The ID has to
 * be resolved via the companion `jobs/filters` endpoint, which lists
 * every department with its name and current open-job count.
 *
 * Pagination exists (a `nextPage` cursor in the response) but no request
 * parameter name for it could be found — every plausible body/query-string
 * guess (`after`, `cursor`, `page`, `offset`, `skip`, etc.) was either
 * rejected by strict schema validation or silently ignored, and the
 * site's own "Show more" button didn't trigger a new request even when
 * clicked via Playwright with `force: true`. Not needed in practice:
 * filtering by department ID returns that single property's full job
 * list in one page regardless of the nationwide total.
 *
 * Pay isn't a structured field on the job detail response — same
 * situation as Omni/Accor/Aimbridge/Hotel AKA's salaried case: a
 * dollar-figure embedded in the free-text `description`. Sampled across
 * a broad set of real postings (not just Bostonian's) to confirm every
 * dollar figure present is genuinely pay-related, with no stray
 * bonus/tip noise to filter out.
 */

const BASE = 'https://careers-usa.millenniumhotels.com';
const ACCOUNT = 'millennium-hotel-and-resorts';

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

/** No consistent unit-word suffix across formats ("/hr" on some, nothing
 * on most, including annual figures) — same magnitude heuristic used for
 * Omni/Accor/Aimbridge: >= $200 implies an annual figure, not hourly. */
export function parsePay(text) {
  if (!text) return null;
  const nums = [...text.matchAll(DOLLAR_RE)].map((m) => parseFloat(m[1].replace(/,/g, '')));
  if (nums.length === 0) return null;
  const payMin = Math.min(...nums);
  const payMax = Math.max(...nums);
  return payMax >= 200 ? { payMin, payMax, payUnit: 'annual' } : { payMin, payMax };
}

/** Resolves a property's exact department name to its numeric department
 * ID, required by the search filter (a string name is rejected outright). */
export async function findDepartmentId(propertyMatch) {
  const res = await fetch(`${BASE}/api/v3/accounts/${ACCOUNT}/jobs/filters`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Millennium filters API ${res.status}`);
  const data = await res.json();
  const match = (data.departments || []).find((d) => propertyMatches(d.name, propertyMatch));
  return match ? match.id : null;
}

export async function scrapeMillenniumDepartment(departmentId) {
  const res = await fetch(`${BASE}/api/v3/accounts/${ACCOUNT}/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query: '', department: [departmentId], location: [], workplace: [], worktype: [] }),
  });
  if (!res.ok) throw new Error(`Millennium jobs API ${res.status}`);
  const data = await res.json();
  return (data.results || []).map((r) => ({
    id: r.shortcode,
    title: r.title,
    propertyName: r.department && r.department[0] ? r.department[0] : null,
    postedDate: r.published ? r.published.slice(0, 10) : null,
  }));
}

/**
 * Visits a job's own detail endpoint to confirm it's still live and to
 * pull pay text. An unknown/removed shortcode 404s outright; a real but
 * unpublished requisition is distinguished via its `state` field
 * (`"published"` observed on live postings).
 */
export async function fetchJobDetail(shortcode) {
  const url = `${BASE}/api/v2/accounts/${ACCOUNT}/jobs/${shortcode}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Millennium job detail API ${res.status}`);
  const item = await res.json();
  if (item.state && item.state !== 'published') return null; // closed/unpublished — drop it (verify-before-including rule)
  const text = [item.description, item.requirements, item.benefits].filter(Boolean).join(' ');
  return {
    pay: parsePay(text),
    url: `${BASE}/_/j/${shortcode}/`,
  };
}
