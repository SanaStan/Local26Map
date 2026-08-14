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
 * No pay field exists anywhere in this API's job data (list or detail)
 * — confirmed by dumping every field on a sample job from both the
 * search response and the separate microsites.dejobs.org detail
 * endpoint. Every job from this source has null pay, same as any other
 * scraper's no-data case (e.g. some Marriott listings).
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
      });
    }
    if (!json.pagination?.has_more_pages) break;
    page += 1;
  }
  return jobs;
}
