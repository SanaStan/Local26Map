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
  scripts/scrapers/hyatt.js    brand-specific scraper module (Playwright, drives real UI)
  scripts/scrapers/omni.js     brand-specific scraper module (Playwright request client, no page render)
  scripts/scrapers/accor.js    brand-specific scraper module (Playwright DOM scrape)
  scripts/scrapers/aimbridge.js management-company scraper module (plain public REST API)
  scripts/scrapers/ihg.js      brand-specific scraper module (plain public REST API)
  scripts/scrapers/hotelaka.js small-chain scraper module (plain public REST API + embedded-JSON HTML parsing)
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

**Testing frontend changes locally before pushing**: since GitHub Pages
serves whatever's on `main`, verify any change to `hotel-jobs-map.html`
or `data.json` against a local server first rather than finding out from
the live site:
```
python3 -m http.server 8765
```
then open `http://localhost:8765/hotel-jobs-map.html` and check the
browser console for errors — a page-crashing JS error (e.g. the null-pay
`.toFixed()` bug fixed after the Hyatt rollout, which silently emptied
the entire sidebar) can be completely invisible unless you're actually
looking at a rendered page and its console, not just the diff.

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

## Key discoveries about careers.hyatt.com
- **It's Oracle Taleo** (an older, different Oracle ATS product than
  Hilton's Oracle Recruiting Cloud). Its search API
  (`careersection/rest/jobboard/searchjobs`) is real and returns clean
  structured data, but **it 500s on anything that isn't driven by genuine
  UI interaction** — verified that a byte-identical POST (same body, same
  headers, same session cookies, fired via `context.request` or an
  in-page `fetch()`) still fails, while an actual typed-and-clicked
  search on the real page succeeds every time. So `hyatt.js`, like
  `marriott.js`, drives the real page with Playwright rather than calling
  the API directly — Hilton's plain-`fetch()` approach doesn't generalize
  to every ATS.
- **Default Playwright's UA gets 403'd outright** on careers.hyatt.com
  (separately from the above) — it needs a realistic desktop Chrome UA
  string, set once at `browser.newPage()` in `run-scrape.js` since
  Marriott doesn't care either way.
- **Search is organization-ID-based, not location-radius**: typing a
  property's exact name into the search box and clicking the top
  (properly-cased) autocomplete suggestion applies a server-side
  `ORGANIZATION` facet filter — much more precise than a radius search,
  but **a property only appears in that autocomplete at all if it
  currently has at least one open requisition** (confirmed against the
  site's own ~3000-entry "Property/Office List" checkbox facet too — same
  currently-posting-only subset, not a full portfolio directory). A
  property with zero live postings is thus indistinguishable, from this
  API's perspective, from a property that doesn't use this ATS at all.
- **One tracked hotel turned out to not use this ATS at all**: Hyatt
  Centric Faneuil Hall Boston is Magna Hospitality-managed and never
  appears in Hyatt's org search or property list; its only listings
  found anywhere were on hospitalityonline.com/hcareers — both
  explicitly excluded aggregators per this project's ground rules. Same
  situation as Courtyard by Marriott Cambridge: `scrape: null` with a
  `scrapeNote`, not scraped.
- **Selected filters accumulate in the page URL** (`?searchable=[...]`)
  rather than being replaced by a new search — searching a second
  property on the same page ORs it in with the first rather than
  replacing it, corrupting results. `scrapeHyattBrand` in `run-scrape.js`
  works around this by doing a fresh `page.goto` back to the bare search
  URL before every property, not just once at the start.
- **The autocomplete dropdown shows a loading placeholder first**
  (literally "Enter at least 2 characters..." plus a pile of embedded
  animation-script text) before real suggestions replace it. A fixed
  delay races that debounce and intermittently clicks the placeholder
  instead of a real result, silently applying no filter — `hyatt.js`
  waits for an actual short suggestion string to appear instead of
  sleeping a fixed amount.
