/* Real-browser end-to-end tests (Chromium via puppeteer-core).
 *
 * Not part of `npm test` because it needs a Chromium binary. Run it with:
 *   CHROME_PATH=/path/to/chrome node tests/browser.e2e.mjs
 * and a local server on PORT (default 3000) serving the repo.
 *
 * It exercises the real canvas encoder, the real jsPDF and pdf.js bundles,
 * offline reloads, filenames and mobile/desktop layout.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function optional(name) {
  for (const base of [process.env.E2E_DEPS, '/tmp/deps/node_modules', '']) {
    try { return base ? require(base + '/' + name) : require(name); } catch (e) { /* keep looking */ }
  }
  return null;
}
const puppeteer = optional('puppeteer-core');
if (!puppeteer) {
  console.error('puppeteer-core is required for the browser suite (set E2E_DEPS)');
  process.exit(2);
}

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'preview-password';
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const CHROME = process.env.CHROME_PATH;
if (!CHROME) {
  console.error('Set CHROME_PATH to a Chrome/Chromium binary');
  process.exit(2);
}

let passed = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); passed += 1; } catch (error) { failures.push(name + ': ' + error.message); }
}
function expect(condition, message) { if (!condition) throw new Error(message); }
function equal(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error((label || 'value') + ' expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'shell',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--font-render-hinting=none'],
  env: { ...process.env, LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH || '' }
});

const consoleErrors = [];

async function newPage(options = {}) {
  const page = await browser.newPage();
  await page.setViewport(options.viewport || { width: 1280, height: 900, deviceScaleFactor: 1 });
  await page.setUserAgent(options.userAgent || DESKTOP_UA);
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push('pageerror: ' + error.message));
  if (options.offlineFirst === false) await page.setOfflineMode(false);
  await page.goto(BASE + '/', { waitUntil: 'networkidle2' });
  return page;
}

async function readDownload(page) {
  return page.evaluate(async () => {
    const link = document.getElementById('download');
    const href = link.getAttribute('href');
    const response = await fetch(href);
    const buffer = new Uint8Array(await response.arrayBuffer());
    return { name: link.getAttribute('download'), size: buffer.length, bytes: Array.from(buffer.slice(0, 8)) };
  });
}

async function compress(page, { file, limit, format }) {
  const input = await page.$('#file');
  await input.uploadFile(file);
  await page.waitForSelector('#fileInfo:not([hidden])', { timeout: 15000 });
  if (format === 'pdf') await page.click('#fmtPdf');
  if (format === 'jpg') await page.click('#fmtJpg');
  await page.$eval('#size', (el, value) => { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); }, String(limit));
  await page.click('#go');
  await page.waitForSelector('#result:not([hidden])', { timeout: 60000 });
  await page.waitForFunction(() => {
    const link = document.getElementById('download');
    return link && link.getAttribute('href') && link.getAttribute('href').startsWith('blob:');
  }, { timeout: 30000 });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'u200kb-'));
async function copyWithName(source, name) {
  const target = path.join(tmp, name);
  fs.copyFileSync(path.join(root, 'tests/fixtures', source), target);
  return target;
}

/* ------------------------------------------------------------------ */
await check('image → JPG compresses a real photo under the limit', async () => {
  const page = await newPage();
  const file = await copyWithName('photo-large.jpg', 'holiday.photo.2026.jpg');
  await compress(page, { file, limit: 200, format: 'jpg' });
  const result = await readDownload(page);
  equal(result.name, 'holiday.photo.2026-under200kb.jpg', 'download name');
  expect(result.size <= 200 * 1024, 'output is ' + result.size + ' bytes, above the 200KB limit');
  expect(result.size > 1024, 'output looks empty');
  expect(result.bytes[0] === 0xff && result.bytes[1] === 0xd8, 'output is not a JPEG');
  const title = await page.$eval('#outSize', (el) => el.textContent);
  expect(/KB/.test(title), 'size label: ' + title);
  await page.screenshot({ path: path.join(tmp, 'desktop-result.png'), fullPage: true });
  await page.close();
});

