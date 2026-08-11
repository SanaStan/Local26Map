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
  scripts/scrapers/marriott.js brand-specific scraper module
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
`scripts/scrapers/<brand>.js`, following the shape of `marriott.js` —
export a function that returns raw job records for a given search
location, plus whatever verification/enrichment the brand's site
supports. Wire it into `run-scrape.js` alongside the Marriott call, keyed
off each hotel's `scrape.source` field in `data.json`. Non-Marriott
hotels currently have `scrape: null` (see Data model) until this happens.

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
  — used to route scraping. Only `marriott` has a scraper built so far.
- `scrape`: `null` means "not automated" — either no scraper exists yet
  for the brand, or (see `scrapeNote`) the hotel doesn't post to its
  brand's corporate site at all (e.g. Courtyard Cambridge is
  Highgate-managed).
- `jobs[].firstSeen`: from Marriott's `datePosted` when available, else
  the date our scraper first saw the listing. Not currently shown in the
  UI (by request — logged for later analysis, not surfaced yet).
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
If a scrape run comes back with **zero** jobs across every Marriott
property it tracks, while the previous run had some, `run-scrape.js`
treats that as a broken scraper (selector drift, site redesign,
bot-block) rather than "hiring stopped everywhere overnight" — it aborts
without touching `data.json`/`history.jsonl`, writes `scrape-report.json`
(gitignored, uploaded as a workflow artifact) explaining why, and exits
non-zero so the GitHub Actions run shows as failed. Smaller swings (one
hotel's count dropping) are logged in the report but don't block the
commit.

## Current status by hotel (41 total)
**Automated (Marriott brand, scraped daily):** Aloft Boston Seaport,
Courtyard by Marriott Downtown/North Station, Courtyard by Marriott East
Boston (Logan), Courtyard by Marriott South Boston, Element Seaport
Boston, Le Meridien Cambridge, Moxy Boston Downtown, Renaissance Boston
Seaport, Ritz-Carlton Boston, Sheraton Boston, Sheraton Commander, W
Boston, Westin Boston Seaport, Westin Copley Place — 14 hotels. Whatever
`data.json` currently shows for these is live as of the last scrape run;
this README won't try to track individual counts for them anymore since
they update daily.

**Marriott-branded but excluded from scraping:**
- Courtyard by Marriott Cambridge (Highgate-managed, doesn't post to
  careers.marriott.com — confirmed by hand, don't re-add without
  re-checking)

**Not yet automated (non-Marriott brands — no scraper built yet):**
- Hilton family (7): DoubleTree Suites Boston-Cambridge, Hampton Inn
  Crosstown, Hampton Inn & Homewood Suites Seaport, Hilton Back Bay,
  Hilton Logan Airport, Hilton Park Plaza, Hilton Garden Inn Logan Airport
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
2. Non-Marriott brand scrapers, one brand-family at a time — start with
   Hilton (7 hotels) since it's the largest group. Find the real
   corporate careers domain (`jobs.hilton.com`?) and whether it supports
   a similar location-filtered search; write `scripts/scrapers/hilton.js`
   following the `marriott.js` pattern; add hotels' `scrape` config in
   `data.json`.
3. Repeat for Hyatt, Omni, IHG, then the independents (which will likely
   need per-hotel research rather than one shared brand scraper).
4. Spot-check the career field classifier (`classifyDepartment()` in
   `hotel-jobs-map.html`) once more brands' real job titles start flowing
   in — the keyword rules were tuned against the ~20 Marriott titles seen
   so far and will likely need new keywords (e.g. valet/laundry-specific
   titles) as coverage grows. Consider whether "Other" should become a
   fourth filterable chip once there's enough volume in it to be useful.
5. **Tune the career field filter to only display matching jobs.**
   Right now `state.department` only decides which *hotels* show up
   (`matches()` keeps a hotel if any one of its jobs matches) — once a
   hotel qualifies, its card and map popup still list every job at that
   hotel, not just the ones in the selected department. Filtering should
   narrow the job list itself, not just which hotels appear.
6. **Find real sources for the other hotel brands.** Non-Marriott
   hotels (Hilton, Hyatt, Omni, IHG, independents — see status list
   above) all have `scrape: null` and no corporate-careers-site research
   done yet. This is the same work as next-steps item 2/3 above, called
   out separately since it's the biggest remaining gap in data coverage.
7. **Update the UI for job postings.** Revisit how individual job
   listings are presented (hotel card badges, map popup formatting) now
   that department tags and multi-job hotels are more common — current
   layout was designed around 1-3 jobs per hotel and may not hold up as
   more brands get scraped and hotels regularly show 5+ openings.
8. Later: once `history.jsonl` has enough days of data to be interesting,
   consider surfacing posting duration ("posted X days ago") in the UI —
   deliberately deferred for now.
9. Consider: does the user want RIPTA/commuter rail added later for
   completeness, or is MBTA subway sufficient? (Unrelated to the scraper
   work — held over from before.)

## Other features already built into the artifact
- **City filter, career field filter, search box, "only hotels hiring"
  toggle, min-pay slider** (hourly-only; annual-salary jobs are excluded
  from the slider comparison but still shown in the popup/card).
- **Career field filter** (Housekeeping / Food & Beverage / Front Office):
  since Marriott doesn't expose a scrapable category field (see Key
  discoveries above), department is inferred client-side from each job's
  title via keyword matching (`classifyDepartment()` in
  `hotel-jobs-map.html`), falling back to the hand-curated `category`
  text where present. Anything that doesn't match a rule (sales, events,
  security, management titles, etc.) is classified `Other` and is only
  visible when no career-field filter is applied.
- **Public transit overlay**: MBTA Red/Orange/Blue/Green(B/C/D/E)/Mattapan
  lines, toggleable per line. This is **static data** (real station
  coordinates connected in sequence, not live), because the MBTA v3 API
  isn't reachable from inside the artifact sandbox. Doesn't need
  updating — station locations don't move. Silver Line and Commuter Rail
  are NOT included.
- Dark "concierge desk" visual theme (navy/brass/cream, Fraunces +
  Inter + Space Mono fonts).
