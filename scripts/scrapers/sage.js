/*
 * Sage Hospitality Group careers-site scraper.
 *
 * Sage Hospitality Group is a real hotel management company (like
 * Highgate/Aimbridge/Millennium), not just an ATS vendor — Hotel
 * Commonwealth (nominally `brand: "independent"`) is actually
 * Sage-managed and posts through Sage's own careers site,
 * sagehospitality.jobs, which spans ~70 properties nationwide. Only
 * this one Boston-area hotel matched on this project's list so far
 * (confirmed by checking every property name in the site's own
 * per-property Solr filter list) — same "verify against every
 * property, not just the one you're looking for" caution as the
 * Highgate/Aimbridge searches.
 *
 * The site itself is a Nuxt (Vue) SPA with no jobs in the initial HTML.
 * It calls a public Solr-backed search API,
 * `prod-search-api.jobsyn.org/api/v1/solr/search`, filtered by a
 * `property2` slug (e.g. `hotel-commonwealth`) that maps server-side to
 * an exact-phrase Solr query against the job's own text (confirmed via
 * the site's own per-property filter config, which literally spells out
 * `text:"Hotel Commonwealth"` for this slug) — same per-property
 * exact-phrase confirmation as Highgate/Millennium's own filtering, just
 * server-side instead of client-side. That API call requires a custom
 * `x-origin` header (the bare site hostname, e.g. `sagehospitality.jobs`)
 * — a plain `Origin`/`Referer` header pair 403s with "Mismatched
 * origin," but no cookies/session/browser JS execution is needed
 * otherwise, plain `fetch()` works once that header is set.
 *
 * Fixed 2026-08-14: there's no *structured* pay field on the job object
 * (list or detail), which is as far as the original build of this
 * scraper checked — but pay, category, and the property name are all
 * embedded as literal markdown text inside the job's own `description`
 * field (`**Min:** _USD $80,000.00/Yr._`, `**Max:** _USD $100,000.00/Yr._`,
 * `**Category:** _Front Desk & Guest Services_`, `**Property** **:**
 * _Hotel Commonwealth_`), confirmed present on every job checked. The
 * `/Yr.`/`/Hr.` unit suffix is occasionally wrong (observed:
 * "USD $75,000.00 - USD $85,000.00 /Hr." for a Senior Catering Sales
 * Manager role, obviously an annual salary) — same "label sometimes
 * lies, magnitude decides" heuristic as highgate.js/ihg.js/adp.js, not
 * the suffix text.
 *
 * The clean per-job URL isn't in the API response either (no `url`/
 * `link` field pointing at sagehospitality.jobs itself — the API's own
 * `link` field points at a `de.jobsyn.org` redirector instead, less
 * clean for direct linking) — found by watching real navigation in a
 * browser: `sagehospitality.jobs/{city-slug}-{state_short-slug}/
 * {title_slug}/{guid}/job/`, all fields already present in the same
 * search response.
 */

const SEARCH_BASE = 'https://prod-search-api.jobsyn.org/api/v1/solr/search';
const SITE_HOST = 'sagehospitality.jobs';

function slugify(s) {
  return (s || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function jobDetailUrl(job) {
  const citySlug = `${slugify(job.city_exact)}-${slugify(job.state_short)}`;
  return `https://${SITE_HOST}/${citySlug}/${job.title_slug}/${job.guid}/job/`;
}

/** Pay is embedded as markdown text in the job's own `description`
 * field, not a structured field — see module docs. Magnitude, not the
 * `/Yr.`/`/Hr.` suffix, decides payUnit (same heuristic used elsewhere
 * in this project) since that suffix has been observed wrong. */
export function parsePay(description) {
  if (!description) return null;
  const min = description.match(/\*\*Min:\*\*\s*_USD \$([\d,]+\.\d{2})/);
  const max = description.match(/\*\*Max:\*\*\s*_USD \$([\d,]+\.\d{2})/);
  if (!min && !max) return null;
  const minVal = min ? parseFloat(min[1].replace(/,/g, '')) : null;
  const maxVal = max ? parseFloat(max[1].replace(/,/g, '')) : null;
  const payMin = minVal ?? maxVal;
  const payMax = maxVal ?? minVal;
  const payUnit = payMax >= 200 ? 'annual' : undefined;
  return payUnit ? { payMin, payMax, payUnit } : { payMin, payMax };
}

export function parseCategory(description) {
  if (!description) return null;
  const m = description.match(/\*\*Category:\*\*\s*_([^_]+)_/);
  return m ? m[1].trim() : null;
}

/** Second, independent per-job property confirmation beyond the
 * server-side property2 filter — same "verify per job, not just per
 * search" caution used throughout this project. */
export function parsePropertyName(description) {
  if (!description) return null;
  const m = description.match(/\*\*Property\*\*\s*\*\*:\*\*\s*_([^_]+)_/);
  return m ? m[1].trim() : null;
}

export async function scrapeSageProperty(propertySlug) {
  const jobs = [];
  let page = 1;
  for (;;) {
    const params = new URLSearchParams({ page: String(page), property2: propertySlug, num_items: '50' });
    const res = await fetch(`${SEARCH_BASE}?${params}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Accept: 'application/json',
        'x-origin': SITE_HOST,
        Referer: `https://${SITE_HOST}/`,
      },
    });
    if (!res.ok) throw new Error(`Sage/jobsyn search ${res.status}`);
    const json = await res.json();
    for (const job of json.jobs || []) {
      jobs.push({
        id: job.guid,
        title: (job.title_exact || '').trim(),
        url: jobDetailUrl(job),
        datePosted: job.date_new || job.date_added || null,
        pay: parsePay(job.description),
        category: parseCategory(job.description),
        propertyName: parsePropertyName(job.description),
      });
    }
    if (!json.pagination?.has_more_pages) break;
    page += 1;
  }
  return jobs;
}
