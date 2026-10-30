/* UI tests: loads the real page in jsdom with a stubbed canvas/encoder, then
   drives the JPG, PDF and PDF→JPG flows the way a user would. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const analyticsSource = fs.readFileSync(path.join(root, 'analytics.js'), 'utf8');

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
  } catch (error) {
    failures.push(name + ': ' + error.message);
  }
}
function expect(condition, message) { if (!condition) throw new Error(message); }
function equal(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error((label || 'value') + ' expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}
const wait = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

/* Build a page with a deterministic fake canvas pipeline. */
function buildPage(options = {}) {
  const dom = new JSDOM(html, { url: 'https://under200kb.ushcodex.tech/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const doc = window.document;
  const events = [];

  let qualitySeen = [];
  const blobSizes = options.blobSizes || null; // optional size schedule

  const canvasProto = window.HTMLCanvasElement.prototype;
  canvasProto.getContext = function () {
    return {
      fillStyle: '#000',
      fillRect() {},
      drawImage() {},
      getImageData() { return { data: new Uint8ClampedArray(4) }; },
      putImageData() {},
      save() {}, restore() {}, translate() {}, rotate() {}, scale() {}, beginPath() {}, closePath() {},
      moveTo() {}, lineTo() {}, stroke() {}, fill() {}
    };
  };
  canvasProto.toBlob = function (callback, type, quality) {
    qualitySeen.push(quality);
    let size;
    if (blobSizes) size = blobSizes(Math.min(blobSizes.length - 1, qualitySeen.length - 1));
    else size = Math.round(1400 * 1024 * (quality || 0.9)); // ~1.26MB at q=0.9
    const blob = new window.Blob([new Uint8Array(Math.min(size, 512))], { type: type || 'image/jpeg' });
    Object.defineProperty(blob, 'size', { value: size });
    callback(blob);
  };
  canvasProto.toDataURL = function () { return 'data:image/jpeg;base64,AAAA'; };

  window.URL.createObjectURL = (blob) => 'blob:under200kb/' + (blob && blob.size ? blob.size : 'file') + '-' + Math.random().toString(36).slice(2, 8);
  window.URL.revokeObjectURL = () => {};

  class FakeImage {
    constructor() {
      this.naturalWidth = 0;
      this.naturalHeight = 0;
      setTimeout(() => {
        this.naturalWidth = 3000;
        this.naturalHeight = 2000;
        this.width = 3000;
        this.height = 2000;
        if (this.onload) this.onload();
      }, 0);
    }
  }
  window.Image = FakeImage;

  // Auto-resolve lazily injected vendor scripts with fakes.
  const originalAppend = window.document.head.appendChild.bind(window.document.head);
  window.document.head.appendChild = (node) => {
    const result = originalAppend(node);
    if (node && node.tagName === 'SCRIPT') {
      const src = String(node.src || '');
      setTimeout(() => {
        if (src.includes('jspdf')) {
          window.jspdf = {
            jsPDF: function (config) {
              this.config = config;
              this.addImage = () => {};
              this.output = () => {
                const pdf = new window.Blob([new Uint8Array(24)], { type: 'application/pdf' });
                Object.defineProperty(pdf, 'size', { value: options.pdfSize || 180 * 1024 });
                return pdf;
              };
            }
          };
        }
        if (node.onload) node.onload();
      }, 0);
    }
    return result;
  };

  window.eval(analyticsSource);
  const realTrack = window.u200Track;
  // Capture what the tool asks to track (the real client allow-lists and sends).
  window.u200Track = (event, data) => events.push({ event, data });
  window.eval(appSource);

  return { dom, window, doc, events, realTrack, qualitySeen: () => qualitySeen };
}

function downloadName(page) {
  return page.doc.getElementById('download').getAttribute('download');
}

function selectFile(page, file) {
  const input = page.doc.getElementById('file');
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new page.window.Event('change', { bubbles: true }));
}

/* ------------------------------------------------------------------ */
await check('page shell is accessible', async () => {
  const page = buildPage();
  const { doc } = page;
  equal(doc.documentElement.lang, 'en', 'lang');
  expect(doc.querySelector('h1'), 'missing h1');
  const skip = doc.querySelector('.skip');
  expect(skip && doc.querySelector(skip.getAttribute('href')), 'skip link target missing');
  expect(doc.getElementById('toolForm'), 'missing form');
  const imgs = [...doc.querySelectorAll('img')];
  imgs.forEach((img) => expect(img.hasAttribute('alt'), 'image without alt: ' + img.outerHTML.slice(0, 80)));
  expect(doc.getElementById('fileError').getAttribute('role') === 'alert', 'file error should be an alert');
  expect(doc.getElementById('status').getAttribute('role') === 'status', 'status should be a live region');
  expect(doc.getElementById('file').getAttribute('accept'), 'accept attribute');
});

await check('every form control has an accessible name', async () => {
  const page = buildPage();
  const { doc } = page;
  const controls = [...doc.querySelectorAll('input, select, button, a[href]')];
  controls.forEach((control) => {
    if (control.type === 'hidden') return;
    const id = control.id;
    const label = id ? doc.querySelector('label[for="' + id + '"]') : null;
    const wrapped = control.closest('label');
    const text = (control.textContent || '').trim();
    const aria = control.getAttribute('aria-label');
    const name = label || wrapped || aria || (control.closest('a') && control.closest('a').textContent.trim()) || text;
    expect(Boolean(name), 'control without a name: ' + control.outerHTML.slice(0, 90));
  });
});

await check('format choice is labelled with conversion directions', async () => {
  const page = buildPage();
  const { doc } = page;
  const jpg = doc.getElementById('fmtJpg').closest('label').textContent.replace(/\s+/g, ' ').trim();
  const pdf = doc.getElementById('fmtPdf').closest('label').textContent.replace(/\s+/g, ' ').trim();
  expect(/JPG image/i.test(jpg) && /picture/i.test(jpg), 'JPG option should say it produces a picture: ' + jpg);
  expect(/PDF document/i.test(pdf) && /document/i.test(pdf), 'PDF option should say it produces a document: ' + pdf);
  expect(!/page/i.test(jpg + pdf), 'the format list must not talk about pages: ' + jpg + pdf);
  // The destination line stays quiet until a file makes the direction concrete.
  equal(doc.getElementById('formatHelp').hidden, true, 'no redundant static sentence');
});

await check('image selection previews the file and explains the destination', async () => {
  const page = buildPage();
  const { doc, window } = page;
  const file = new window.File([new Uint8Array(800 * 1024)], 'my.passport.photo.jpg', { type: 'image/jpeg' });
  selectFile(page, file);
  await wait();
  equal(doc.getElementById('fileInfo').hidden, false, 'file info should show');
  equal(doc.getElementById('fileName').textContent, 'my.passport.photo.jpg', 'file name');
  expect(/800 KB/.test(doc.getElementById('fileSize').textContent), 'size shown: ' + doc.getElementById('fileSize').textContent);
  expect(doc.getElementById('fmtJpg').checked, 'images should default to JPG output');
  expect(/stays a JPG/.test(doc.getElementById('formatHelp').textContent), 'destination hint: ' + doc.getElementById('formatHelp').textContent);
  doc.getElementById('fmtPdf').checked = true;
  doc.getElementById('fmtPdf').dispatchEvent(new window.Event('change', { bubbles: true }));
  expect(/becomes a PDF/.test(doc.getElementById('formatHelp').textContent), 'destination hint after switching');
});

await check('image → JPG produces a recognisable name and a download', async () => {
  const page = buildPage();
  const { doc, window, events } = page;
  const file = new window.File([new Uint8Array(1200 * 1024)], 'my.passport.photo.jpg', { type: 'image/jpeg' });
  selectFile(page, file);
  await wait();
  doc.getElementById('size').value = '200';
  doc.getElementById('fmtJpg').checked = true;
  doc.getElementById('toolForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await wait(120);

  const name = downloadName(page);
  equal(name, 'my.passport.photo-under200kb.jpg', 'download name');
  equal(doc.getElementById('downloadLabel').textContent, 'Download ' + name, 'name appears in the button');
  equal(doc.querySelectorAll('.out-name').length, 0, 'the name must not be printed twice');
  expect(/^blob:/.test(doc.getElementById('download').getAttribute('href') || ''), 'download href');
  equal(doc.getElementById('result').hidden, false, 'result visible');
  expect(/KB|MB/.test(doc.getElementById('outSize').textContent), 'new size shown');
  const ok = events.filter((e) => e.event === 'compress');
  equal(ok.length, 1, 'one analytics event');
  equal(ok[0].data.k, 'ok', 'success recorded');
  equal(ok[0].data.d, 'image-jpg', 'direction recorded');
  expect(!JSON.stringify(events).includes('passport'), 'analytics must never carry file names');
});

await check('image → PDF wraps the image and names it .pdf', async () => {
  const page = buildPage();
  const { doc, window, events } = page;
  const file = new window.File([new Uint8Array(900 * 1024)], 'scan 01.png', { type: 'image/png' });
  selectFile(page, file);
  await wait();
  doc.getElementById('fmtPdf').checked = true;
  doc.getElementById('size').value = '100';
  doc.getElementById('toolForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await wait(200);
  equal(downloadName(page), 'scan 01-under200kb.pdf', 'pdf name');
  equal(doc.getElementById('downloadLabel').textContent, 'Download scan 01-under200kb.pdf', 'button label');
  const event = events.find((e) => e.event === 'compress');
  equal(event.data.d, 'image-pdf', 'direction recorded');
});

await check('PDF → JPG uses the first page and the compressed suffix', async () => {
  const page = buildPage();
  const { doc, window, events } = page;
  window.pdfjsLib = {
    GlobalWorkerOptions: {},
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: 1,
        getPage: () => Promise.resolve({
          getViewport: () => ({ width: 1200, height: 1600 }),
          render: () => ({ promise: Promise.resolve() })
        })
      })
    })
  };
  const file = new window.File([new Uint8Array(400 * 1024)], 'JAMB.result.2026.pdf', { type: 'application/pdf' });
  selectFile(page, file);
  await wait(120);
  equal(doc.getElementById('go').disabled, false, 'compress button should re-enable once the preview is ready');
  expect(doc.getElementById('fmtPdf').checked, 'a PDF input should default to PDF output');
  doc.getElementById('fmtJpg').checked = true;
  doc.getElementById('fmtJpg').dispatchEvent(new window.Event('change', { bubbles: true }));
  doc.getElementById('toolForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await wait(200);
  equal(downloadName(page), 'JAMB.result.2026-compressed.jpg', 'pdf→jpg name');
  const event = events.find((e) => e.event === 'compress');
  equal(event.data.d, 'pdf-jpg', 'direction recorded');
  expect(/becomes a JPG/.test(doc.getElementById('formatHelp').textContent), 'destination hint');
});

