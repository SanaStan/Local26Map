/*
 * Highgate Hotels careers scraper.
 *
 * Highgate is a third-party hotel management company (not a brand) —
 * some nominally "independent" hotels on this project's list are
 * actually Highgate-managed and post jobs through Highgate's own
 * careers site rather than any brand's (or, in Hilton Boston Back Bay's
 * case, *in addition to* a brand site that's gone quiet — see below).
 *
 * Highgate's careers site runs on iCIMS, but unlike Hilton/IHG's Oracle
 * Recruiting Cloud instances there's no public JSON API here — this is a
 * classic server-rendered iCIMS "career portal" embedded via iframe.
 * Earlier attempts against `externalhourly-highgate.icims.com/jobs/intro`
 * with keyword query params found nothing (see README); the working path
 * turned out to be `careershub-highgate.icims.com/jobs/search` with a
 * `searchLocation` facet value copied from the site's own location
 * dropdown, plus `in_iframe=1` to get the bare results fragment instead
 * of the full page chrome. That single query returns every open
 * Highgate posting within the "Boston" location facet — across all of
 * Highgate's Boston-area properties, not just the ones on this list —
 * so results are filtered client-side by property name like every other
 * brand here. No Playwright needed, plain `fetch()` works cold.
 *
 * Notable: Hilton Boston Back Bay's postings currently show up here even
 * though it's scraped as a Hilton brand property — its own Hilton
 * careers site has been returning zero jobs for it (see scrape-report.json
 * history) while real postings are on Highgate's site instead. Same
 * pattern as the Westin Boston Seaport/Aimbridge discovery: a
 * brand-flagged hotel whose brand site went quiet while its management
 * company kept posting.
 *
 * Job cards in search results don't carry pay — only each job's own
 * detail page does, via a `<script type="application/ld+json">` schema.org
 * JobPosting block embedded directly in the server-rendered HTML (no
 * client-side fetch needed). That block's `baseSalary` has no unit field
 * (its own UI mislabels every rate "/Yr." even for hourly roles), so pay
 * unit is inferred from magnitude, same heuristic as ihg.js. The block's
 * own `url` field is the clean canonical job URL (no `hub`/`in_iframe`
 * tracking params) and `hiringOrganization.name` is the property name,
 * both used to enrich/verify below. A removed/closed posting 410s
 * outright rather than rendering a still-200 "closed" page.
 */

const SEARCH_BASE = 'https://careershub-highgate.icims.com/jobs/search';

/** Location facet value for "Boston" lifted from Highgate's own search
 * page — opaque iCIMS internal ID, not a computable zip/radius param
 * (same class of "just hardcode it" facet as Aimbridge's Place ID). */
export const BOSTON_SEARCH_LOCATION = '12781-12805-Boston';

const ENTITY_MAP = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ', rsquo: '’', mdash: '—', ndash: '–' };

export function decodeEntities(s) {
  if (!s) return s;
  return s.replace(/&(#39|amp|lt|gt|quot|nbsp|rsquo|mdash|ndash);/g, (_, e) => ENTITY_MAP[e]);
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

/** Pay has no unit field in the source data at all — magnitude alone
 * decides, same heuristic as scripts/scrapers/ihg.js. */
export function parsePay(baseSalary) {
  if (!baseSalary) return null;
  const min = baseSalary.minValue;
  const max = baseSalary.maxValue;
  if (min == null && max == null) return null;
  const payMin = parseFloat(min ?? max);
  const payMax = parseFloat(max ?? min);
  if (Number.isNaN(payMin) || Number.isNaN(payMax)) return null;
  const payUnit = payMax >= 200 ? 'annual' : undefined;
  return payUnit ? { payMin, payMax, payUnit } : { payMin, payMax };
}

async function fetchSearchPage(searchLocation, pageIndex) {
  const params = pageIndex === 0 ? `ss=1&searchLocation=${encodeURIComponent(searchLocation)}&in_iframe=1` : `pr=${pageIndex}&in_iframe=1&searchLocation=${encodeURIComponent(searchLocation)}`;
  const res = await fetch(`${SEARCH_BASE}?${params}`, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' } });
  if (!res.ok) throw new Error(`Highgate search ${res.status}`);
  return res.text();
}

const CARD_RE = /<li class="iCIMS_JobCardItem">([\s\S]*?)<\/li>\s*(?=<li class="iCIMS_JobCardItem">|<\/ul>)/g;
const PAGE_COUNT_RE = /Page\s+(\d+)\s+of\s+(\d+)/;

function parseSearchPage(html) {
  const jobs = [];
  for (const cardMatch of html.matchAll(CARD_RE)) {
    const card = cardMatch[1];
    const hrefMatch = card.match(/<a href="([^"]+)" class="iCIMS_Anchor"/);
    const titleMatch = card.match(/<h3[^>]*>\s*([\s\S]*?)<\/h3>/);
    const fieldValues = [...card.matchAll(/<dd class="iCIMS_JobHeaderData"><span >\s*([^<]*)<\/span>/g)].map((m) => decodeEntities(m[1].trim()));
    if (!hrefMatch) continue;
    const url = decodeEntities(hrefMatch[1]);
    const idMatch = url.match(/\/jobs\/(\d+)\//);
    jobs.push({
      url,
      id: idMatch ? idMatch[1] : null,
      title: titleMatch ? decodeEntities(titleMatch[1].trim()) : null,
      // Field order per card is fixed: Requisition ID, Property, Job Location.
      propertyName: fieldValues[1] || null,
    });
  }
  const pageCount = html.match(PAGE_COUNT_RE);
  return { jobs, currentPage: pageCount ? parseInt(pageCount[1], 10) : 1, totalPages: pageCount ? parseInt(pageCount[2], 10) : 1 };
}

export async function scrapeHighgateLocation(searchLocation = BOSTON_SEARCH_LOCATION) {
  const jobs = [];
  const seen = new Set();
  let pageIndex = 0;
  for (;;) {
    const html = await fetchSearchPage(searchLocation, pageIndex);
    const { jobs: pageJobs, currentPage, totalPages } = parseSearchPage(html);
    for (const j of pageJobs) {
      if (!seen.has(j.url)) {
        seen.add(j.url);
        jobs.push(j);
      }
    }
    if (pageJobs.length === 0 || currentPage >= totalPages) break;
    pageIndex++;
  }
  return jobs;
}

const LD_JSON_RE = /<script type="application\/ld\+json">(\{[\s\S]*?\})<\/script>/;

export async function fetchJobDetail(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' } });
  if (!res.ok) return null; // 410 for a removed/closed posting
  const html = await res.text();
  const m = html.match(LD_JSON_RE);
  if (!m) return null;
  let posting;
  try {
    posting = JSON.parse(m[1]);
  } catch {
    return null;
  }
  return {
    url: posting.url || url,
    propertyName: posting.hiringOrganization?.name || null,
    pay: parsePay(posting.baseSalary),
    category: posting.occupationalCategory || null,
    datePosted: posting.datePosted || null,
  };
}
