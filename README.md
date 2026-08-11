# Union Hotel Jobs Map — Project Notes

## What this is
An interactive map (`hotel-jobs-map.html`) of union hotels in the Boston/
Cambridge area, showing filterable job openings and pay pulled from each
hotel's own corporate careers site. Built for UNITE HERE Local 26's hotel
guide.

The page itself is still a static file you can open directly in a browser
(Leaflet for the map, `fetch('data.json')` for data) — but the data is no
longer hand-edited into the HTML. It now lives in `data.json`, kept fresh
by a scraper that runs once a day via GitHub Actions and commits any
changes back to the repo. See **Architecture** below for how the pieces
fit together.

> **Note:** because the page loads `data.json` via `fetch()`, opening
> `hotel-jobs-map.html` straight from disk (`file://...`) will fail —
> browsers block `fetch()` on local files. Serve it locally with e.g.
> `python3 -m http.server` and open `http://localhost:PORT/hotel-jobs-map.html`,
> or view it through GitHub Pages once that's set up.

## Architecture
```
hotel-jobs-map.html         static frontend — fetches data.json, no build step
data.json                   current snapshot: hotels, jobs, pay, firstSeen
history.jsonl                append-only log of daily job observations/events
package.json, scripts/      the scraper (Node + Playwright)
  scripts/run-scrape.js        orchestrator: scrape → diff → write data.json/history.jsonl
  scripts/scrapers/marriott.js brand-specific scraper module (Playwright DOM scrape)
  scripts/scrapers/hilton.js   brand-specific scraper module (plain public REST API)
.github/workflows/
  daily-scrape.yml           GitHub Actions cron (daily) that runs the scraper and commits changes
```

**Hosting**: GitHub Pages, serving straight from the repo. There's no
separate deploy step — the daily workflow committing an updated
`data.json` *is* the deploy. (One-time setup still needed in the repo's
Settings → Pages: set source to "Deploy from a branch", branch `main`,
folder `/`.)

**Running the scraper locally**:
```
npm install
npx playwright install chromium
npm run scrape
```

**Adding a new brand scraper**: each brand gets its own module in
`scripts/scrapers/<brand>.js`, following the shape of `marriott.js` or
`hilton.js` — export a function that returns raw job records for a given
search location, plus whatever verification/enrichment the brand's site
supports. Wire it into `run-scrape.js` alongside the existing brand
calls, keyed off each hotel's `scrape.source` field in `data.json`.
Hotels not yet wired up have `scrape: null` (see Data model) until this
happens. Worth checking early whether the brand's site is, like Hilton,
built on a common ATS platform (Oracle Recruiting Cloud, Workday,
iCIMS, etc.) with a public JSON API — that's a much easier and more
robust source than DOM-scraping a bot-protected search page like
Marriott's.

## Ground rules (established with the user — don't relitigate these)
- **Corporate career sites only.** No Indeed, Glassdoor, ZipRecruiter,
  hcareers, hospitalityonline, or any other aggregator. If a hotel's job
  data only appears on a third party site, leave it with no openings
  rather than use that source.
- **Pay is hourly by default.** Most union hotel postings are hourly.
  Salaried roles (managers, execs) use `payUnit:"annual"` — see Data
  Model below.
- **Verify before including.** Search-indexed job listings on
  careers.marriott.com go stale fast — several listings that looked live
  in search results 404'd when actually fetched. The scraper enforces
  this automatically now: every matched job is visited directly before
  being kept, and dropped if it 404s (see `fetchJobDetail` in
  `scripts/scrapers/marriott.js`).
- **Rhode Island hotels were deliberately removed** from the list (Aloft
  Providence Downtown, Bally's Twin River Lincoln Casino Resort, Graduate
  Providence, Omni Providence, Renaissance Providence). RI postings on
  careers.marriott.com don't show pay ranges the way Massachusetts ones
  do (MA has a pay transparency law), so RI listings weren't usable for
  this project's purpose. List is now 41 hotels, all MA.

## Key discoveries about careers.marriott.com
- **There's a real JSON API (`/api/get-jobs`) but it's bot-protected** —
  it 403s even a `fetch()` call made from inside the already-loaded page.
  Only requests the site's own script initiates (page load, an in-app
  pagination click) seem to carry whatever Akamai sensor/fingerprint data
  is required. Don't waste time trying to hit the API directly.
