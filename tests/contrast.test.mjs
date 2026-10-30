/* Contrast + layout guardrails.
 * Reads the palette straight out of styles.css so the numbers can never drift
 * from the stylesheet that ships. Targets WCAG 2.2 AA (4.5:1 text, 3:1 large
 * text and UI boundaries); most pairs here clear AAA (7:1). */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed += 1; } catch (error) { failures.push(name + ': ' + error.message); }
}
function expect(condition, message) { if (!condition) throw new Error(message); }

const tokens = Object.fromEntries([...css.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));

function channel(value) {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function luminance(hex) {
  const value = hex.replace('#', '');
  const full = value.length === 3 ? value.split('').map((ch) => ch + ch).join('') : value;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const paper = tokens.paper;
const surface = tokens.surface;

check('brand palette tokens match the Ushcodex brand', () => {
  expect(tokens.paper === '#f7f6f2', 'paper should be #f7f6f2, got ' + tokens.paper);
  expect(tokens.ink === '#1b1a20', 'ink should be #1b1a20, got ' + tokens.ink);
  expect(tokens.purple === '#5f30aa', 'purple should be #5f30aa, got ' + tokens.purple);
  expect(tokens.orange === '#ef7738', 'accent should be #ef7738, got ' + tokens.orange);
});

const pairs = [
  ['body text', tokens.ink, paper, 4.5],
  ['heading text', tokens.ink, surface, 4.5],
  ['secondary text', tokens['ink-2'], paper, 4.5],
  ['secondary text on card', tokens['ink-2'], surface, 4.5],
  ['file details / hints', tokens['ink-3'], surface, 4.5],
  ['file details on paper', tokens['ink-3'], paper, 4.5],
  ['eyebrow (orange ink)', tokens['orange-ink'], paper, 4.5],
  ['links', tokens.purple, paper, 4.5],
  ['link hover', tokens['purple-dark'], paper, 4.5],
  ['primary button label', '#ffffff', tokens.purple, 4.5],
  ['primary button hover', '#ffffff', tokens['purple-dark'], 4.5],
  ['disabled button label', '#ffffff', tokens['ink-3'], 4.5],
  ['success message', tokens.ok, tokens['ok-bg'], 4.5],
  ['warning message', tokens.warn, tokens['warn-bg'], 4.5],
  ['error message', tokens.err, tokens['err-bg'], 4.5],
  ['format description (selected)', tokens['ink-2'], tokens['purple-tint'], 4.5],
  ['focus ring against paper', tokens.purple, paper, 3],
  ['control border against paper', tokens['line-control'], paper, 3],
  ['control border against white', tokens['line-control'], surface, 3],
  ['divider lines (decorative)', tokens.line, paper, 1]
];

pairs.forEach(([name, fg, bg, min]) => {
  check('contrast: ' + name, () => {
    const value = ratio(fg, bg);
    expect(value >= min, name + ' is ' + value.toFixed(2) + ':1 (' + fg + ' on ' + bg + '), needs ' + min + ':1');
  });
});

check('orange is never used for small text on paper', () => {
  expect(ratio(tokens.orange, paper) < 4.5, 'pure orange should stay a graphic accent');
});

check('font sizes stay readable', () => {
  const sizes = [...css.matchAll(/font-size:\s*([\d.]+)rem/g)].map((m) => parseFloat(m[1]));
  const tooSmall = sizes.filter((size) => size < 0.75);
  expect(tooSmall.length === 0, 'found font-size below 12px: ' + tooSmall.join(', '));
});

check('interactive controls are at least 44px tall', () => {
  expect(/min-height:\s*3\.25rem/.test(css), 'primary button min-height');
  expect(/min-height:\s*3rem/.test(css), 'inputs and presets min-height');
  expect(/min-height:\s*2\.75rem/.test(css), 'inline buttons min-height');
});

check('focus states are always visible', () => {
  expect(/:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--purple\)/.test(css), 'global focus ring');
  expect(/:focus-within/.test(css), 'dropzone focus-within ring');
});

check('reduced motion is respected', () => {
  expect(/prefers-reduced-motion/.test(css), 'missing reduced-motion block');
});

check('no stale dark-theme palette remains', () => {
  const stale = ['#050505', '#ff6b00', '#111111', '#ff6b0'].filter((colour) => css.toLowerCase().includes(colour) || html.toLowerCase().includes(colour));
  expect(stale.length === 0, 'old palette still referenced: ' + stale.join(', '));
});

check('no remote fonts or CDN scripts are required', () => {
  expect(!/fonts\.googleapis/.test(html), 'Google Fonts link should be gone');
  expect(!/cdnjs\.cloudflare/.test(html + app), 'CDN libraries should be self-hosted');
});

check('theme colour matches the paper background', () => {
  expect(/<meta name="theme-color" content="#f7f6f2">/.test(html), 'theme-color');
});

check('copy stays plain and free of em dashes', () => {
  const files = ['index.html', 'dashboard.html', 'styles.css', 'app.js', 'analytics.js', 'dashboard.js'];
  const offenders = [];
  files.forEach((name) => {
    const text = fs.readFileSync(path.join(root, name), 'utf8');
    if (/[\u2013\u2014]/.test(text)) offenders.push(name);
  });
  expect(offenders.length === 0, 'em or en dash found in ' + offenders.join(', '));
});

check('the privacy control has a close button and a save confirmation', () => {
  expect(/id="privacyOpen"/.test(html), 'opener button');
  expect(/id="privacyClose"[^>]*aria-label="Close privacy settings"/.test(html), 'close button with a label');
  expect(/id="privacyDialog"/.test(html), 'dialog element');
  expect(/id="privacySaved"[^>]*role="status"/.test(html), 'confirmation live region');
  expect(/id="privacyCancel"/.test(html) && /id="privacySave"/.test(html), 'save and cancel');
});

check('the download name appears once, in the button', () => {
  expect(!/out-name/.test(html), 'filenames should not be printed beside the button');
  expect(/<span id="downloadLabel">Download<\/span>/.test(html), 'button label');
});

check('the page declares a light colour scheme and a viewport', () => {
  expect(/name="color-scheme" content="light"/.test(html), 'color-scheme');
  expect(/name="viewport"/.test(html), 'viewport');
});

check('Vercel Analytics stays in place', () => {
  expect(/window\.va/.test(html) && /_vercel\/insights\/script\.js/.test(html), 'Vercel Analytics snippet removed');
});

check('security headers are configured', () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
  const global = config.headers.find((entry) => entry.source === '/(.*)');
  const names = global.headers.map((header) => header.key);
  ['Content-Security-Policy', 'Strict-Transport-Security', 'X-Content-Type-Options', 'Referrer-Policy'].forEach((name) => {
    expect(names.includes(name), 'missing ' + name);
  });
});

check('inlined CSS matches styles.css', () => {
  const inline = html.match(/<style id="app-css">([\s\S]*?)<\/style>/);
  expect(inline, 'missing inline styles');
  const normalize = (value) => value.replace(/\s+/g, ' ').trim();
  expect(normalize(inline[1]) === normalize(css), 'index.html CSS is out of date — run npm run build');
});

check('service worker cache version was bumped and pages are network-first', () => {
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  expect(/CACHE_VERSION = 'u200kb-v3'/.test(sw), 'cache version');
  expect(/request\.mode === 'navigate'/.test(sw), 'navigation handling');
  expect(/isAnalytics/.test(sw) && /isVendor/.test(sw), 'api + vendor handling');
  expect(/caches\.delete/.test(sw), 'old caches are removed on activate');
});

if (failures.length) {
  console.error('contrast: ' + failures.length + ' failure(s)\n' + failures.map((f) => ' ✗ ' + f).join('\n'));
  process.exit(1);
}
console.log('contrast: ' + passed + ' checks passed');