- **`page.waitForLoadState('networkidle')` doesn't work for waiting on a
  same-page search XHR** — it's tied to navigation lifecycle and resolves
  instantly if the document already finished loading, silently skipping
  the wait entirely. Waiting on `page.waitForResponse()` per expected
  request (Hyatt fires one search request per portal — see below —
  registered *before* the triggering click) is what actually works.
- **Requests fan out across three parallel "portals"** (career sections)
  — `21860210089`, `22260210089`, `68160210089` — every search queries
  all three and a property's jobs can land in any one of them, so results
  from all three have to be merged.
- **No structured pay field** — the job detail page only ever says
  "Hourly US Dollar (USD) pay basis" with no number. The *only* place
  actual pay numbers show up is embedded in some job titles at each
  poster's discretion (e.g. "Guest Service Agent (Full Time, $33.20
  hourly)"), so most Hyatt jobs end up with no parseable pay — a real
  data-quality gap versus Marriott/Hilton, not a scraper bug.
- **The job detail endpoint doesn't 404 for closed postings** — it
  returns HTTP 200 with "THE JOB IS NO LONGER AVAILABLE" rendered
  client-side into the page (Angular SPA — reading the body before the
  page finishes rendering misses it, another `networkidle`-vs-instant-
  resolve trap). `verifyJobLive` in `hyatt.js` checks for that text as
  the actual "verify before including" signal.

## Key discoveries about jobs.dayforcehcm.com (Omni)
- **It's Dayforce (Ceridian)** — a fourth distinct ATS platform, found via
  a "Learn More" link on omnihotels.com/careers pointing at
  `jobs.dayforcehcm.com/en-US/ohmc/CANDIDATEPORTAL` (Canada properties use
  a separate iCIMS instance, out of scope here since both tracked Omni
  hotels are US).
- **The JSON API needs an `x-csrf-token` header** sourced from a separate
  `api/auth/csrf` GET, but is otherwise clean and well-structured.
  Notably, **the POST endpoints 403 under plain Node `fetch()`/`curl`
  even with a valid token and realistic UA, but work fine cold under
  Playwright's `context.request`** — same shape of problem as Hyatt, but
  the fix is much cheaper here: no page render or UI interaction needed
  at all, just swap the HTTP client. `omni.js` takes a Playwright
  `request` context (`page.context().request`) rather than either bare
  `fetch()` (Hilton) or a driven `page` (Marriott/Hyatt).
- **Location search resolves directly to properties, not just cities**:
  `api/geo/ohmc/location/search?filter=Boston` returns the two Boston
  Omni hotels by name directly, each with its own `locationId` — no
  separate geocode-a-city-then-radius-search step like Hilton needed.
  Searching within 15mi of *either* Boston property's `locationId`
  returns both properties' jobs combined (they're a short walk apart),
  so one search covers every tracked property in a metro area, same
  end result as Hilton's per-city radius search.