- **DOM-scraping the rendered search results works reliably**, using
  Playwright. Each result is `li.results-list__item`, with title, pay,
  and property name in predictable child elements — see
  `scrapeMarriottLocation()` in `scripts/scrapers/marriott.js` for the
  exact selectors.
- **Pagination is solved**: driving the in-page "next page" control with
  a real Playwright click (not navigating to `/jobs/page/N` as a URL)
  correctly preserves the location filter across pages. A plain URL
  fetch of page 2+ does *not* — it silently falls back to the full
  unfiltered global job list (13,000+ jobs). This was previously a
  manual, ask-the-user-to-paste-a-URL problem; it isn't anymore.
- **Each job's detail page has structured `JobPosting` JSON-LD**,
  including a `datePosted` field — Marriott's own record of when the
  listing went live. The scraper uses this as `firstSeen` when available
  (falling back to "first time our scraper saw it" otherwise), which is
  more trustworthy than anything inferred purely from scrape cadence.
- **No scrapable "category" field.** The hand-curated category labels
  (e.g. "Housekeeping & Laundry") aren't present in the search results or
  the job detail JSON-LD — that facet only seems to apply as a search
  filter, not as a per-job field. Auto-scraped jobs get `category: null`;
  a job's category is only populated if it was set by hand and the same
  job URL persists across scrapes.
- **Multiple postings can represent literally the same role.** Marriott
  sometimes re-titles/re-posts a listing under a new URL (observed with
  an Aloft bartender role). Since job identity is tracked by URL, this
  shows up in `history.jsonl` as one job "closing" and a new one
  "opening" on the same day, even though a human would call it the same
  job continuing. Known limitation, not a bug.

## Key discoveries about jobs.hilton.com
- **It's a stock Oracle Recruiting Cloud ("Candidate Experience") site**,
  not custom-built — `jobs.hilton.com`'s "Search jobs" link goes straight
  to `efet.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1009`.
  Worth checking for on any corporate careers site before assuming a
  Marriott-style DOM scrape is needed.
- **The REST API behind it is completely public and unprotected** — no
  Akamai/bot-fingerprinting, no session or cookies required, works from a
  plain `fetch()`. This is a big step up from Marriott: no Playwright, no
  pagination-by-click, no risk of the site quietly falling back to an
  unfiltered result set. See `scripts/scrapers/hilton.js` for the three
  endpoints used (`recruitingCESearchAutoSuggestions` to geocode a city
  to a `LocationId`, `recruitingCEJobRequisitions` for the radius-based
  job search, `recruitingCEJobRequisitionDetails` for per-job
  verification + enrichment).
- **Search results carry an exact property name** (`workLocation[0]
  .LocationName`), so hotel matching doesn't need Marriott's fuzzy
  word-stripping — just lowercase/punctuation normalization (see
  `normalizePropertyName`/`propertyMatches` in `hilton.js`). One entry in
  `data.json`, the combined Hampton Inn/Homewood Suites Seaport building,
  is actually two separate ATS listings under one roof, so
  `scrape.propertyMatch` supports either a single name or an array of
  aliases.
- **Pay is freeform text**, not a structured field — each property's HR
  team types it into a "Salary" custom field however they like ("$31.77 -
  $42.37/USD/Hourly", "120K - 140K", "$62,353 yearly", "20.75", etc.).
  `parsePay()` in `hilton.js` handles this with number-extraction plus a
  unit heuristic (explicit "hour"/"annual"/"salary" keywords when
  present, falling back to magnitude — every observed hourly wage is
  under $200, every observed salary is over it). Weekly-paid postings
  (rare — one observed) are dropped since the schema doesn't model that
  unit.
- **The job detail endpoint is also the verification step** and, unlike
  Marriott's detail-page JSON-LD, returns a real `Category` field
  (e.g. "Housekeeping and Laundry", "Culinary") — so Hilton jobs get a
  scraped `category` for free, rather than relying on the client-side
  `classifyDepartment()` keyword guesser. A requisition that's been
  pulled returns `items: []` (still HTTP 200) rather than 404ing, so
  "verify before including" checks for an empty `items` array instead of
  a failed request status.
- **Location search is radius-based, not a location-name filter** — the
  scraper geocodes each distinct city in the tracked hotel list to an
  Oracle `LocationId` via the autosuggest endpoint, then searches within
  25mi of it. All 7 Boston-area Hilton properties are well inside that
  radius from a single "Boston" search.

## Data model
`data.json`:
```json
{
  "generatedAt": "2026-08-10T04:22:53.724Z",
  "hotels": [
    {
      "name": "Hotel Name",
      "city": "Boston",
      "lat": 42.xxxx, "lng": -71.xxxx,
      "brand": "marriott",
      "scrape": { "source": "marriott", "propertyMatch": "Exact Name Marriott Uses" },
      "scrapeNote": "optional — why this hotel is/isn't automated",
      "jobs": [
        {
          "title": "Housekeeper",
          "payMin": 31.17, "payMax": 31.17,
          "payUnit": "annual",
          "category": "Housekeeping & Laundry",
          "url": "https://careers.marriott.com/...",
          "firstSeen": "2026-07-23"
        }
      ]
    }
  ]
}
```
- `brand`: `marriott` | `hilton` | `hyatt` | `omni` | `ihg` | `independent`
  — used to route scraping. `marriott` and `hilton` have scrapers built
  so far.
- `scrape`: `null` means "not automated" — either no scraper exists yet
  for the brand, or (see `scrapeNote`) the hotel doesn't post to its
  brand's corporate site at all (e.g. Courtyard Cambridge is
  Highgate-managed). `propertyMatch` is usually a single string but may
  be an array of alias strings, for the rare case where one `data.json`
  hotel entry corresponds to more than one listing on the brand's site
  (e.g. a combined Hampton Inn/Homewood Suites building with two
  separate Hilton ATS entries).