await check('image → PDF produces a one-page PDF under the limit', async () => {
  const page = await newPage();
  const file = await copyWithName('photo-large.jpg', 'my passport.jpg');
  await compress(page, { file, limit: 100, format: 'pdf' });
  const result = await readDownload(page);
  equal(result.name, 'my passport-under200kb.pdf', 'download name');
  expect(result.size <= 100 * 1024, 'PDF is ' + result.size + ' bytes, above the 100KB limit');
  const header = await page.evaluate(() => document.getElementById('download').getAttribute('href'));
  expect(Boolean(header), 'missing blob url');
  const asText = Buffer.from(result.bytes).toString('latin1');
  expect(asText.startsWith('%PDF'), 'not a PDF: ' + asText);
  const pages = await page.evaluate(async () => {
    const lib = await import('/vendor/pdf.min.js').catch(() => null);
    if (!window.pdfjsLib) return null;
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.js';
    const link = document.getElementById('download');
    const data = new Uint8Array(await (await fetch(link.getAttribute('href'))).arrayBuffer());
    const pdf = await window.pdfjsLib.getDocument({ data }).promise;
    return pdf.numPages;
  });
  equal(pages, 1, 'page count');
  await page.close();
});

await check('PDF → JPG renders page one as an image', async () => {
  const page = await newPage();
  const file = await copyWithName('result-slip.pdf', 'JAMB.result.2026.pdf');
  const input = await page.$('#file');
  await input.uploadFile(file);
  await page.waitForFunction(() => document.getElementById('fileInfo') && !document.getElementById('fileInfo').hidden, { timeout: 15000 });
  await page.waitForFunction(() => document.getElementById('go') && document.getElementById('go').disabled === false, { timeout: 30000 });
  await page.waitForFunction(() => /PDF ready/.test(document.getElementById('status').textContent), { timeout: 20000 });
  await page.click('#fmtJpg');
  await page.$eval('#size', (el) => { el.value = '120'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.click('#go');
  await page.waitForSelector('#result:not([hidden])', { timeout: 60000 });
  await page.waitForFunction(() => (document.getElementById('download').getAttribute('href') || '').startsWith('blob:'));
  const result = await readDownload(page);
  equal(result.name, 'JAMB.result.2026-compressed.jpg', 'download name');
  expect(result.bytes[0] === 0xff && result.bytes[1] === 0xd8, 'not a JPEG');
  expect(result.size <= 120 * 1024, 'output is ' + result.size + ' bytes');
  const imageSize = await page.evaluate(async () => {
    const link = document.getElementById('download');
    const blob = await (await fetch(link.getAttribute('href'))).blob();
    const bitmap = await createImageBitmap(blob);
    return [bitmap.width, bitmap.height];
  });
  expect(imageSize[0] > 100 && imageSize[1] > 100, 'image looks empty: ' + imageSize);
  await page.close();
});

await check('multi-page PDFs explain that only page one is used', async () => {
  const page = await newPage();
  const file = await copyWithName('two-pages.pdf', 'certificate.pdf');
  const input = await page.$('#file');
  await input.uploadFile(file);
  await page.waitForFunction(() => (document.getElementById('status').textContent || '').includes('first page'), { timeout: 30000 });
  await page.close();
});

await check('transparent PNG gets a white background', async () => {
  const page = await newPage();
  const file = await copyWithName('passport-transparent.png', 'passport photo.png');
  await compress(page, { file, limit: 200, format: 'jpg' });
  const data = await page.evaluate(async () => {
    const link = document.getElementById('download');
    const blob = await (await fetch(link.getAttribute('href'))).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    return Array.from(ctx.getImageData(2, 2, 1, 1).data);
  });
  expect(data[0] > 240 && data[1] > 240 && data[2] > 240, 'corner should be white, got ' + data.join(','));
  equal(data[3], 255, 'alpha');
  await page.close();
});

async function uploadNamedInPage(page, fixture, name) {
  const bytes = Array.from(fs.readFileSync(path.join(root, 'tests/fixtures', fixture)));
  await page.evaluate((name, bytes) => {
    const file = new File([new Uint8Array(bytes)], name, { type: 'image/jpeg' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const input = document.getElementById('file');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, name, bytes);
  await page.waitForSelector('#fileInfo:not([hidden])', { timeout: 15000 });
}

await check('non-Latin filenames survive the round trip', async () => {
  const page = await newPage();
  await uploadNamedInPage(page, 'photo-large.jpg', 'جواز السفر.jpg');
  equal(await page.$eval('#fileName', (el) => el.textContent), 'جواز السفر.jpg', 'file name shown');
  await page.click('#fmtJpg');
  await page.click('#go');
  await page.waitForSelector('#result:not([hidden])', { timeout: 60000 });
  const result = await readDownload(page);
  equal(result.name, 'جواز السفر-under200kb.jpg', 'download name');
  await page.close();
});

await check('CJK and Cyrillic names are preserved too', async () => {
  const page = await newPage();
  await uploadNamedInPage(page, 'passport-transparent.png', 'パスポート写真.v2.png');
  await page.click('#fmtPdf');
  await page.click('#go');
  await page.waitForSelector('#result:not([hidden])', { timeout: 60000 });
  equal((await readDownload(page)).name, 'パスポート写真.v2-under200kb.pdf', 'download name');
  await page.close();
});

await check('the download name is stable across repeated runs', async () => {
  const page = await newPage();
  const file = await copyWithName('photo-large.jpg', 'waec.result.2026.jpeg');
  await compress(page, { file, limit: 150, format: 'pdf' });
  const first = (await readDownload(page)).name;
  await page.click('#again');
  await page.waitForFunction(() => document.getElementById('result').hidden === true);
  await compress(page, { file, limit: 150, format: 'pdf' });
  const second = (await readDownload(page)).name;
  equal(first, second, 'names should be deterministic');
  equal(first, 'waec.result.2026-under200kb.pdf', 'name');
  await page.close();
});

await check('mobile layout has no sideways scroll and large enough controls', async () => {
  const page = await newPage({ viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true } });
  const metrics = await page.evaluate(() => {
    const controls = [...document.querySelectorAll('button, input[type=number], input[type=file], .format-opt, .preset')];
    const small = controls
      .map((el) => ({ id: el.id || el.className, height: Math.round(el.getBoundingClientRect().height) }))
      .filter((item) => item.height > 0 && item.height < 44);
    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      small
    };
  });
  expect(metrics.scrollWidth <= metrics.clientWidth + 1, 'horizontal overflow: ' + JSON.stringify(metrics));
  equal(metrics.small, [], 'controls below 44px');
  await page.screenshot({ path: path.join(tmp, 'mobile.png'), fullPage: true });
  await page.close();
});

await check('desktop layout shows the two-column tool', async () => {
  const page = await newPage({ viewport: { width: 1280, height: 900 } });
  const columns = await page.evaluate(() => getComputedStyle(document.getElementById('toolForm')).gridTemplateColumns.split(' ').length);
  equal(columns, 2, 'expected two columns');
  await page.close();
});

await check('keyboard users can reach and operate the tool', async () => {
  const page = await newPage();
  const order = [];
  for (let i = 0; i < 8; i += 1) {
    await page.keyboard.press('Tab');
    order.push(await page.evaluate(() => {
      const active = document.activeElement;
      return active ? (active.id || active.tagName.toLowerCase()) : 'none';
    }));
  }
  expect(order.includes('file'), 'file input should be reachable by keyboard: ' + order.join(' → '));
  const ring = await page.evaluate(() => {
    const input = document.getElementById('file');
    input.focus();
    const zone = document.getElementById('dropzone');
    const style = getComputedStyle(zone);
    return style.outlineStyle + '|' + style.outlineWidth;
  });
  expect(!/none\|0px/.test(ring), 'focus should be visible on the dropzone: ' + ring);
  await page.close();
});

await check('result is announced to screen readers and focus is managed', async () => {
  const page = await newPage();
  const file = await copyWithName('photo-large.jpg', 'form.jpg');
  await compress(page, { file, limit: 200, format: 'jpg' });
  const state = await page.evaluate(() => ({
    status: document.getElementById('status').textContent,
    focused: document.activeElement && document.activeElement.id,
    live: document.getElementById('status').getAttribute('aria-live')
  }));
  expect(/Done\./.test(state.status), 'status message: ' + state.status);
  equal(state.live, 'polite', 'aria-live');
  equal(state.focused, 'resultHeading', 'focus should move to the result heading');
  await page.close();
});

await check('limits that cannot be met are explained', async () => {
  const page = await newPage();
  const file = await copyWithName('photo-large.jpg', 'huge.jpg');
  await compress(page, { file, limit: 20, format: 'pdf' });
  const warning = await page.evaluate(() => ({ hidden: document.getElementById('resultWarn').hidden, text: document.getElementById('resultWarn').textContent }));
  expect(!warning.hidden, 'expected a warning');
  expect(/smallest version|still above/.test(warning.text), 'warning text: ' + warning.text);
  await page.close();
});

await check('service worker installs and the app works offline', async () => {
  const page = await newPage();
  await page.evaluate(() => navigator.serviceWorker.ready);
  const active = await page.evaluate(() => navigator.serviceWorker.controller !== null || navigator.serviceWorker.ready.then(() => true));
  expect(active !== false, 'service worker not active');
  await page.setOfflineMode(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  const heading = await page.$eval('h1', (el) => el.textContent.trim());
  expect(/Any file/i.test(heading), 'offline page missing heading');
  const styles = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  equal(styles, 'rgb(247, 246, 242)', 'offline styles should load');
  await page.setOfflineMode(false);
  await page.close();
});

await check('a new service worker version replaces the old cache', async () => {
  const page = await newPage();
  await page.evaluate(() => navigator.serviceWorker.ready);
  const caches = await page.evaluate(() => window.caches.keys());
  expect(caches.includes('u200kb-v3'), 'expected u200kb-v3 cache, saw ' + caches.join(','));
  expect(!caches.includes('under200kb-v2'), 'old cache should be removed');
  await page.close();
});

await check('analytics requests stay on the same origin and never include file data', async () => {
  const page = await newPage();
  const requests = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/collect')) requests.push(request.postData() || '');
  });
  const file = await copyWithName('photo-large.jpg', 'private-name.jpg');
  await compress(page, { file, limit: 200, format: 'jpg' });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  expect(requests.length > 0, 'no analytics beacon was sent');
  requests.forEach((body) => {
    expect(!body.includes('private-name'), 'file name leaked: ' + body);
    expect(!body.includes('image/jpeg;base64'), 'file contents leaked');
  });
  await page.close();
});

await check('a real visit and compression are counted by the server', async () => {
  const page = await newPage();
  const readTotals = () => page.evaluate(async (password) => {
    const response = await fetch('/api/stats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: password, range: '7' })
    });
    if (!response.ok) return null;
    const body = await response.json();
    return body.ok ? { totals: body.totals, directions: body.directions || [] } : null;
  }, DASHBOARD_PASSWORD);
  const before = await readTotals();

  // A fresh page load should book a visit.
  const visitor = await newPage();
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const afterVisit = await readTotals();
  await visitor.close();
  expect(before && afterVisit, 'dashboard payload unavailable');
  expect(afterVisit.totals.visits > before.totals.visits, 'visits did not increase: ' + before.totals.visits + ' -> ' + afterVisit.totals.visits);

  // A compression should book an action.
  const file = await copyWithName('photo-large.jpg', 'counted.jpg');
  await compress(page, { file, limit: 200, format: 'jpg' });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const afterWork = await readTotals();
  expect(afterWork.totals.ok > afterVisit.totals.ok, 'compressions did not increase: ' + afterVisit.totals.ok + ' -> ' + afterWork.totals.ok);
  expect(afterWork.directions.some((row) => row.name === 'image-jpg'), 'direction not recorded');
  await page.close();
});

await check('the privacy dialog opens, saves and closes from the UI', async () => {
  const page = await newPage({ viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true } });
  await page.click('#privacyOpen');
  await page.waitForFunction(() => document.getElementById('privacyDialog').open === true, { timeout: 5000 });
  await page.click('#optout');
  await page.click('#privacySave');
  const saved = await page.$eval('#privacySaved', (el) => ({ hidden: el.hidden, text: el.textContent }));
  expect(!saved.hidden && /Saved/.test(saved.text), 'confirmation missing: ' + JSON.stringify(saved));
  const stored = await page.evaluate(() => localStorage.getItem('u200kb-analytics-optout'));
  equal(stored, '1', 'preference stored');
  await page.screenshot({ path: path.join(tmp, 'privacy-dialog.png') });
  await page.click('#privacyClose');
  await page.waitForFunction(() => document.getElementById('privacyDialog').open === false, { timeout: 5000 });
  const footer = await page.$eval('#privacyState', (el) => el.textContent);
  expect(/off/.test(footer), 'footer state: ' + footer);
  await page.close();
});

await check('dashboard blocks anonymous readers', async () => {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const response = await page.goto(BASE + '/api/stats?range=30');
  equal(response.status(), 401, 'status');
  const robots = await page.goto(BASE + '/dashboard');
  const meta = await page.$eval('meta[name="robots"]', (el) => el.content);
  expect(/noindex/.test(meta), 'dashboard should be noindex');
  await page.close();
  await context.close();
});

await check('no console errors anywhere', async () => {
  const meaningful = consoleErrors.filter((message) => !/favicon|_vercel\/insights|ERR_INTERNET_DISCONNECTED/.test(message));
  equal(meaningful, [], 'console errors');
});

await browser.close();

console.log('browser: ' + passed + ' checks passed' + (failures.length ? ', ' + failures.length + ' failed' : ''));
console.log('screenshots: ' + tmp);
if (failures.length) {
  console.error(failures.map((f) => ' ✗ ' + f).join('\n'));
  process.exit(1);
}