- **No structured pay field** — same gap as Hyatt, but the pay sentence
  is embedded in the middle of the full free-text job description
  instead of the title (e.g. "The hourly rate for this position is
  $32.21.", "Salary range for this position is $95,000 - $110,000 per
  year."), and coverage is much better — the large majority of Omni
  postings have it, unlike Hyatt where most don't. `parsePay()` in
  `omni.js` just extracts every dollar figure found anywhere in the
  description and takes the min/max span, rather than trying to parse
  the surrounding sentence — every dollar figure observed across ~40
  real postings was pay-related (no stray bonus/tip mentions), including
  step-scale postings that mention a starting *and* later-raise rate
  (e.g. "$24.72 and increasing to $32.76"), where the full min-max span
  is a reasonable single range to show.
- **No scrapable category field either** — `category` is left `null` for
  every Omni job, same situation as Marriott (client-side
  `classifyDepartment()` keyword guessing is what actually populates the
  career-field filter for these).
- **Closed postings 404 cleanly** — unlike Hyatt's always-200-with-a-
  message pattern, so `verifyJobLive` here is a plain status check, no
  page-text inspection needed.

## Key discoveries about careers.accor.com (Fairmont, Raffles, etc.)
- **Two hotels on the list were mislabeled**: Fairmont Copley Plaza and
  Raffles Boston had `brand: "independent"` in `data.json`, but both are
  Accor-group brands with real corporate postings on careers.accor.com —
  fixed to `brand: "accor"`. Worth double-checking any other
  "independent"-labeled hotel against its actual ownership before
  assuming there's truly no corporate site to scrape.
- **Runs on Attrax**, and unlike every other brand scraped so far, search
  results only render via full client-side JS hydration — no isolated
  XHR/JSON endpoint carries the job list (the query-string-bearing page
  itself is what gets hydrated), so this is Marriott-style DOM scraping,
  not an API client. Don't assume every ATS exposes a fetchable data
  endpoint just because Hilton/Hyatt/Omni's all did in some form.
- **A cookie-consent modal blocks all interaction** until dismissed
  (`dismissCookieBanner()` clicks "Continue without Accepting" once per
  page load) — easy to miss in headless testing since nothing errors,
  Playwright's element-visibility auto-wait just times out silently
  against elements sitting underneath the modal.
- **Search is keyword-based** (`?q=<property name>`), which reliably
  narrows to just that property's jobs. **Pagination has to go through
  the page's own global `pagination(n)` JS function** — a plain URL
  navigation to `&page=N` gets aborted; this "NoReload" widget only
  accepts being driven through its own client-side router. That router
  occasionally does a real navigation instead of an in-place DOM patch
  when paginating (cause unclear), which can destroy the JS execution
  context mid-read or make the `pagination(n)` call itself throw — both
  handled with a short retry, falling back to whatever page(s) were
  already collected rather than crashing the whole scrape.
- **Each result tile's CSS classes carry structured data for free** — a
  `sector-<slug>` class gives the job's category, no separate lookup
  needed. The tile's location field is a full address string
  ("Property Name, City, Country"), not just the property name — has to
  be split on the first comma before matching against `propertyMatch`.
- **No structured pay field** — same situation as Omni: pay only shows up
  as freeform text in the job's own detail page description, extracted
  the same way (every dollar figure found, min/max span).

## Key discoveries about Aimbridge Hospitality (careers.aimbridge.fountain.com)
- **Aimbridge is a third-party hotel management company, not a brand** —
  it doesn't own or franchise hotels, it operates them for whoever does,
  across 1,400+ properties and dozens of different brands (and unbranded
  independents). A hotel nominally tagged `brand: "independent"` on this
  project's list can still be Aimbridge-managed and post through
  Aimbridge's own careers site rather than any brand's — this is a
  distinct axis from brand affiliation (Fairmont/Raffles turning out to
  be Accor-affiliated, found while doing Accor, is the brand-axis version
  of the same lesson).
- **Runs on Fountain**, a fourth-again distinct ATS. Its JSON API
  (`aimbridge.fountain.com/internal_api/career_site/...`) is public and
  unauthenticated for the main `openings` search and the job-verification
  endpoint — plain `fetch()` works cold, closer to Hilton's setup than
  Hyatt's or Accor's. The one exception is the location-*suggest*
  endpoint (resolving a place name to a Google Place ID), which 500s
  under plain Node `fetch()` but works under Playwright's
  `context.request` — same fetch-vs-browser fingerprinting quirk seen
  with Hyatt/Omni. Rather than pull in a Playwright dependency for that
  one lookup, `aimbridge.js` just hardcodes Boston's Place ID as a
  constant (`BOSTON_PLACE_ID`) — Google Place IDs are stable, and this
  project only ever cares about the Boston metro anyway.
- **`radius` only accepts the literal string `"any"`** — passing an
  actual mile figure (tried 5–100) returns zero results every time. So a
  search returns Aimbridge's *entire* ~1,450-job nationwide portfolio,
  sorted by distance from the given Place ID; `scrapeAimbridgeLocation`
  caps pagination at 20 pages (200 jobs), verified empirically to
  comfortably cover all of Massachusetts from a Boston center point
  before results drift into Connecticut and beyond.
- **`pay_rate` is a clean structured field** (e.g. "$28.00 -
  $32.00/hour", "$110,000.00/year") — no freeform-description parsing
  needed, unlike Omni/Accor. Its `/hour` vs `/year` unit label is
  occasionally a data-entry typo in Aimbridge's own system (observed
  "$120,000.00 - $130,000.00/hour" and "$16.00/year" — both clearly
  wrong by an order of magnitude), so `parsePay()` uses magnitude, not
  the label, to decide `payUnit` — same heuristic used everywhere else
  this comes up.
- **The `title` field is always "{Property} - {Position}"**, not a clean
  position-only title like every other scraper here returns (no separate
  position field exists on this endpoint) — `scrapeAimbridgeLocation`
  strips the property-name prefix before returning, so it doesn't show
  up doubled against the hotel name already displayed as the card/popup
  heading in the UI.
- **None of the 11 "independent" hotels on the original candidate list
  turned out to have current Aimbridge postings** — despite the user
  identifying several as Aimbridge-managed (Dagny Boston confirmed one,
  via a DiamondRock/Aimbridge press release), an exhaustive check against
  Aimbridge's *entire* nationwide job list (all ~1,450 postings, not just
  ones near Boston) found zero matches for any of them, including Dagny,
  which the user had already flagged as having no current postings.
  Independent web research also actively contradicted Aimbridge
  management for several others (Colonnade: described as family-owned
  independent; Newbury Boston: Teneo Hospitality Group; Hotel
  Commonwealth: associated with Sage Hospitality Group).
