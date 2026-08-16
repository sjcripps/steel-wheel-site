#!/usr/bin/env node
/**
 * Headless-browser retry pass over the transload enrichment residue
 * (2026-08-14 crawl): bot-blocked URLs (403/429) + dead-status URLs
 * (404/5xx/dns/timeout/error/523/530). Runs real Chromium via playwright so
 * bot walls that reject plain urllib get a genuine browser fingerprint.
 *
 * Same contract as transload-enrich.py:
 *   - writes ONLY to enrich-results-headless.jsonl, never the dataset;
 *   - resumable (already-done URLs skipped);
 *   - tel: links preferred over regex text matches;
 *   - shared_domain carried over from the first pass (phone merge rules
 *     downstream stay identical).
 *
 * Run from /home/ubuntu/bots/assistant so `playwright` resolves.
 */
import { createRequire } from 'module';
import fs from 'fs';
// playwright lives in the assistant workspace, not this repo — resolve from there.
const { chromium } = createRequire('/home/ubuntu/bots/assistant/package.json')('playwright');

const DATA = '/home/ubuntu/projects/steel-wheel-site/tools/transload-directory/data';
const IN = `${DATA}/enrich-results.jsonl`;
const OUT = `${DATA}/enrich-results-headless.jsonl`;
const RETRY_STATUSES = new Set(['403', '429', '404', '500', '503', '523', '530',
                               'dns', 'timeout', 'error']);
const PAGE_TIMEOUT_MS = 25000;
const DELAY_MS = 2000;
const RELAUNCH_EVERY = 60;

const targets = [];
const done = new Set();
for (const line of fs.readFileSync(IN, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  try {
    const r = JSON.parse(line);
    if (RETRY_STATUSES.has(String(r.status))) targets.push(r);
  } catch {}
}
if (fs.existsSync(OUT)) {
  for (const line of fs.readFileSync(OUT, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { done.add(JSON.parse(line).url); } catch {}
  }
}
const todo = targets.filter(t => !done.has(t.url));
console.log(`targets=${targets.length} done=${done.size} todo=${todo.length}`);

const NANP = /(?<![\d.])(\(?\d{3}\)?[ .\-]\d{3}[ .\-]\d{4})(?![\d.])/;

let browser = null;
let context = null;
async function launch() {
  if (browser) await browser.close().catch(() => {});
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await context.route('**/*', (route) =>
    ['image', 'font', 'media'].includes(route.request().resourceType())
      ? route.abort() : route.continue());
}

async function probe(url) {
  const page = await context.newPage();
  try {
    const resp = await page.goto(url, { timeout: PAGE_TIMEOUT_MS,
                                        waitUntil: 'domcontentloaded' });
    const status = resp ? resp.status() : 'error';
    let phone = null;
    if (status >= 200 && status < 400) {
      // give trivial JS (cookie walls, late-rendered footers) a beat
      await page.waitForTimeout(1200);
      phone = await page.evaluate(() => {
        const a = document.querySelector('a[href^="tel:"]');
        return a ? a.getAttribute('href').slice(4).trim() : null;
      });
      if (!phone) {
        const text = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 400000) : '');
        const m = text.match(/(?<![\d.])(\(?\d{3}\)?[ .\-]\d{3}[ .\-]\d{4})(?![\d.])/);
        if (m) phone = m[1];
      }
    }
    return { status, phone };
  } catch (e) {
    const s = String(e.message || e).toLowerCase();
    if (s.includes('net::err_name_not_resolved')) return { status: 'dns', phone: null };
    if (s.includes('timeout')) return { status: 'timeout', phone: null };
    return { status: 'error', phone: null };
  } finally {
    await page.close().catch(() => {});
  }
}

await launch();
let n = 0;
for (const t of todo) {
  if (n > 0 && n % RELAUNCH_EVERY === 0) await launch();
  const { status, phone } = await probe(t.url);
  const rec = { url: t.url, status, phone,
                shared_domain: !!t.shared_domain, records: t.records || 1,
                prev_status: t.status };
  fs.appendFileSync(OUT, JSON.stringify(rec) + '\n');
  n += 1;
  if (n % 25 === 0) console.log(`  ${n}/${todo.length}`);
  await new Promise(r => setTimeout(r, DELAY_MS));
}
await browser.close().catch(() => {});
console.log(`DONE ${n} probed -> ${OUT}`);