await check('PDF → PDF keeps the compressed suffix', async () => {
  const page = buildPage();
  const { doc, window } = page;
  window.pdfjsLib = {
    GlobalWorkerOptions: {},
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: 2,
        getPage: () => Promise.resolve({
          getViewport: () => ({ width: 800, height: 1000 }),
          render: () => ({ promise: Promise.resolve() })
        })
      })
    })
  };
  const file = new window.File([new Uint8Array(200 * 1024)], 'certificate.v1.pdf', { type: 'application/pdf' });
  selectFile(page, file);
  await wait(120);
  expect(/first page/i.test(doc.getElementById('status').textContent), 'multi-page PDF should be explained: ' + doc.getElementById('status').textContent);
  equal(doc.getElementById('goLabel').textContent, 'Compress file', 'label restored');
  doc.getElementById('fmtPdf').checked = true;
  doc.getElementById('toolForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await wait(200);
  equal(downloadName(page), 'certificate.v1-compressed.pdf', 'pdf→pdf name');
});

await check('quality steps down until the limit is met', async () => {
  const page = buildPage({ blobSizes: () => 400 * 1024 });
  const { doc, window } = page;
  const file = new window.File([new Uint8Array(1024)], 'big.jpg', { type: 'image/jpeg' });
  selectFile(page, file);
  await wait();
  doc.getElementById('size').value = '50';
  doc.getElementById('fmtJpg').checked = true;
  doc.getElementById('toolForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await wait(200);
  expect(page.qualitySeen().length > 5, 'expected several quality passes, saw ' + page.qualitySeen().length);
  expect(page.qualitySeen()[1] < page.qualitySeen()[0], 'quality must decrease');
  expect(!doc.getElementById('resultWarn').hidden, 'a warning should explain the unmet limit');
  expect(/still above/i.test(doc.getElementById('resultWarn').textContent), 'warning wording');
});

await check('invalid limits are rejected before compression', async () => {
  const page = buildPage();
  const { doc, window } = page;
  const file = new window.File([new Uint8Array(1024)], 'a.jpg', { type: 'image/jpeg' });
  selectFile(page, file);
  await wait();
  doc.getElementById('size').value = '2';
  doc.getElementById('toolForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await wait(50);
  equal(doc.getElementById('fileError').hidden, false, 'error shown');
  expect(/between 20 KB and 20000 KB/.test(doc.getElementById('fileError').textContent), 'error text');
  equal(doc.getElementById('result').hidden, true, 'no result');
});

await check('unsupported files are refused politely', async () => {
  const page = buildPage();
  const { doc, window, events } = page;
  const file = new window.File([new Uint8Array(10)], 'notes.txt', { type: 'text/plain' });
  selectFile(page, file);
  await wait(30);
  expect(/isn’t supported/.test(doc.getElementById('fileError').textContent), 'error message');
  equal(events.length, 0, 'no analytics for rejected files');
});

await check('pressing compress with no file focuses the picker', async () => {
  const page = buildPage();
  const { doc, window } = page;
  doc.getElementById('toolForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await wait(30);
  expect(/Choose a file first/.test(doc.getElementById('fileError').textContent), 'error text');
  equal(doc.activeElement.id, 'file', 'focus should move to the file input');
});

await check('preset buttons update the limit and pressed state', async () => {
  const page = buildPage();
  const { doc, window } = page;
  const button = doc.querySelector('.preset[data-kb="100"]');
  button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  equal(doc.getElementById('size').value, '100', 'limit value');
  equal(button.getAttribute('aria-pressed'), 'true', 'pressed state');
  equal(doc.querySelector('.preset[data-kb="200"]').getAttribute('aria-pressed'), 'false', 'other presets unpressed');
});

await check('start over resets the tool', async () => {
  const page = buildPage();
  const { doc, window } = page;
  const file = new window.File([new Uint8Array(1024)], 'x.jpg', { type: 'image/jpeg' });
  selectFile(page, file);
  await wait(20);
  doc.getElementById('toolForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await wait(150);
  doc.getElementById('again').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(30);
  equal(doc.getElementById('result').hidden, true, 'result hidden');
  equal(doc.getElementById('fileInfo').hidden, true, 'file cleared');
  equal(doc.getElementById('download').getAttribute('aria-disabled'), 'true', 'download disabled');
  equal(doc.activeElement.id, 'file', 'focus back on the picker');
});

await check('privacy panel opens, saves and confirms', async () => {
  const page = buildPage();
  const { doc, window } = page;
  const dialog = doc.getElementById('privacyDialog');
  equal(dialog.hasAttribute('open'), false, 'dialog starts closed');

  doc.getElementById('privacyOpen').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(10);
  equal(doc.getElementById('privacyDialog').open || doc.getElementById('privacyDialog').hasAttribute('open'), true, 'dialog opens');
  equal(doc.getElementById('privacySaved').hidden, true, 'no confirmation before saving');

  const toggle = doc.getElementById('optout');
  equal(toggle.checked, false, 'counts on by default');
  toggle.checked = true;
  equal(window.localStorage.getItem('u200kb-analytics-optout'), null, 'nothing saved until Save is pressed');

  doc.getElementById('privacySave').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(10);
  equal(window.localStorage.getItem('u200kb-analytics-optout'), '1', 'preference stored on save');
  equal(doc.getElementById('privacySaved').hidden, false, 'confirmation shown');
  expect(/Saved\./.test(doc.getElementById('privacySaved').textContent), 'confirmation wording: ' + doc.getElementById('privacySaved').textContent);
  expect(/off/.test(doc.getElementById('privacySaved').textContent), 'confirmation states the outcome');

  doc.getElementById('privacyClose').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(10);
  equal(doc.getElementById('privacyDialog').open || doc.getElementById('privacyDialog').hasAttribute('open'), false, 'close button closes the dialog');
  const status = doc.getElementById('status').textContent || '';
  expect(!/Anonymous/i.test(status), 'no analytics state text left in the page status: ' + status);
});

await check('privacy cancel discards an unsaved change', async () => {
  const page = buildPage();
  const { doc, window } = page;
  window.localStorage.setItem('u200kb-analytics-optout', '1');
  doc.getElementById('privacyOpen').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(10);
  const toggle = doc.getElementById('optout');
  equal(toggle.checked, true, 'reflects the saved choice when opened');
  toggle.checked = false;
  doc.getElementById('privacyCancel').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(10);
  equal(window.localStorage.getItem('u200kb-analytics-optout'), '1', 'saved choice is unchanged after cancel');
  equal(doc.getElementById('privacyDialog').open || doc.getElementById('privacyDialog').hasAttribute('open'), false, 'dialog closed');
});

await check('privacy panel can be reopened and cleared for the next decision', async () => {
  const page = buildPage();
  const { doc, window } = page;
  doc.getElementById('privacyOpen').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(10);
  doc.getElementById('privacySave').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(10);
  equal(doc.getElementById('privacySaved').hidden, false, 'confirmation after first save');
  doc.getElementById('privacyClose').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(10);
  doc.getElementById('privacyOpen').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(10);
  equal(doc.getElementById('privacySaved').hidden, true, 'confirmation resets for the next visit');
});

await check('supported file types are listed in the footer, not in the dropzone', async () => {
  const page = buildPage();
  const { doc } = page;
  const hint = doc.getElementById('dzHint').textContent;
  expect(/Image or PDF/i.test(hint), 'dropzone hint should be short: ' + hint);
  expect(!/JPG|PNG|WebP/i.test(hint), 'the dropzone should not list formats: ' + hint);
  const footer = doc.querySelector('footer').textContent.replace(/\s+/g, ' ');
  expect(/JPG, PNG, WebP, GIF, BMP, AVIF and PDF/.test(footer), 'footer should list supported types: ' + footer);
});

await check('pages are only mentioned for multi-page PDFs', async () => {
  const page = buildPage();
  const { doc, window } = page;
  const image = new window.File([new Uint8Array(2048)], 'photo.jpg', { type: 'image/jpeg' });
  selectFile(page, image);
  await wait(20);
  const visibleCopy = [
    doc.querySelector('.lede').textContent,
    doc.getElementById('dzHint').textContent,
    doc.getElementById('formatHelp').textContent,
    [...doc.querySelectorAll('.format-desc')].map((el) => el.textContent).join(' '),
    doc.querySelector('footer').textContent
  ].join(' ');
  expect(!/one-page|single-page|first page|page one/i.test(visibleCopy), 'no page talk for images: ' + visibleCopy);
  expect(!/page/i.test(doc.getElementById('formatHelp').textContent), 'format help should not mention pages');

  window.pdfjsLib = {
    GlobalWorkerOptions: {},
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: 3,
        getPage: () => Promise.resolve({
          getViewport: () => ({ width: 600, height: 800 }),
          render: () => ({ promise: Promise.resolve() })
        })
      })
    })
  };
  const pdf = new window.File([new Uint8Array(1024)], 'scan.pdf', { type: 'application/pdf' });
  selectFile(page, pdf);
  await wait(120);
  expect(/3 pages/.test(doc.getElementById('formatHelp').textContent), 'multi-page hint: ' + doc.getElementById('formatHelp').textContent);
  expect(/Only the first page/.test(doc.getElementById('formatHelp').textContent), 'only the first page is used');
});