- **A hotel already on the list, under a different brand, turned out to
  be the real find**: Westin Boston Seaport was already tracked as
  `brand: "marriott"` / `scrape.source: "marriott"`, but
  careers.marriott.com currently shows *zero* jobs for it — its real
  postings (10 of them, with full pay data) are on Aimbridge's site
  instead ("Westin Boston Seaport District", confirmed Aimbridge-managed
  via a DiamondRock press release about the Westin Boston Waterfront).
  Switched its `scrape.source` to `"aimbridge"` while leaving
  `brand: "marriott"` alone — brand describes the flag/franchise,
  `scrape.source` describes which company's job board actually has the
  postings, and a management company operating a brand-flagged hotel can
  make those diverge. Worth keeping in mind for every other
  Marriott/Hilton/Hyatt/Omni/Accor-branded hotel already on the list too,
  not just the ones nominally tagged "independent" — a brand-flagged
  hotel returning consistently zero postings from its own brand's site
  is a signal worth checking against Aimbridge (or another management
  company), not just assumed to mean "no one's hiring there right now."

## Key discoveries about IHG (careers.ihg.com)
- **Also Oracle Recruiting Cloud** — the same ATS product as Hilton, just
  a different hostname
  (`fa-evax-saasfaprod1.fa.ocs.oraclecloud.com`) and site number
  (`CX_1001` vs Hilton's `CX_1009`). Same public unauthenticated REST
  API, same endpoint shapes, same radius-search-then-verify-by-detail
  pattern — `ihg.js` is structurally a near-copy of `hilton.js`. Worth
  checking whether a new brand shares infrastructure with one already
  built before assuming everything needs fresh reverse-engineering; two
  of six brand/management-company scrapers so far have turned out to run
  on Oracle Recruiting Cloud.
- **Pay comes from a "Hiring Salary" flex field** (Hilton's equivalent is
  just called "Salary") in a different format: no `$` sign and no unit
  suffix at all, just "USD 30.00 - 32.20" or "USD 75,000.00 -
  81,000.00" — magnitude alone decides `payUnit` here, there's no unit
  word to even cross-check against, unlike everywhere else this comes
  up. Several jobs have no salary field at all (empty
  `requisitionFlexFields`), same as Hilton's zero-posting properties.
- **Job titles carry a redundant "- {Hotel Name}" suffix** with
  inconsistent hyphen spacing (e.g. "Front Desk Agent - InterContinental
  Boston" vs "Executive Steward- InterContinental Boston") — same
  cosmetic issue as Aimbridge's prefix, opposite end. Stripped in
  `run-scrape.js`'s `scrapeIhgBrand`, not in `ihg.js` itself: the
  suffix text is the hotel's public brand name ("InterContinental
  Boston"), which doesn't match the internal work-location code
  (`propertyMatch`, e.g. "IC - Boston (BOSHA)") the scraper module
  actually has on hand — but `run-scrape.js` already has each hotel's
  `data.json` display name available, which happens to match exactly.

## Key discoveries about Hotel AKA (UKG Pro Recruiting)
- **A fifth distinct ATS**: UKG Pro Recruiting (tenant "SHK1500SHKM",
  the property management company behind the AKA brand), no relation to
  any of the platforms scraped so far. Found via a URL the user supplied
  directly rather than independent research this time.
- **Small enough to not need location filtering at all** — the whole
  chain is ~11 properties nationwide (~28 total job postings), so one
  unfiltered search (`Top: 50`) run once returns every property's jobs
  in a single call; no per-city geocode/radius step like every other
  brand here needed.
- **Property names in the search results already match `data.json`
  exactly** ("Hotel AKA Back Bay", "Hotel AKA Boston Common") — no
  normalization workarounds needed, and titles come back clean already
  (no redundant property-name prefix/suffix to strip, unlike
  Aimbridge/IHG).
- **No structured pay field in the search results** — has to come from
  each job's own detail page, and that page isn't a JSON API either: the
  full job record is embedded as a single minified JS object literal
  (`var opportunity = new US.Opportunity.CandidateOpportunityDetail({...})`)
  in otherwise-static HTML. Confirmed this is genuinely server-rendered
  (present in a plain `curl`, not fetched by client JS after load), so
  `hotelaka.js` just does `fetch()` + brace-matching extraction — no
  browser needed. A naive regex isn't safe here since the object
  contains free-text job descriptions that could coincidentally contain
  `");` or stray `}` — `extractBalancedJson()` walks the string tracking
  quote state so those don't truncate the match early.
- **Two mutually-exclusive pay shapes** depending on a `Salaried` flag:
  hourly roles carry a single rate in `CompensationAmount.Value` (never
  a range — this platform apparently doesn't support hourly ranges, only
  salaried ones), salaried roles carry a real min/max in
  `PayRange.{PayRangeMinimum,PayRangeMaximum}` with `CompensationAmount
  .Value` left `null`. Never both populated on the same posting.
- **No usable category field** — every job across the entire nationwide
  portfolio has the literal placeholder `JobCategoryName: "All"`, not a
  real per-job classification (confirmed by checking all ~28 postings
  at once, not just the Boston ones) — treated as absent, same as
  Marriott/Omni/Aimbridge.
- **Closed/invalid postings return HTTP 200** with no error, just
  missing the `CandidateOpportunityDetail(...)` data blob entirely (for
  a truly nonexistent ID) or a real detail object with
  `OpportunityIsClosed: true` (for a since-closed requisition) — both
  checked as the "verify before including" signal.

## Key discoveries about Millennium Hotels & Resorts (Recruitee)
- **A sixth distinct ATS**: Recruitee, used for The Bostonian, which is
  managed by Millennium Hotels & Resorts rather than posting under its
  own name — the same management-company pattern as Aimbridge/Westin
  Boston Seaport, not a brand relationship. Found via a URL the user
  supplied directly.
- **Search filters by a numeric department ID, not a property name** —
  passing a string is rejected outright
  (`"department[0]" must be a number`). The ID has to be resolved first
  via a separate `GET .../jobs/filters` endpoint, which lists every
  department Millennium has ever posted under along with its name and
  live-job count. `millennium.js`'s `findDepartmentId()` does this
  lookup before every search.
- **Pagination appears to exist (a `nextPage` cursor in the response)
  but no working request parameter for it could be found** — every
  plausible body/query-string name (`after`, `cursor`, `page`,
  `pageToken`, `offset`, `skip`, etc.) was either rejected by strict
  schema validation or silently ignored, and the site's own "Show more"
  button didn't trigger a new network request even when clicked via
  Playwright with `force: true`. Turned out not to matter: filtering by
  department ID returns that single property's entire job list in one
  page regardless of the chain-wide total, so no pagination is needed in
  practice.
  Search API is `v3`, but the per-job detail API is `v2`
  (`/api/v2/accounts/.../jobs/{shortcode}`) — a version mismatch only
  found by intercepting network traffic while navigating a job's real
  public detail page, not by guessing from the search API's own version.
- **No structured pay field in the job detail response** — only
  free-text `description`/`requirements`/`benefits` fields, same
  situation as Omni/Accor/Aimbridge. No consistent unit-word suffix
  either (some postings say "/hr", most say nothing at all, including
  annual figures), so `parsePay()` uses the same magnitude heuristic as
  those brands: extract every dollar figure, take min/max, and treat
  $200+ as `annual`. Verified against ~15 real postings spanning both
  hourly and salaried roles with no stray/unrelated dollar-figure noise
  to filter out.
- **Closed/unpublished postings verified via a plain 404** on the detail
  endpoint for a fully removed shortcode, or a `state` field other than
  `"published"` for a real-but-unpublished requisition — both checked as
  the "verify before including" signal.

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
  — used to route scraping. `marriott`, `hilton`, and `hyatt` have
  scrapers built so far.
- `scrape`: `null` means "not automated" — either no scraper exists yet
  for the brand, or (see `scrapeNote`) the hotel doesn't post to its
  brand's corporate site at all (e.g. Courtyard Cambridge is
  Highgate-managed, Hyatt Centric Faneuil Hall is Magna
  Hospitality-managed). `propertyMatch` is usually a single string but
  may be an array of alias strings, for the rare case where one `data.json`
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
- Marriott brand (13): Aloft Boston Seaport, Courtyard by Marriott
  Downtown/North Station, Courtyard by Marriott East Boston (Logan),
  Courtyard by Marriott South Boston, Element Seaport Boston, Le Meridien
  Cambridge, Moxy Boston Downtown, Renaissance Boston Seaport,
  Ritz-Carlton Boston, Sheraton Boston, Sheraton Commander, W Boston,
  Westin Copley Place
- Hilton brand (7): DoubleTree Suites Boston-Cambridge, Hampton Inn
  Crosstown, Hampton Inn & Homewood Suites Seaport, Hilton Boston Back
  Bay, Hilton Boston Logan Airport, Hilton Boston Park Plaza, Hilton
  Garden Inn Boston Logan Airport. Three of these (Crosstown, Back Bay,
  Garden Inn Logan) had zero open postings as of the scraper's build date
  (2026-08-11), so their `scrape.propertyMatch` is a best-guess based on
  Hilton's naming convention for the other four (confirmed exact via live
  postings), not yet confirmed against a real listing — worth
  double-checking the first time one of them actually has a job posted.
