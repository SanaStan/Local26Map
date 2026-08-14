/*
 * Orchestrator: scrapes every configured brand source, diffs the result
 * against the last-known data.json, writes the updated data.json, and
 * appends today's observations (and any closures) to history.jsonl.
 *
 * Guardrail: if a brand's scrape comes back completely empty while the
 * previous run had jobs for that brand, treat it as a broken scraper
 * (selector drift, site redesign, bot-block) rather than "hiring stopped
 * everywhere overnight" — abort without touching data.json/history.jsonl
 * so a bad run can't quietly erase real data.
 */
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  scrapeMarriottLocation,
  fetchJobDetail as fetchMarriottJobDetail,
  parsePay as parseMarriottPay,
  propertyMatches as marriottPropertyMatches,
} from './scrapers/marriott.js';
import {
  geocodeLocationId,
  scrapeHiltonLocation,
  fetchJobDetail as fetchHiltonJobDetail,
  parsePay as parseHiltonPay,
  propertyMatches as hiltonPropertyMatches,
} from './scrapers/hilton.js';
import { scrapeHyattProperty, verifyJobLive as verifyHyattJobLive, parsePay as parseHyattPay } from './scrapers/hyatt.js';
import {
  geocodeLocations,
  scrapeOmniLocation,
  verifyJobLive as verifyOmniJobLive,
  parsePay as parseOmniPay,
  propertyMatches as omniPropertyMatches,
} from './scrapers/omni.js';
import { scrapeAccorProperty, verifyJobLive as verifyAccorJobLive } from './scrapers/accor.js';
import {
  BOSTON_PLACE_ID,
  scrapeAimbridgeLocation,
  verifyJobLive as verifyAimbridgeJobLive,
  parsePay as parseAimbridgePay,
  propertyMatches as aimbridgePropertyMatches,
} from './scrapers/aimbridge.js';
import {
  geocodeLocationId as geocodeIhgLocationId,
  scrapeIhgLocation,
  fetchJobDetail as fetchIhgJobDetail,
  parsePay as parseIhgPay,
  propertyMatches as ihgPropertyMatches,
} from './scrapers/ihg.js';
import {
  scrapeAkaJobs,
  fetchJobDetail as fetchAkaJobDetail,
  propertyMatches as akaPropertyMatches,
} from './scrapers/hotelaka.js';
import {
  findDepartmentId as findMillenniumDepartmentId,
  scrapeMillenniumDepartment,
  fetchJobDetail as fetchMillenniumJobDetail,
  propertyMatches as millenniumPropertyMatches,
} from './scrapers/millennium.js';
import {
  BOSTON_SEARCH_LOCATION as HIGHGATE_BOSTON_SEARCH_LOCATION,
  CAMBRIDGE_SEARCH_LOCATION as HIGHGATE_CAMBRIDGE_SEARCH_LOCATION,
  scrapeHighgateLocation,
  fetchJobDetail as fetchHighgateJobDetail,
  propertyMatches as highgatePropertyMatches,
} from './scrapers/highgate.js';
import { scrapeHireologyCareers } from './scrapers/hireology.js';
import { scrapeAdpJobRequisitions, locationMatches as adpLocationMatches, postalCodeMatches as adpPostalCodeMatches } from './scrapers/adp.js';
import { scrapeSageProperty } from './scrapers/sage.js';
import { scrapeSmartRecruitersPostings, fetchJobDetail as fetchSmartRecruitersJobDetail } from './scrapers/smartrecruiters.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA_PATH = path.join(ROOT, 'data.json');
const HISTORY_PATH = path.join(ROOT, 'history.jsonl');
const REPORT_PATH = path.join(ROOT, 'scrape-report.json');

const today = new Date().toISOString().slice(0, 10);

function jobKey(job) {
  return job.url;
}

async function scrapeMarriottBrand(page, hotels) {
  // Search once per distinct city already in our hotel list, rather than
  // per-hotel, since one location search returns every nearby property.
  const cities = [...new Set(hotels.map((h) => `${h.city}, MA, USA`))];
  const allRaw = [];
  const seen = new Set();
  for (const cityQuery of cities) {
    const jobs = await scrapeMarriottLocation(page, cityQuery);
    for (const j of jobs) {
      if (j.url && !seen.has(j.url)) {
        seen.add(j.url);
        allRaw.push(j);
      }
    }
  }

  // Verify + enrich each job that matches one of our tracked properties.
  // (Jobs at nearby Marriott properties not on the Local 26 list are
  // discarded here — we only enrich what we're actually going to keep.)
  const byHotel = new Map();
  for (const hotel of hotels) {
    const matches = allRaw.filter((j) => marriottPropertyMatches(j.propertyName, hotel.scrape.propertyMatch));
    const enriched = [];
    for (const m of matches) {
      const pay = parseMarriottPay(m.payText);
      const detail = await fetchMarriottJobDetail(page, m.url);
      if (detail === null) continue; // 404'd or errored on direct visit — drop it (verify-before-including rule)
      enriched.push({
        title: m.title,
        url: m.url,
        jobId: m.jobId,
        payMin: pay ? pay.payMin : null,
        payMax: pay ? pay.payMax : null,
        payUnit: pay && pay.payUnit ? pay.payUnit : undefined,
        datePosted: detail.datePosted || null,
      });
    }
    byHotel.set(hotel.name, enriched);
  }
  return byHotel;
}

/**
 * Hilton's careers site is a plain public REST API (no browser/bot-check
 * needed — see scripts/scrapers/hilton.js), so unlike Marriott this takes
 * no Playwright `page`. Searches once per distinct city in the hotel list,
 * radius-limited to 25mi, then verifies + enriches (pay, category) every
 * job that matches one of our tracked properties.
 */