- `jobs[].firstSeen`: from the brand's own posting-date field when
  available (Marriott's `datePosted`, Hilton's `PostedDate`), else the
  date our scraper first saw the listing. Not currently shown in the UI
  (by request — logged for later analysis, not surfaced yet).
- Empty `jobs: []` on a hotel with `scrape: null` means "checked by hand,
  nothing found" OR "not yet checked" — same ambiguity as before, still
  only resolved by the status list further down.

`history.jsonl` — one JSON object per line, append-only, written by every
scrape run:
```json
{"date":"2026-08-10","hotel":"Sheraton Boston","jobId":"...","title":"Housekeeper","url":"...","event":"opened","payMin":31.17,"payMax":31.17,"payUnit":null,"firstSeen":"2026-08-06"}
```
`event` is one of `opened` (new job), `seen` (still posted today),
`pay_change` (pay differed from the last observation — includes
`previousPay`), or `closed` (was posted, no longer found). This is what
lets you reconstruct how long a listing stayed up, or whether pay moved,
without needing git blame archaeology.

## Guardrail
If a scrape run comes back with **zero** jobs for a brand's tracked
properties, while the previous run had some, `run-scrape.js` treats that
brand's scrape as broken (selector/API drift, site redesign, bot-block)
rather than "hiring stopped everywhere overnight" — checked
independently per brand, but a failure on either one aborts the *whole*
run without touching `data.json`/`history.jsonl` (kept simple/all-or-
nothing rather than trying to write only the healthy brand's data).
Writes `scrape-report.json` (gitignored, uploaded as a workflow artifact)
explaining why, and exits non-zero so the GitHub Actions run shows as
failed. Smaller swings (one hotel's count dropping) are logged in the
report but don't block the commit.

## Current status by hotel (41 total)
**Automated (scraped daily):**
- Marriott brand (14): Aloft Boston Seaport, Courtyard by Marriott
  Downtown/North Station, Courtyard by Marriott East Boston (Logan),
  Courtyard by Marriott South Boston, Element Seaport Boston, Le Meridien
  Cambridge, Moxy Boston Downtown, Renaissance Boston Seaport,
  Ritz-Carlton Boston, Sheraton Boston, Sheraton Commander, W Boston,
  Westin Boston Seaport, Westin Copley Place
- Hilton brand (7): DoubleTree Suites Boston-Cambridge, Hampton Inn
  Crosstown, Hampton Inn & Homewood Suites Seaport, Hilton Boston Back
  Bay, Hilton Boston Logan Airport, Hilton Boston Park Plaza, Hilton
  Garden Inn Boston Logan Airport. Three of these (Crosstown, Back Bay,
  Garden Inn Logan) had zero open postings as of the scraper's build date
  (2026-08-11), so their `scrape.propertyMatch` is a best-guess based on
  Hilton's naming convention for the other four (confirmed exact via live
  postings), not yet confirmed against a real listing — worth
  double-checking the first time one of them actually has a job posted.

Whatever `data.json` currently shows for automated hotels is live as of
the last scrape run; this README won't try to track individual counts
for them since they update daily.

**Marriott-branded but excluded from scraping:**
- Courtyard by Marriott Cambridge (Highgate-managed, doesn't post to
  careers.marriott.com — confirmed by hand, don't re-add without
  re-checking)

**Not yet automated (no scraper built yet):**
- Hyatt family (3): Hyatt Centric Faneuil Hall, Hyatt Place Seaport,
  Hyatt Regency Boston
- Omni family (2): Omni Boston Seaport, Omni Parker House
- IHG (1): InterContinental Boston
- Independent/other (13): Battery Wharf, Bostonian, Colonnade, Copley
  Square, Dagny, Encore Boston Harbor, Fairmont Copley Plaza, Hotel AKA
  Back Bay, Hotel AKA Boston Common, Hotel Commonwealth, Lenox, Newbury
  Boston, Raffles Boston

## Next steps (pick up in roughly this order)
1. One-time housekeeping: commit the current working tree (scraper,
   workflow, updated data.json/history.jsonl, README) and enable GitHub
   Pages in repo settings (source: `main` branch, `/` root) so the map is
   reachable at a URL instead of only local/`file://`.
2. Remaining non-Marriott/Hilton brand scrapers, one brand-family at a
   time — Hyatt next (3 hotels), then Omni, IHG, then the independents
   (which will likely need per-hotel research rather than one shared
   brand scraper). Worth checking each one for a public ATS API first
   (see the Hilton discoveries above) before assuming a Marriott-style
   DOM scrape is needed.
3. Spot-check the career field classifier (`classifyDepartment()` in
   `hotel-jobs-map.html`) now that more brands' real job titles are
   flowing in — the keyword rules were tuned against the ~20 Marriott
   titles seen so far and will likely need new keywords (e.g.
   valet/laundry-specific titles) as coverage grows. Also worth deciding
   whether Hilton's real scraped `category` values (see Data model)
   should be preferred over the keyword guess wherever present, the way
   the hand-curated Marriott `category` field already is. Consider
   whether "Other" should become a fourth filterable chip once there's
   enough volume in it to be useful.
4. **Tune the career field filter to only display matching jobs.**
   Right now `state.department` only decides which *hotels* show up
   (`matches()` keeps a hotel if any one of its jobs matches) — once a
   hotel qualifies, its card and map popup still list every job at that
   hotel, not just the ones in the selected department. Filtering should
   narrow the job list itself, not just which hotels appear.
5. **Update the UI for job postings.** Revisit how individual job
   listings are presented (hotel card badges, map popup formatting) now
   that department tags and multi-job hotels are more common — current
   layout was designed around 1-3 jobs per hotel and may not hold up as
   more brands get scraped and hotels regularly show 5+ openings.
6. Later: once `history.jsonl` has enough days of data to be interesting,
   consider surfacing posting duration ("posted X days ago") in the UI —
   deliberately deferred for now.
7. Consider: does the user want RIPTA/commuter rail added later for
   completeness, or is MBTA subway sufficient? (Unrelated to the scraper
   work — held over from before.)

## Other features already built into the artifact
- **City filter, career field filter, search box, "only hotels hiring"
  toggle, min-pay slider** (hourly-only; annual-salary jobs are excluded
  from the slider comparison but still shown in the popup/card).
- **Career field filter** (Housekeeping / Food & Beverage / Front Office):
  Marriott doesn't expose a scrapable category field (see Key discoveries
  above), so department is inferred client-side from each job's title via
  keyword matching (`classifyDepartment()` in `hotel-jobs-map.html`),
  falling back to the hand-curated `category` text where present. Hilton
  jobs do carry a real scraped `category` (e.g. "Housekeeping and
  Laundry"), but the classifier doesn't currently prefer it over the
  keyword guess — see next-steps item 3. Anything that doesn't match a
  rule (sales, events, security, management titles, etc.) is classified
  `Other` and is only visible when no career-field filter is applied.
- **Public transit overlay**: MBTA Red/Orange/Blue/Green(B/C/D/E)/Mattapan
  lines, toggleable per line. This is **static data** (real station
  coordinates connected in sequence, not live), because the MBTA v3 API
  isn't reachable from inside the artifact sandbox. Doesn't need
  updating — station locations don't move. Silver Line and Commuter Rail
  are NOT included.
- Dark "concierge desk" visual theme (navy/brass/cream, Fraunces +
  Inter + Space Mono fonts).