await check('page copy is tight and free of em dashes', async () => {
  const page = buildPage();
  const { doc } = page;
  const text = doc.body.textContent.replace(/\s+/g, ' ').trim();
  expect(!text.includes('\u2014'), 'em dash found in body copy');
  expect(!text.includes('\u2013'), 'en dash found in body copy');
  expect(!/Ushcodex Technologies · Free tool/i.test(text), 'the eyebrow line should be gone');
  expect(!/Download name/i.test(text), 'the filename should not be printed beside the button');
  expect(!/Anonymous counts/i.test(text), 'no analytics state text in the page body');
  expect(!/one-page|single-page/i.test(text), 'no page-count wording in the page body');
  const words = text.split(' ').filter(Boolean).length;
  expect(words < 190, 'the page carries too much copy: ' + words + ' words');
  const downloadLabels = (text.match(/under200kb\./g) || []).length;
  equal(downloadLabels, 0, 'no filename placeholder in the initial page copy');
});

await check('analytics survives GPC, DNT and blocked storage', async () => {
  const page = buildPage();
  const { window, realTrack } = page;
  const sent = [];
  window.navigator.sendBeacon = (url) => { sent.push(url); return true; };
  window.navigator.globalPrivacyControl = true;
  realTrack('view', {});
  window.navigator.globalPrivacyControl = false;
  window.navigator.doNotTrack = '1';
  realTrack('view', {});
  window.navigator.doNotTrack = null;
  window.localStorage.setItem('u200kb-analytics-optout', '1');
  realTrack('view', {});
  equal(sent.length, 0, 'no analytics requests under privacy signals');
  window.localStorage.removeItem('u200kb-analytics-optout');
  // Malformed input must not throw.
  realTrack('BAD EVENT', { k: 'ok' });
  realTrack(null);
  realTrack('compress', { d: '../../etc/passwd', k: 'passport.jpg' });
  equal(sent.length, 0, 'invalid payloads are dropped');
});