- Hyatt brand (2 of 3 — see excluded list below): Hyatt Place Boston
  Seaport District, Hyatt Regency Boston.
- Omni brand (2): Omni Boston Hotel at the Seaport, Omni Parker House.
- Accor brand (2): Fairmont Copley Plaza, Raffles Boston — both were
  previously mislabeled `brand: "independent"`; see Key discoveries above.
- Aimbridge-managed (1): Westin Boston Seaport — still tagged
  `brand: "marriott"` (it's a real Westin), but its `scrape.source` is
  `"aimbridge"`: careers.marriott.com currently shows zero jobs for it,
  its real postings are on Aimbridge's site — see Key discoveries above.
- IHG brand (1): InterContinental Boston.
- Hotel AKA (2): Hotel AKA Back Bay, Hotel AKA Boston Common — small
  chain with its own careers site, not affiliated with any brand or
  management company scraped so far.
- Millennium-managed (1): Bostonian Hotel — still tagged
  `brand: "independent"` (no consumer-facing "Millennium" branding), but
  its `scrape.source` is `"millennium"`: it posts through Millennium
  Hotels & Resorts' own careers site rather than any aggregator or a
  site of its own — see Key discoveries above.

Whatever `data.json` currently shows for automated hotels is live as of
the last scrape run; this README won't try to track individual counts
for them since they update daily.

**Branded but excluded from scraping (third-party managed, doesn't post
to the brand's own corporate site):**
- Courtyard by Marriott Cambridge (Highgate-managed, doesn't post to
  careers.marriott.com — confirmed by hand, don't re-add without
  re-checking)
- Hyatt Centric Faneuil Hall Boston (Magna Hospitality-managed, doesn't
  appear in careers.hyatt.com's org search or property list; only found
  on excluded aggregators — see Key discoveries above, don't re-add
  without re-checking)

**Aimbridge scraper live, but only wired to one hotel so far:**
- Dagny Boston is confirmed Aimbridge-managed but currently has zero
  live postings to confirm its exact Aimbridge property name against;
  the same exhaustive nationwide check found zero postings for every
  other candidate hotel on the original "independent" list too, and
  independent research actively contradicts Aimbridge management for a
  few of them (Colonnade, Newbury Boston, Hotel Commonwealth). Add a
  `scrape: {source: "aimbridge", propertyMatch: "..."}` entry for a hotel
  once (a) its Aimbridge management is confirmed and (b) it has a live
  posting to confirm the property name against — and worth checking
  every *other* brand-flagged hotel already on the list too (see the
  Westin Boston Seaport discovery above) if its brand's own site is
  consistently returning zero jobs.

**Highgate-managed, no scraper built yet — still need to confirm:**
- Moxy Boston Downtown is Highgate-managed (confirmed via press coverage
  of its 2019 opening, and by the user directly) rather than posting to
  careers.marriott.com in its own right — `data.json` still has it tagged
  `scrape.source: "marriott"` as a "re-check automatically in case that
  changes" placeholder (see `scrapeNote`), which should be swapped for a
  real Highgate scraper once there's a live posting to build/confirm
  against. As of this pass, no live posting was found to confirm the
  exact property-name string.
- The Newbury Boston is also confirmed Highgate-managed (its own site
  states Highgate purchased and rebranded the property in 2018) —
  currently still tagged `brand: "independent"`/`scrape: null` on the
  "not yet automated" list below; worth confirming alongside Moxy rather
  than researching separately, since both would use the same scraper.
- Highgate's careers platform is iCIMS (a candidate ATS already on the
  radar — see next-steps below): a splash/intro page at
  `externalhourly-highgate.icims.com/jobs/intro` links out to
  `c-7242-20161032-highgate-com.i.icims.com`, but no working search
  endpoint (query-string keyword params, e.g. `?searchKeyword=moxy`) was
  found to return real results — likely because the actual job-search
  widget on this particular career-site build only populates via live UI
  interaction (autocomplete/click), the same problem hit early on with
  Hyatt. Not pursued further since neither Moxy nor Newbury currently has
  a live posting to test/confirm against anyway; revisit once one does.

**Not yet automated (no scraper built yet):**
- Independent/other, unconfirmed management (7): Battery Wharf,
  Colonnade, Copley Square, Encore Boston Harbor, Hotel Commonwealth,
  Lenox, Newbury Boston — worth a quick pass to check whether any of
  these are actually brand-affiliated (like Fairmont/Raffles turned out
  to be) or managed by Aimbridge, Millennium, or another management
  company (like Westin Boston Seaport, or like Hotel AKA turning out to
  run its own dedicated careers site) before assuming they're truly
  independent-independent.

## Next steps (pick up in roughly this order)
1. **Watch for the first live posting to confirm two known-but-unverified
   management relationships: Dagny Boston (Aimbridge) and Moxy Boston
   Downtown / The Newbury Boston (Highgate).** Both management companies
   are confirmed correct — what's missing in both cases is a live posting
   to confirm the exact property-name string (Aimbridge/Fountain) or a
   working search path plus a live posting (Highgate/iCIMS — see Key
   discoveries above for what's been tried and why it stalled) against.
   The Aimbridge scraper itself is confirmed working end-to-end against
   real live data elsewhere (it's already scraping Westin Boston Seaport
   daily); Highgate has no scraper built yet at all. Worth an occasional
   manual check of `careers.aimbridge.fountain.com/aimbridge` for "Dagny"
   and of Highgate's iCIMS career site for "Moxy"/"Newbury" or similar.
   Also worth spot-checking whether any *other* currently-automated
   hotel is quietly in the same situation Westin Boston Seaport was in
   (brand-flagged, but its own brand's site has gone to zero jobs while
   the real postings moved to Aimbridge, Highgate, or another management
   company) — that was found by chance, not by a systematic check.
2. Remaining hotels (7) — a re-check for brand *and* management-company
   affiliations before doing per-hotel research on whatever's genuinely
   independent (Fairmont and Raffles turned out to be mislabeled Accor
   properties; several others may be Aimbridge- or other-management-
   company-managed like Dagny; Hotel AKA and Millennium/Bostonian turned
   out to run their own/a third-party dedicated careers site rather than
   being truly independent — worth ruling all of these out before
   treating a hotel as one-off research).
   Worth checking each one for the ATS platform it runs on first (Oracle
   Recruiting Cloud, Oracle Taleo, Dayforce, Attrax, Fountain, UKG Pro
   Recruiting, Recruitee, Workday, iCIMS, etc. — see the
   Hilton/Hyatt/Omni/Accor/Aimbridge/IHG/Hotel AKA/Millennium discoveries
   above for what that can look like — two of eight so far turned out to
   share the same Oracle Recruiting Cloud infrastructure, worth checking
   for reuse before assuming a fresh build is needed) before assuming a
   Marriott-style DOM scrape is needed —
   though don't assume it *isn't* needed either; Accor's Attrax platform
   turned out to require full DOM scraping same as Marriott, despite
   looking modern.
3. Spot-check the career field classifier (`classifyDepartment()` in
   `hotel-jobs-map.html`) now that more brands' real job titles are
   flowing in — the keyword rules were tuned against the ~20 Marriott
   titles seen so far and will likely need new keywords (e.g.
   valet/laundry-specific titles) as coverage grows. Also worth deciding
   whether Hilton's and Hyatt's real scraped `category` values (see Data
   model) should be preferred over the keyword guess wherever present,
   the way the hand-curated Marriott `category` field already is.
   Consider whether "Other" should become a fourth filterable chip once
   there's enough volume in it to be useful.
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
  falling back to the hand-curated `category` text where present. Hilton,
  Hyatt, Accor, and IHG jobs do carry a real scraped `category` (e.g.
  "Housekeeping and Laundry", "Catering/Event Planning", "Food Beverage",
  "Hotel-Front Office" — Omni, Aimbridge, Hotel AKA, and Millennium are
  the other exceptions with no category, same as Marriott), but the classifier
  doesn't currently prefer it over the keyword guess — see next-steps
  item 2.
  Anything that doesn't match a rule (sales, events, security, management
  titles, etc.) is classified `Other` and is only visible when no
  career-field filter is applied.
- **Public transit overlay**: MBTA Red/Orange/Blue/Green(B/C/D/E)/Mattapan
  lines, toggleable per line. This is **static data** (real station
  coordinates connected in sequence, not live), because the MBTA v3 API
  isn't reachable from inside the artifact sandbox. Doesn't need
  updating — station locations don't move. Silver Line and Commuter Rail
  are NOT included.
- Dark "concierge desk" visual theme (navy/brass/cream, Fraunces +
  Inter + Space Mono fonts).
