/*
 * Hireology careers-site scraper.
 *
 * Hireology is an ATS platform that hosts single-property "careers.
 * hireology.com/{careersPath}" mini-sites — unlike Highgate/Aimbridge/
 * Millennium, it's not a management company whose site spans multiple
 * hotels, so there's no property-name matching needed: every job
 * returned by a given careersPath already belongs to that one hotel
 * (confirmed via `organization.name` on each job, e.g. "The Colonnade
 * Hotel").
 *
 * The careers page itself is a client-rendered React app with no jobs
 * in its initial HTML, but the HTML does embed a short-lived signed
 * `apiToken` (a JWT, ~30min TTL per `exp`/`nbf` claims) that the app
 * sends as `Authorization: Bearer <token>` to Hireology's actual public
 * API, `api.hireology.com/v2/public/careers/{careersPath}`. That token
 * has to be scraped fresh off the HTML page before each API call — no
 * browser needed for either step, plain `fetch()` works for both.
 *
 * That one API call returns every field needed per job: location
 * (street address + city/state/zip), compensation, and a clean
 * `career_site_url`. Compensation has two mutually-exclusive shapes
 * depending on `is_comp_range`: a flat `comp_single_amount` (the
 * observed case for every hourly role here) or a `comp_range_min`/`max`
 * pair (observed for the one salaried role, Assistant Front Office
 * Manager) — `comp_period` ("hour" vs "year") gives the unit directly,
 * unlike Highgate/IHG's magnitude-inference heuristic.
 */

const CAREERS_BASE = 'https://careers.hireology.com';
const API_BASE = 'https://api.hireology.com/v2';

async function fetchApiToken(careersPath) {
  const res = await fetch(`${CAREERS_BASE}/${careersPath}`, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' } });
  if (!res.ok) throw new Error(`Hireology careers page ${res.status}`);
  const html = await res.text();
  const m = html.match(/apiToken":"([^"]+)"/);
  if (!m) throw new Error('Hireology apiToken not found in careers page HTML');
  return m[1];
}

/** comp_period is the unit directly ("hour"/"year") — no magnitude
 * inference needed, unlike highgate.js/ihg.js. Every other scraper in
 * this project only sets payUnit for the "annual" case and leaves it
 * undefined (implicitly hourly) otherwise, so this follows suit rather
 * than introducing a new "hourly" value into the data model. */
export function parsePay(compensation) {
  if (!compensation) return null;
  const payUnit = compensation.comp_period === 'year' ? 'annual' : undefined;
  if (compensation.is_comp_range) {
    const payMin = parseFloat(compensation.comp_range_min);
    const payMax = parseFloat(compensation.comp_range_max);
    if (Number.isNaN(payMin) || Number.isNaN(payMax) || (payMin === 0 && payMax === 0)) return null;
    return payUnit ? { payMin, payMax, payUnit } : { payMin, payMax };
  }
  const pay = parseFloat(compensation.comp_single_amount);
  if (Number.isNaN(pay) || pay === 0) return null;
  return payUnit ? { payMin: pay, payMax: pay, payUnit } : { payMin: pay, payMax: pay };
}

export async function scrapeHireologyCareers(careersPath) {
  const token = await fetchApiToken(careersPath);
  const res = await fetch(`${API_BASE}/public/careers/${careersPath}?sort=jobs.created_at&sort_dir=desc`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
  });
  if (!res.ok) throw new Error(`Hireology public careers API ${res.status}`);
  const json = await res.json();
  return (json.data || [])
    .filter((j) => j.status === 'Open')
    .map((j) => ({
      id: String(j.id),
      title: j.name,
      url: j.career_site_url,
      propertyName: j.organization?.name || null,
      pay: parsePay(j.compensation),
      datePosted: j.created_at || null,
      location: j.locations?.[0] || null,
    }));
}