await check('analytics client allow-lists payload fields', async () => {
  const page = buildPage();
  const { window, realTrack } = page;
  const bodies = [];
  window.navigator.sendBeacon = (url, blob) => { bodies.push({ url, blob }); return true; };
  realTrack('compress', { k: 'ok', d: 'image-pdf', t: 200, b: '<=200', ms: '1-3s', filename: 'secret.pdf' });
  expect(bodies.length === 1, 'beacon sent');
  equal(bodies[0].url, '/api/collect', 'endpoint');
  const text = await bodies[0].blob.text();
  const payload = JSON.parse(text);
  equal(payload.e, 'compress', 'event');
  equal(payload.d, 'image-pdf', 'direction kept');
  expect(!text.includes('secret'), 'file name stripped: ' + text);
});

await check('failing analytics never breaks compression', async () => {
  const page = buildPage();
  const { doc, window } = page;
  window.u200Track = () => { throw new Error('analytics exploded'); };
  const file = new window.File([new Uint8Array(1024)], 'ok.jpg', { type: 'image/jpeg' });
  selectFile(page, file);
  await wait();
  doc.getElementById('toolForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await wait(150);
  equal(doc.getElementById('result').hidden, false, 'compression still completes');
  equal(downloadName(page), 'ok-under200kb.jpg', 'name still correct');
});

console.log('ui: ' + passed + ' checks passed' + (failures.length ? ', ' + failures.length + ' failed' : ''));
if (failures.length) {
  console.error(failures.map((f) => ' ✗ ' + f).join('\n'));
  process.exit(1);
}