async function scrapeHiltonBrand(hotels) {
  const cities = [...new Set(hotels.map((h) => h.city))];
  const allRaw = [];
  const seen = new Set();
  for (const city of cities) {
    const locationId = await geocodeLocationId(city, 'MA');
    if (!locationId) continue;
    const jobs = await scrapeHiltonLocation(locationId, { radius: 25 });
    for (const j of jobs) {
      if (j.id && !seen.has(j.id)) {
        seen.add(j.id);
        allRaw.push(j);
      }
    }
  }

  const byHotel = new Map();
  for (const hotel of hotels) {
    const matches = allRaw.filter((j) => hiltonPropertyMatches(j.propertyName, hotel.scrape.propertyMatch));
    const enriched = [];
    for (const m of matches) {
      const detail = await fetchHiltonJobDetail(m.id);
      if (detail === null) continue; // requisition no longer exists — drop it (verify-before-including rule)
      const pay = parseHiltonPay(detail.salaryText);
      enriched.push({
        title: m.title,
        url: detail.url,
        jobId: m.id,
        payMin: pay ? pay.payMin : null,
        payMax: pay ? pay.payMax : null,
        payUnit: pay && pay.payUnit ? pay.payUnit : undefined,
        datePosted: detail.postedDate || m.postedDate || null,
        category: detail.category || null,
      });
    }
    byHotel.set(hotel.name, enriched);
  }
  return byHotel;
}

/**
 * Hyatt's search API 500s unless driven by real UI interaction (see
 * scripts/scrapers/hyatt.js), so this searches once per property directly
 * — a property's exact name doubles as the search term and the org-facet
 * filter it resolves to, rather than a separate city/radius search like
 * Marriott and Hilton.
 */
async function scrapeHyattBrand(page, hotels) {
  // First pass: collect every property's raw search hits. Each property's
  // organization filter is encoded into the page's URL (`?searchable=[...]`)
  // when its suggestion is clicked, and a second search on the same page
  // *adds* to that array rather than replacing it — so a fresh page.goto
  // back to the bare search URL before every property is what actually
  // gives each one an isolated, correct search rather than an accumulating
  // OR of every property searched so far. Verifying job details below
  // navigates the page away too, so it has to happen in a separate pass
  // after all searches are done.
  // domcontentloaded, not networkidle: this page's continuous background
  // analytics/tracking traffic can prevent networkidle from ever settling
  // (observed 45s timeouts) — safe to drop since scrapeHyattProperty's own
  // click/waitForFunction-based interactions already wait for the specific
  // page state they need, not for the page's load event.
  const rawByHotel = new Map();
  for (const hotel of hotels) {
    await page.goto('https://careers.hyatt.com/en-us/careers/search', { waitUntil: 'domcontentloaded', timeout: 45000 });
    const propertyName = Array.isArray(hotel.scrape.propertyMatch) ? hotel.scrape.propertyMatch[0] : hotel.scrape.propertyMatch;
    rawByHotel.set(hotel.name, await scrapeHyattProperty(page, propertyName));
  }

  const byHotel = new Map();
  for (const hotel of hotels) {
    const enriched = [];
    for (const r of rawByHotel.get(hotel.name) || []) {
      const detail = await verifyHyattJobLive(page, r.contestNo);
      if (detail === null) continue; // closed/removed requisition — drop it (verify-before-including rule)
      const pay = parseHyattPay(r.title);
      enriched.push({
        title: r.title,
        url: detail.url,
        jobId: r.contestNo,
        payMin: pay ? pay.payMin : null,
        payMax: pay ? pay.payMax : null,
        payUnit: pay && pay.payUnit ? pay.payUnit : undefined,
        datePosted: r.postedDate,
        category: r.category,
      });
    }
    byHotel.set(hotel.name, enriched);
  }
  return byHotel;
}

/**
 * Omni's Dayforce API needs Playwright's request client (see
 * scripts/scrapers/omni.js) but not a rendered page, so this takes a
 * browser `request` context rather than a `page`. Searches once per
 * distinct city (a 15mi radius from any one property in a metro area
 * covers every other tracked property there too, same as Hilton).
 */
async function scrapeOmniBrand(request, hotels) {
  const cities = [...new Set(hotels.map((h) => h.city))];
  const allRaw = [];
  const seen = new Set();
  for (const city of cities) {
    const locations = await geocodeLocations(request, city);
    if (!locations.length) continue;
    const jobs = await scrapeOmniLocation(request, { locationId: locations[0].locationId, locationString: locations[0].formattedAddress });
    for (const j of jobs) {
      if (j.id && !seen.has(j.id)) {
        seen.add(j.id);
        allRaw.push(j);
      }
    }
  }

  const byHotel = new Map();
  for (const hotel of hotels) {
    const matches = allRaw.filter((j) => omniPropertyMatches(j.propertyName, hotel.scrape.propertyMatch));
    const enriched = [];
    for (const m of matches) {
      // The Dayforce job-detail endpoint has been observed to intermittently
      // hang past even a generous timeout in this specific request pattern
      // (fast headers, slow/stalled body) — one retry before giving up on
      // this single job, rather than letting a transient network hiccup
      // crash the entire multi-brand run.
      let detail;
      try {
        detail = await verifyOmniJobLive(request, m.id);
      } catch {
        try {
          detail = await verifyOmniJobLive(request, m.id);
        } catch (err) {
          console.error(`Omni: giving up verifying job ${m.id} after retry (${err.message})`);
          continue;
        }
      }
      if (detail === null) continue; // closed/removed requisition — drop it (verify-before-including rule)
      const pay = parseOmniPay(m.description);
      enriched.push({
        title: m.title,
        url: detail.url,
        jobId: String(m.id),
        payMin: pay ? pay.payMin : null,
        payMax: pay ? pay.payMax : null,
        payUnit: pay && pay.payUnit ? pay.payUnit : undefined,
        datePosted: m.postedDate,
      });
    }
    byHotel.set(hotel.name, enriched);
  }
  return byHotel;
}

