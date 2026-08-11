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
import { scrapeMarriottLocation, fetchJobDetail, parsePay, propertyMatches } from './scrapers/marriott.js';

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
    const matches = allRaw.filter((j) => propertyMatches(j.propertyName, hotel.scrape.propertyMatch));
    const enriched = [];
    for (const m of matches) {
      const pay = parsePay(m.payText);
      const detail = await fetchJobDetail(page, m.url);
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

function diffHotelJobs(hotel, previousJobs, scrapedJobs, historyLines) {
  const prevByUrl = new Map(previousJobs.map((j) => [jobKey(j), j]));
  const newByUrl = new Map(scrapedJobs.map((j) => [jobKey(j), j]));

  const nextJobs = [];
  for (const [url, job] of newByUrl) {
    const prev = prevByUrl.get(url);
    const firstSeen = job.datePosted ? job.datePosted.slice(0, 10) : prev ? prev.firstSeen : today;
    const category = prev && prev.category ? prev.category : null;

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

  const prevMarriottTotal = marriottHotels.reduce((sum, h) => sum + h.jobs.length, 0);

  const browser = await chromium.launch();
  const page = await browser.newPage();

  let scrapedByHotel;
  try {
    scrapedByHotel = await scrapeMarriottBrand(page, marriottHotels);
  } finally {
    await browser.close();
  }

  const newMarriottTotal = [...scrapedByHotel.values()].reduce((sum, jobs) => sum + jobs.length, 0);

  if (newMarriottTotal === 0 && prevMarriottTotal > 0) {
    const report = {
      date: today,
      aborted: true,
      reason: `Marriott scrape returned 0 jobs across ${marriottHotels.length} tracked properties, but the previous run had ${prevMarriottTotal}. Treating this as a broken scraper (selector drift / site change / bot-block) rather than real data, and leaving data.json/history.jsonl untouched.`,
    };
    await fs.writeFile(REPORT_PATH, JSON.stringify(report, null, 2));
    console.error(report.reason);
    process.exitCode = 1;
    return;
  }

  const historyLines = [];
  const perHotelCounts = [];

  for (const hotel of data.hotels) {
    if (hotel.scrape && hotel.scrape.source === 'marriott') {
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
    totalJobsBefore: prevMarriottTotal,
    totalJobsAfter: newMarriottTotal,
    historyEventsWritten: historyLines.length,
    perHotelCounts,
    bigDrops: perHotelCounts.filter((c) => c.before >= 3 && c.after === 0),
  };
  await fs.writeFile(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main();