/**
 * Accor's search results only render via full client-side JS hydration
 * (see scripts/scrapers/accor.js), so this drives a real page like
 * Marriott/Hyatt. Searches once per property directly by name (the
 * keyword search doubles as the filter, like Hyatt) rather than a
 * city/radius search.
 */
async function scrapeAccorBrand(page, hotels) {
  const byHotel = new Map();
  for (const hotel of hotels) {
    const propertyName = Array.isArray(hotel.scrape.propertyMatch) ? hotel.scrape.propertyMatch[0] : hotel.scrape.propertyMatch;
    const raw = await scrapeAccorProperty(page, propertyName);
    const enriched = [];
    for (const r of raw) {
      const detail = await verifyAccorJobLive(page, r.url);
      if (detail === null) continue; // closed/removed posting — drop it (verify-before-including rule)
      const pay = detail.pay;
      enriched.push({
        title: r.title,
        url: detail.url,
        jobId: r.id,
        payMin: pay ? pay.payMin : null,
        payMax: pay ? pay.payMax : null,
        payUnit: pay && pay.payUnit ? pay.payUnit : undefined,
        category: r.category,
      });
    }
    byHotel.set(hotel.name, enriched);
  }
  return byHotel;
}

/**
 * Aimbridge is a third-party hotel management company, not a brand — a
 * handful of hotels on this project's list nominally tagged
 * `brand: "independent"` are actually Aimbridge-managed and post jobs
 * through Aimbridge's own careers site instead. Its API is plain
 * unauthenticated fetch() (see scripts/scrapers/aimbridge.js), so — like
 * Hilton — this takes no browser/request client at all. As of this
 * writing no hotel on the list has a `scrape.source: "aimbridge"` entry
 * yet (none of the suspected Aimbridge-managed hotels currently has a
 * live posting to confirm its exact Aimbridge property name against —
 * see README), so `hotels` here is normally empty and this is a no-op;
 * it's wired in now so a hotel just needs a scrape config added once a
 * posting appears to confirm against.
 */
async function scrapeAimbridgeBrand(hotels) {
  const allRaw = await scrapeAimbridgeLocation(BOSTON_PLACE_ID);

  const byHotel = new Map();
  for (const hotel of hotels) {
    const matches = allRaw.filter((j) => aimbridgePropertyMatches(j.propertyName, hotel.scrape.propertyMatch));
    const enriched = [];
    for (const m of matches) {
      const detail = await verifyAimbridgeJobLive(m.applyUrl);
      if (detail === null) continue; // closed/removed posting — drop it (verify-before-including rule)
      const pay = parseAimbridgePay(m.payRate);
      enriched.push({
        title: m.title,
        url: detail.url,
        jobId: m.id,
        payMin: pay ? pay.payMin : null,
        payMax: pay ? pay.payMax : null,
        payUnit: pay && pay.payUnit ? pay.payUnit : undefined,
      });
    }
    byHotel.set(hotel.name, enriched);
  }
  return byHotel;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * IHG runs on the same Oracle Recruiting Cloud platform as Hilton (see
 * scripts/scrapers/ihg.js), so this mirrors scrapeHiltonBrand closely —
 * plain fetch(), no browser needed. The one extra step: IHG job titles
 * carry a redundant "- {Hotel Name}" suffix (inconsistent hyphen
 * spacing), stripped here using each hotel's own data.json display name
 * since the scraper module has no clean "public name" field to strip
 * against (only the internal work-location code, e.g. "IC - Boston
 * (BOSHA)", which doesn't match what's embedded in the title).
 */
async function scrapeIhgBrand(hotels) {
  const cities = [...new Set(hotels.map((h) => `${h.city}`))];
  const allRaw = [];
  const seen = new Set();
  for (const city of cities) {
    const locationId = await geocodeIhgLocationId(city, 'MA');
    if (!locationId) continue;
    const jobs = await scrapeIhgLocation(locationId, { radius: 25 });
    for (const j of jobs) {
      if (j.id && !seen.has(j.id)) {
        seen.add(j.id);
        allRaw.push(j);
      }
    }
  }

  const byHotel = new Map();
  for (const hotel of hotels) {
    const matches = allRaw.filter((j) => ihgPropertyMatches(j.propertyName, hotel.scrape.propertyMatch));
    const titleSuffixRe = new RegExp(`\\s*-\\s*${escapeRegExp(hotel.name)}\\s*$`, 'i');
    const enriched = [];
    for (const m of matches) {
      const detail = await fetchIhgJobDetail(m.id);
      if (detail === null) continue; // requisition no longer exists — drop it (verify-before-including rule)
      const pay = parseIhgPay(detail.salaryText);
      enriched.push({
        title: m.title.replace(titleSuffixRe, '').trim(),
        url: detail.url,
        jobId: m.id,
        payMin: pay ? pay.payMin : null,
        payMax: pay ? pay.payMax : null,
        payUnit: pay && pay.payUnit ? pay.payUnit : undefined,
        datePosted: detail.postedDate || m.postedDate || null,
        category: detail.category || null,
      });
    }
    byHotel.set(hotel.name, enriched);
  }
  return byHotel;
}

/**
 * Hotel AKA runs its own careers site (UKG Pro Recruiting), separate
 * from every brand/management-company scraper above (see
 * scripts/scrapers/hotelaka.js). Plain fetch(), no browser needed — and
 * with only ~28 jobs across the entire chain, one unfiltered search
 * covers every property, no per-city search needed.
 */
async function scrapeHotelAkaBrand(hotels) {
  const allRaw = await scrapeAkaJobs();

  const byHotel = new Map();
  for (const hotel of hotels) {
    const matches = allRaw.filter((j) => akaPropertyMatches(j.propertyName, hotel.scrape.propertyMatch));
    const enriched = [];
    for (const m of matches) {
      const detail = await fetchAkaJobDetail(m.id);
      if (detail === null) continue; // closed/removed posting — drop it (verify-before-including rule)
      const pay = detail.pay;
      enriched.push({
        title: m.title,
        url: detail.url,
        jobId: m.id,
        payMin: pay ? pay.payMin : null,
        payMax: pay ? pay.payMax : null,
        payUnit: pay && pay.payUnit ? pay.payUnit : undefined,
        datePosted: m.postedDate,
      });
    }
    byHotel.set(hotel.name, enriched);
  }
  return byHotel;
}

/**
 * Millennium Hotels & Resorts is a third-party management company, like
 * Aimbridge — The Bostonian is the only hotel on this project's list
 * managed by it. Its search API filters by numeric department ID rather
 * than property name (see scripts/scrapers/millennium.js), so each
 * hotel's own department ID is resolved once via the filters endpoint
 * before searching. Plain fetch(), no browser needed.
 */
async function scrapeMillenniumBrand(hotels) {
  const byHotel = new Map();
  for (const hotel of hotels) {
    const departmentId = await findMillenniumDepartmentId(hotel.scrape.propertyMatch);
    const raw = departmentId == null ? [] : await scrapeMillenniumDepartment(departmentId);
    const matches = raw.filter((j) => millenniumPropertyMatches(j.propertyName, hotel.scrape.propertyMatch));
    const enriched = [];
    for (const m of matches) {
      const detail = await fetchMillenniumJobDetail(m.id);
      if (detail === null) continue; // closed/unpublished posting — drop it (verify-before-including rule)
      const pay = detail.pay;
      enriched.push({
        title: m.title,
        url: detail.url,
        jobId: m.id,
        payMin: pay ? pay.payMin : null,
        payMax: pay ? pay.payMax : null,
        payUnit: pay && pay.payUnit ? pay.payUnit : undefined,
        datePosted: m.postedDate,
      });
    }
    byHotel.set(hotel.name, enriched);
  }
  return byHotel;
}

/**
 * Highgate is a third-party hotel management company, like Aimbridge and
 * Millennium — some hotels on this project's list nominally tagged
 * `brand: "independent"` (or, for Hilton Boston Back Bay, whose own
 * brand site has gone quiet) are actually Highgate-managed and post jobs
 * through Highgate's own iCIMS careers site instead (see
 * scripts/scrapers/highgate.js). Plain fetch(), no browser needed.
 * Highgate's location facet is a per-city opaque ID (not a computable
 * radius search like Hilton/IHG), so this searches once per distinct
 * city among the tracked Highgate hotels rather than once for the whole
 * metro area — same reasoning as the Boston-only search this replaced,
 * just generalized once Cambridge (Courtyard Boston Cambridge) joined
 * Boston as a covered city.
 */
const HIGHGATE_SEARCH_LOCATIONS_BY_CITY = {
  Boston: HIGHGATE_BOSTON_SEARCH_LOCATION,
  Cambridge: HIGHGATE_CAMBRIDGE_SEARCH_LOCATION,
};

async function scrapeHighgateBrand(hotels) {
  const cities = [...new Set(hotels.map((h) => h.city))];
  const allRaw = [];
  const seen = new Set();
  for (const city of cities) {
    const searchLocation = HIGHGATE_SEARCH_LOCATIONS_BY_CITY[city];
    if (!searchLocation) continue;
    const jobs = await scrapeHighgateLocation(searchLocation);
    for (const j of jobs) {
      if (j.url && !seen.has(j.url)) {
        seen.add(j.url);
        allRaw.push(j);
      }
    }
  }

  const byHotel = new Map();
  for (const hotel of hotels) {
    const matches = allRaw.filter((j) => highgatePropertyMatches(j.propertyName, hotel.scrape.propertyMatch));
    const enriched = [];
    for (const m of matches) {
      const detail = await fetchHighgateJobDetail(m.url);
      if (detail === null) continue; // 410'd or errored on direct visit — drop it (verify-before-including rule)
      const pay = detail.pay;
      enriched.push({
        title: m.title,
        url: detail.url,
        jobId: m.id,
        payMin: pay ? pay.payMin : null,
        payMax: pay ? pay.payMax : null,
        payUnit: pay && pay.payUnit ? pay.payUnit : undefined,
        datePosted: detail.datePosted,
        category: detail.category || null,
      });
    }
    byHotel.set(hotel.name, enriched);
  }
  return byHotel;
}

/**
 * Hireology hosts single-property careers mini-sites (see
 * scripts/scrapers/hireology.js), one per hotel rather than one shared
 * portal per management company — so unlike Highgate/Aimbridge/
 * Millennium above, this searches once per hotel directly by its own
 * `careersPath` (stored in `scrape.propertyMatch`, e.g. "colonnadehotel"
 * for The Colonnade Hotel) rather than once per city, and there's no
 * property-name filtering step since every job returned already belongs
 * to that one hotel.
 */
async function scrapeHireologyBrand(hotels) {
  const byHotel = new Map();
  for (const hotel of hotels) {
    const careersPath = Array.isArray(hotel.scrape.propertyMatch) ? hotel.scrape.propertyMatch[0] : hotel.scrape.propertyMatch;
    const raw = await scrapeHireologyCareers(careersPath);
    const enriched = raw.map((j) => ({
      title: j.title,
      url: j.url,
      jobId: j.id,
      payMin: j.pay ? j.pay.payMin : null,
      payMax: j.pay ? j.pay.payMax : null,
      payUnit: j.pay && j.pay.payUnit ? j.pay.payUnit : undefined,
      datePosted: j.datePosted,
    }));
    byHotel.set(hotel.name, enriched);
  }
  return byHotel;
}

/**
 * ADP Workforce Now (see scripts/scrapers/adp.js) is, like Hireology,
 * an ATS platform rather than a management company — a hotel embeds a
 * "recruitment-current-openings" widget on its own careers page, keyed
 * by a `cid`/`ccId` pair pulled from that page's markup. Unlike
 * Hireology's single-property sites, one `cid` can span multiple
 * locations (see scraper module docs), so each job's own
 * `requisitionLocations` is checked before being counted, rather than
 * trusting the widget's `ccId` scope blindly — same verify-per-job
 * pattern as the city-wide brand searches above. Two matching
 * strategies depending on what a given `cid`'s location data actually
 * carries: `scrape.propertyMatch` (a location-name substring, e.g.
 * "Lenox") where the property name is embedded in the location text
 * itself, or `scrape.adpPostalCode` where it isn't (Battery Wharf's
 * account only gives generic "Boston, MA, US" location text with no
 * property name anywhere in it, so its zip code is the only
 * consistently-present per-job signal — see scraper module docs).
 */
async function scrapeAdpBrand(hotels) {
  const byHotel = new Map();
  for (const hotel of hotels) {
    const { adpCid, adpCcId, propertyMatch, adpPostalCode } = hotel.scrape;
    const raw = await scrapeAdpJobRequisitions(adpCid, adpCcId);
    const matches = adpPostalCode
      ? raw.filter((j) => adpPostalCodeMatches(j.locations, adpPostalCode))
      : raw.filter((j) => adpLocationMatches(j.locations, propertyMatch));
    const enriched = matches.map((j) => ({
      title: j.title,
      url: j.url,
      jobId: j.id,
      payMin: j.pay ? j.pay.payMin : null,
      payMax: j.pay ? j.pay.payMax : null,
      payUnit: j.pay && j.pay.payUnit ? j.pay.payUnit : undefined,
      datePosted: j.datePosted,
    }));
    byHotel.set(hotel.name, enriched);
  }
  return byHotel;
}

/**
 * Sage Hospitality Group (see scripts/scrapers/sage.js) is a management
 * company, like Highgate/Aimbridge/Millennium, whose site is searched
 * once per hotel directly by its own `property2` slug (stored in
 * `scrape.propertyMatch`, e.g. "hotel-commonwealth") rather than a
 * shared city-wide search — the search API itself already scopes
 * results to that one property server-side (an exact-phrase Solr
 * query), so there's no client-side property-name filtering step here,
 * same as Hireology.
 */
async function scrapeSageBrand(hotels) {
  const byHotel = new Map();
  for (const hotel of hotels) {
    const propertySlug = Array.isArray(hotel.scrape.propertyMatch) ? hotel.scrape.propertyMatch[0] : hotel.scrape.propertyMatch;
    const raw = await scrapeSageProperty(propertySlug);
    const enriched = raw.map((j) => ({
      title: j.title,
      url: j.url,
      jobId: j.id,
      payMin: j.pay ? j.pay.payMin : null,
      payMax: j.pay ? j.pay.payMax : null,
      payUnit: j.pay && j.pay.payUnit ? j.pay.payUnit : undefined,
      category: j.category || null,
      datePosted: j.datePosted,
    }));
    byHotel.set(hotel.name, enriched);
  }
  return byHotel;
}

/**
 * SmartRecruiters (see scripts/scrapers/smartrecruiters.js) is, like
 * Hireology/ADP, a generic ATS rather than a management company —
 * Encore Boston Harbor is Wynn Resorts-managed and posts through
 * SmartRecruiters' public postings API directly (bypassing Wynn's own
 * careers site, which funnels through a build-specific Next.js Server
 * Action rather than a stable endpoint). One `smartRecruitersCompany`
 * (e.g. "WynnResorts") can span a whole nationwide portfolio in a
 * single un-filterable-by-property call, so hotels sharing a company
 * identifier are grouped to fetch that portfolio once, then filtered
 * per hotel by each job's own `customField` "Company" value — same
 * filter-after-fetch-everything shape as Highgate.
 */
async function scrapeSmartRecruitersBrand(hotels) {
  const byHotel = new Map();
  const companyGroups = new Map();
  for (const hotel of hotels) {
    const company = hotel.scrape.smartRecruitersCompany;
    if (!companyGroups.has(company)) companyGroups.set(company, []);
    companyGroups.get(company).push(hotel);
  }
  for (const [company, companyHotels] of companyGroups) {
    const allRaw = await scrapeSmartRecruitersPostings(company);
    for (const hotel of companyHotels) {
      const matches = allRaw.filter((j) => j.companyField === hotel.scrape.propertyMatch);
      const enriched = [];
      for (const m of matches) {
        const detail = await fetchSmartRecruitersJobDetail(company, m.id);
        if (detail === null) continue; // removed/closed posting — drop it (verify-before-including rule)
        enriched.push({
          title: m.title,
          url: detail.url,
          jobId: m.id,
          payMin: detail.pay ? detail.pay.payMin : null,
          payMax: detail.pay ? detail.pay.payMax : null,
          payUnit: detail.pay && detail.pay.payUnit ? detail.pay.payUnit : undefined,
          datePosted: detail.datePosted,
          category: detail.category || null,
        });
      }
      byHotel.set(hotel.name, enriched);
    }
  }
  return byHotel;
}

function diffHotelJobs(hotel, previousJobs, scrapedJobs, historyLines) {
  const prevByUrl = new Map(previousJobs.map((j) => [jobKey(j), j]));
  const newByUrl = new Map(scrapedJobs.map((j) => [jobKey(j), j]));

  const nextJobs = [];
  for (const [url, job] of newByUrl) {
    const prev = prevByUrl.get(url);
    const firstSeen = job.datePosted ? job.datePosted.slice(0, 10) : prev ? prev.firstSeen : today;
    const category = job.category || (prev && prev.category) || null;

    if (prev && (prev.payMin !== job.payMin || prev.payMax !== job.payMax)) {
      historyLines.push({
        date: today, hotel: hotel.name, jobId: job.jobId, title: job.title, url,
        event: 'pay_change', previousPay: { payMin: prev.payMin, payMax: prev.payMax, payUnit: prev.payUnit || null },
        payMin: job.payMin, payMax: job.payMax, payUnit: job.payUnit || null,
      });
    }
    historyLines.push({
      date: today, hotel: hotel.name, jobId: job.jobId, title: job.title, url,
      event: prev ? 'seen' : 'opened',
      payMin: job.payMin, payMax: job.payMax, payUnit: job.payUnit || null, firstSeen,
    });

    const outJob = { title: job.title, payMin: job.payMin, payMax: job.payMax, category, url, firstSeen };
    if (job.payUnit) outJob.payUnit = job.payUnit;
    nextJobs.push(outJob);
  }

  for (const [url, prev] of prevByUrl) {
    if (!newByUrl.has(url)) {
      historyLines.push({
        date: today, hotel: hotel.name, jobId: prev.jobId || null, title: prev.title, url,
        event: 'closed', firstSeen: prev.firstSeen || null,
      });
    }
  }

  return nextJobs;
}

async function main() {
  const data = JSON.parse(await fs.readFile(DATA_PATH, 'utf8'));
  const marriottHotels = data.hotels.filter((h) => h.scrape && h.scrape.source === 'marriott');
  const hiltonHotels = data.hotels.filter((h) => h.scrape && h.scrape.source === 'hilton');
  const hyattHotels = data.hotels.filter((h) => h.scrape && h.scrape.source === 'hyatt');
  const omniHotels = data.hotels.filter((h) => h.scrape && h.scrape.source === 'omni');
  const accorHotels = data.hotels.filter((h) => h.scrape && h.scrape.source === 'accor');
  const aimbridgeHotels = data.hotels.filter((h) => h.scrape && h.scrape.source === 'aimbridge');
  const ihgHotels = data.hotels.filter((h) => h.scrape && h.scrape.source === 'ihg');
  const hotelAkaHotels = data.hotels.filter((h) => h.scrape && h.scrape.source === 'hotelaka');
  const millenniumHotels = data.hotels.filter((h) => h.scrape && h.scrape.source === 'millennium');
  const highgateHotels = data.hotels.filter((h) => h.scrape && h.scrape.source === 'highgate');
  const hireologyHotels = data.hotels.filter((h) => h.scrape && h.scrape.source === 'hireology');
  const adpHotels = data.hotels.filter((h) => h.scrape && h.scrape.source === 'adp');
  const sageHotels = data.hotels.filter((h) => h.scrape && h.scrape.source === 'sage');
  const smartRecruitersHotels = data.hotels.filter((h) => h.scrape && h.scrape.source === 'smartrecruiters');

  const prevMarriottTotal = marriottHotels.reduce((sum, h) => sum + h.jobs.length, 0);
  const prevHiltonTotal = hiltonHotels.reduce((sum, h) => sum + h.jobs.length, 0);
  const prevHyattTotal = hyattHotels.reduce((sum, h) => sum + h.jobs.length, 0);
  const prevOmniTotal = omniHotels.reduce((sum, h) => sum + h.jobs.length, 0);
  const prevAccorTotal = accorHotels.reduce((sum, h) => sum + h.jobs.length, 0);
  const prevAimbridgeTotal = aimbridgeHotels.reduce((sum, h) => sum + h.jobs.length, 0);
  const prevIhgTotal = ihgHotels.reduce((sum, h) => sum + h.jobs.length, 0);
  const prevHotelAkaTotal = hotelAkaHotels.reduce((sum, h) => sum + h.jobs.length, 0);
  const prevMillenniumTotal = millenniumHotels.reduce((sum, h) => sum + h.jobs.length, 0);
  const prevHighgateTotal = highgateHotels.reduce((sum, h) => sum + h.jobs.length, 0);
  const prevHireologyTotal = hireologyHotels.reduce((sum, h) => sum + h.jobs.length, 0);
  const prevAdpTotal = adpHotels.reduce((sum, h) => sum + h.jobs.length, 0);
  const prevSageTotal = sageHotels.reduce((sum, h) => sum + h.jobs.length, 0);
  const prevSmartRecruitersTotal = smartRecruitersHotels.reduce((sum, h) => sum + h.jobs.length, 0);

  const browser = await chromium.launch();
  // A realistic desktop UA is required for careers.hyatt.com, which 403s
  // Playwright's default (HeadlessChrome-labeled) UA outright; harmless for
  // Marriott, which doesn't check.
  const page = await browser.newPage({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  });

  let scrapedByHotel;
  let hyattByHotel;
  let omniByHotel;
  let accorByHotel;
  try {
    scrapedByHotel = await scrapeMarriottBrand(page, marriottHotels);
    hyattByHotel = await scrapeHyattBrand(page, hyattHotels);
    omniByHotel = await scrapeOmniBrand(page.context().request, omniHotels);
    accorByHotel = await scrapeAccorBrand(page, accorHotels);
  } finally {
    await browser.close();
  }
  for (const [hotelName, jobs] of hyattByHotel) scrapedByHotel.set(hotelName, jobs);
  for (const [hotelName, jobs] of omniByHotel) scrapedByHotel.set(hotelName, jobs);
  for (const [hotelName, jobs] of accorByHotel) scrapedByHotel.set(hotelName, jobs);

  const hiltonByHotel = await scrapeHiltonBrand(hiltonHotels);
  for (const [hotelName, jobs] of hiltonByHotel) scrapedByHotel.set(hotelName, jobs);

  const aimbridgeByHotel = await scrapeAimbridgeBrand(aimbridgeHotels);
  for (const [hotelName, jobs] of aimbridgeByHotel) scrapedByHotel.set(hotelName, jobs);

  const ihgByHotel = await scrapeIhgBrand(ihgHotels);
  for (const [hotelName, jobs] of ihgByHotel) scrapedByHotel.set(hotelName, jobs);

  const hotelAkaByHotel = await scrapeHotelAkaBrand(hotelAkaHotels);
  for (const [hotelName, jobs] of hotelAkaByHotel) scrapedByHotel.set(hotelName, jobs);

  const millenniumByHotel = await scrapeMillenniumBrand(millenniumHotels);
  for (const [hotelName, jobs] of millenniumByHotel) scrapedByHotel.set(hotelName, jobs);

  const highgateByHotel = await scrapeHighgateBrand(highgateHotels);
  for (const [hotelName, jobs] of highgateByHotel) scrapedByHotel.set(hotelName, jobs);

  const hireologyByHotel = await scrapeHireologyBrand(hireologyHotels);
  for (const [hotelName, jobs] of hireologyByHotel) scrapedByHotel.set(hotelName, jobs);

  const adpByHotel = await scrapeAdpBrand(adpHotels);
  for (const [hotelName, jobs] of adpByHotel) scrapedByHotel.set(hotelName, jobs);

  const sageByHotel = await scrapeSageBrand(sageHotels);
  for (const [hotelName, jobs] of sageByHotel) scrapedByHotel.set(hotelName, jobs);

  const smartRecruitersByHotel = await scrapeSmartRecruitersBrand(smartRecruitersHotels);
  for (const [hotelName, jobs] of smartRecruitersByHotel) scrapedByHotel.set(hotelName, jobs);

  const newMarriottTotal = marriottHotels.reduce((sum, h) => sum + (scrapedByHotel.get(h.name) || []).length, 0);
  const newHiltonTotal = hiltonHotels.reduce((sum, h) => sum + (scrapedByHotel.get(h.name) || []).length, 0);
  const newHyattTotal = hyattHotels.reduce((sum, h) => sum + (scrapedByHotel.get(h.name) || []).length, 0);
  const newOmniTotal = omniHotels.reduce((sum, h) => sum + (scrapedByHotel.get(h.name) || []).length, 0);
  const newAccorTotal = accorHotels.reduce((sum, h) => sum + (scrapedByHotel.get(h.name) || []).length, 0);
  const newAimbridgeTotal = aimbridgeHotels.reduce((sum, h) => sum + (scrapedByHotel.get(h.name) || []).length, 0);
  const newIhgTotal = ihgHotels.reduce((sum, h) => sum + (scrapedByHotel.get(h.name) || []).length, 0);
  const newHotelAkaTotal = hotelAkaHotels.reduce((sum, h) => sum + (scrapedByHotel.get(h.name) || []).length, 0);
  const newMillenniumTotal = millenniumHotels.reduce((sum, h) => sum + (scrapedByHotel.get(h.name) || []).length, 0);
  const newHighgateTotal = highgateHotels.reduce((sum, h) => sum + (scrapedByHotel.get(h.name) || []).length, 0);
  const newHireologyTotal = hireologyHotels.reduce((sum, h) => sum + (scrapedByHotel.get(h.name) || []).length, 0);
  const newAdpTotal = adpHotels.reduce((sum, h) => sum + (scrapedByHotel.get(h.name) || []).length, 0);
  const newSageTotal = sageHotels.reduce((sum, h) => sum + (scrapedByHotel.get(h.name) || []).length, 0);
  const newSmartRecruitersTotal = smartRecruitersHotels.reduce((sum, h) => sum + (scrapedByHotel.get(h.name) || []).length, 0);

  // Guardrail: if any brand's scrape comes back completely empty while the
  // previous run had jobs for that brand, treat the whole run as unreliable
  // (selector/API drift, site redesign, block) rather than real data, and
  // leave data.json/history.jsonl untouched — same all-or-nothing policy as
  // the original Marriott-only guardrail, just checked per brand.
  const brokenBrands = [];
  if (newMarriottTotal === 0 && prevMarriottTotal > 0) brokenBrands.push(`Marriott (${marriottHotels.length} properties, had ${prevMarriottTotal})`);
  if (newHiltonTotal === 0 && prevHiltonTotal > 0) brokenBrands.push(`Hilton (${hiltonHotels.length} properties, had ${prevHiltonTotal})`);
  if (newHyattTotal === 0 && prevHyattTotal > 0) brokenBrands.push(`Hyatt (${hyattHotels.length} properties, had ${prevHyattTotal})`);
  if (newOmniTotal === 0 && prevOmniTotal > 0) brokenBrands.push(`Omni (${omniHotels.length} properties, had ${prevOmniTotal})`);
  if (newAccorTotal === 0 && prevAccorTotal > 0) brokenBrands.push(`Accor (${accorHotels.length} properties, had ${prevAccorTotal})`);
  if (newAimbridgeTotal === 0 && prevAimbridgeTotal > 0) brokenBrands.push(`Aimbridge (${aimbridgeHotels.length} properties, had ${prevAimbridgeTotal})`);
  if (newIhgTotal === 0 && prevIhgTotal > 0) brokenBrands.push(`IHG (${ihgHotels.length} properties, had ${prevIhgTotal})`);
  if (newHotelAkaTotal === 0 && prevHotelAkaTotal > 0) brokenBrands.push(`Hotel AKA (${hotelAkaHotels.length} properties, had ${prevHotelAkaTotal})`);
  if (newMillenniumTotal === 0 && prevMillenniumTotal > 0) brokenBrands.push(`Millennium (${millenniumHotels.length} properties, had ${prevMillenniumTotal})`);
  if (newHighgateTotal === 0 && prevHighgateTotal > 0) brokenBrands.push(`Highgate (${highgateHotels.length} properties, had ${prevHighgateTotal})`);
  if (newHireologyTotal === 0 && prevHireologyTotal > 0) brokenBrands.push(`Hireology (${hireologyHotels.length} properties, had ${prevHireologyTotal})`);
  if (newAdpTotal === 0 && prevAdpTotal > 0) brokenBrands.push(`ADP (${adpHotels.length} properties, had ${prevAdpTotal})`);
  if (newSageTotal === 0 && prevSageTotal > 0) brokenBrands.push(`Sage (${sageHotels.length} properties, had ${prevSageTotal})`);
  if (newSmartRecruitersTotal === 0 && prevSmartRecruitersTotal > 0) brokenBrands.push(`SmartRecruiters (${smartRecruitersHotels.length} properties, had ${prevSmartRecruitersTotal})`);

  if (brokenBrands.length) {
    const report = {
      date: today,
      aborted: true,
      reason: `Scrape returned 0 jobs for: ${brokenBrands.join('; ')}. Treating this as a broken scraper (selector/API drift, site change, block) rather than real data, and leaving data.json/history.jsonl untouched.`,
    };
    await fs.writeFile(REPORT_PATH, JSON.stringify(report, null, 2));
    console.error(report.reason);
    process.exitCode = 1;
    return;
  }

  const automatedSources = new Set(['marriott', 'hilton', 'hyatt', 'omni', 'accor', 'aimbridge', 'ihg', 'hotelaka', 'millennium', 'highgate', 'hireology', 'adp', 'sage', 'smartrecruiters']);
  const historyLines = [];
  const perHotelCounts = [];

  for (const hotel of data.hotels) {
    if (hotel.scrape && automatedSources.has(hotel.scrape.source)) {
      const scraped = scrapedByHotel.get(hotel.name) || [];
      const before = hotel.jobs.length;
      hotel.jobs = diffHotelJobs(hotel, hotel.jobs, scraped, historyLines);
      perHotelCounts.push({ hotel: hotel.name, before, after: hotel.jobs.length });
    }
  }

  data.generatedAt = new Date().toISOString();

  await fs.writeFile(DATA_PATH, JSON.stringify(data, null, 2) + '\n');
  if (historyLines.length) {
    const lines = historyLines.map((l) => JSON.stringify(l)).join('\n') + '\n';
    await fs.appendFile(HISTORY_PATH, lines);
  }

  const report = {
    date: today,
    aborted: false,
    marriottPropertiesScraped: marriottHotels.length,
    hiltonPropertiesScraped: hiltonHotels.length,
    hyattPropertiesScraped: hyattHotels.length,
    omniPropertiesScraped: omniHotels.length,
    accorPropertiesScraped: accorHotels.length,
    aimbridgePropertiesScraped: aimbridgeHotels.length,
    ihgPropertiesScraped: ihgHotels.length,
    hotelAkaPropertiesScraped: hotelAkaHotels.length,
    millenniumPropertiesScraped: millenniumHotels.length,
    highgatePropertiesScraped: highgateHotels.length,
    hireologyPropertiesScraped: hireologyHotels.length,
    adpPropertiesScraped: adpHotels.length,
    sagePropertiesScraped: sageHotels.length,
    smartRecruitersPropertiesScraped: smartRecruitersHotels.length,
    totalJobsBefore: prevMarriottTotal + prevHiltonTotal + prevHyattTotal + prevOmniTotal + prevAccorTotal + prevAimbridgeTotal + prevIhgTotal + prevHotelAkaTotal + prevMillenniumTotal + prevHighgateTotal + prevHireologyTotal + prevAdpTotal + prevSageTotal + prevSmartRecruitersTotal,
    totalJobsAfter: newMarriottTotal + newHiltonTotal + newHyattTotal + newOmniTotal + newAccorTotal + newAimbridgeTotal + newIhgTotal + newHotelAkaTotal + newMillenniumTotal + newHighgateTotal + newHireologyTotal + newAdpTotal + newSageTotal + newSmartRecruitersTotal,
    historyEventsWritten: historyLines.length,
    perHotelCounts,
    bigDrops: perHotelCounts.filter((c) => c.before >= 3 && c.after === 0),
  };
  await fs.writeFile(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main();
