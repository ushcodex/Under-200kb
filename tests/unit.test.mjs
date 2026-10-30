/* Unit tests for the pure helpers in app.js and the analytics classifiers. */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failures.push(name + ': ' + error.message);
  }
}

function equal(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}

/* app.js is an IIFE for the browser. Load its helper block in a sandbox that
   provides just enough globals, then read window.U200. */
const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const stubWindow = { addEventListener() {} };
const stubDocument = { readyState: 'loading', getElementById: () => null, querySelectorAll: () => [], addEventListener() {} };
const factory = new Function('window', 'document', 'navigator', 'URL', appSource + '\nreturn window.U200;');
const U200 = factory(stubWindow, stubDocument, { serviceWorker: undefined }, URL);

check('U200 helpers are exported', () => {
  if (!U200 || typeof U200.buildFilename !== 'function') throw new Error('missing helpers');
});

check('splitName keeps multiple dots', () => {
  equal(U200.splitName('my.file.name.v2.jpg'), { stem: 'my.file.name.v2', ext: 'jpg' });
});

check('splitName ignores dots at the start', () => {
  equal(U200.splitName('.gitignore'), { stem: '.gitignore', ext: '' });
});

check('splitName handles streams paths', () => {
  equal(U200.splitName('C:\\Users\\me\\Passport Photo.PNG'), { stem: 'Passport Photo', ext: 'png' });
});

check('image -> jpg keeps the stem', () => {
  equal(U200.buildFilename('passport.jpg', 'image', 'jpg'), 'passport-under200kb.jpg');
});

check('image -> pdf keeps the stem', () => {
  equal(U200.buildFilename('passport.JPEG', 'image', 'pdf'), 'passport-under200kb.pdf');
});

check('pdf -> pdf is marked compressed', () => {
  equal(U200.buildFilename('WAEC result.pdf', 'pdf', 'pdf'), 'WAEC result-compressed.pdf');
});

check('pdf -> jpg is marked compressed', () => {
  equal(U200.buildFilename('WAEC result.pdf', 'pdf', 'jpg'), 'WAEC result-compressed.jpg');
});

check('non-Latin names are preserved', () => {
  equal(U200.buildFilename('جواز-سفر.jpg', 'image', 'jpg'), 'جواز-سفر-under200kb.jpg');
  equal(U200.buildFilename('パスポート写真.png', 'image', 'pdf'), 'パスポート写真-under200kb.pdf');
  equal(U200.buildFilename('паспорт.jpg', 'image', 'jpg'), 'паспорт-under200kb.jpg');
  equal(U200.buildFilename('护照 照片.jpg', 'image', 'jpg'), '护照 照片-under200kb.jpg');
});

check('emoji / astral characters are not split', () => {
  equal(U200.buildFilename('📸 photo.jpg', 'image', 'jpg'), '📸 photo-under200kb.jpg');
});

check('unsafe filename characters are replaced', () => {
  equal(U200.buildFilename('a/b:c*d?e"f<g>h|i.jpg', 'image', 'jpg'), 'b c d e f g h i-under200kb.jpg');
});

check('empty or odd stems fall back to "file"', () => {
  equal(U200.buildFilename('', 'image', 'jpg'), 'file-under200kb.jpg');
  equal(U200.buildFilename('   ', 'image', 'jpg'), 'file-under200kb.jpg');
  equal(U200.buildFilename('.pdf', 'pdf', 'pdf'), 'pdf-compressed.pdf');
});

check('very long names are trimmed but keep a suffix', () => {
  const name = U200.buildFilename('x'.repeat(400) + '.jpg', 'image', 'pdf');
  if (!name.endsWith('-under200kb.pdf')) throw new Error('suffix lost: ' + name.slice(-30));
  if (name.length > 130) throw new Error('too long: ' + name.length);
});

check('formatKB reads naturally', () => {
  equal(U200.formatKB(500), '500 B'.replace('500 B', '0.5 KB'));
  equal(U200.formatKB(50 * 1024), '50 KB');
  equal(U200.formatKB(199.6 * 1024), '200 KB');
  equal(U200.formatKB(2.5 * 1024 * 1024), '2.50 MB');
});

check('clampKB validates the limit field', () => {
  equal(U200.clampKB('200'), { ok: true, kb: 200 });
  equal(U200.clampKB('25.5'), { ok: true, kb: 25.5 });
  equal(U200.clampKB(''), { ok: false, kb: 0 });
  equal(U200.clampKB('5').ok, false);
  equal(U200.clampKB('90000').kb, 20000);
});

/* ---- analytics classifiers ---- */
const analytics = require(path.join(root, 'api/_lib/analytics.js'));

check('referrer buckets', () => {
  equal(analytics.classifySource(''), 'direct');
  equal(analytics.classifySource('www.google.com'), 'google');
  equal(analytics.classifySource('google.co.uk'), 'google');
  equal(analytics.classifySource('chat.whatsapp.com'), 'social');
  equal(analytics.classifySource('t.co'), 'social');
  equal(analytics.classifySource('ushcodex.tech'), 'ushcodex');
  equal(analytics.classifySource('example.org'), 'referral');
});

check('device buckets', () => {
  equal(analytics.classifyDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'), 'mobile');
  equal(analytics.classifyDevice('Mozilla/5.0 (Linux; Android 13; Pixel 7 Pro) AppleWebKit Mobile'), 'mobile');
  equal(analytics.classifyDevice('Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X)'), 'tablet');
  equal(analytics.classifyDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), 'desktop');
  equal(analytics.classifyDevice('Googlebot/2.1 (+http://www.google.com/bot.html)'), 'bot');
});

check('country header is validated', () => {
  equal(analytics.classifyCountry({ headers: { 'x-vercel-ip-country': 'ng' } }), 'NG');
  equal(analytics.classifyCountry({ headers: {} }), 'XX');
  equal(analytics.classifyCountry({ headers: { 'x-vercel-ip-country': '<script>' } }), 'XX');
});

check('visitor hashes are salted and never contain the IP', () => {
  process.env.U200_ANALYTICS_SECRET = 'test-secret';
  const hash = analytics.visitorHash('203.0.113.9', 'UA', '2026-10-30');
  if (!/^[A-Za-z0-9_-]{22}$/.test(hash)) throw new Error('unexpected hash shape');
  if (hash.includes('203')) throw new Error('hash leaks the address');
  const other = analytics.visitorHash('203.0.113.9', 'UA', '2026-10-31');
  if (other === hash) throw new Error('hashes should rotate daily');
});

check('session tokens are signed and expire', () => {
  process.env.U200_ANALYTICS_SECRET = 'test-secret';
  const token = analytics.createSession();
  if (!analytics.verifySession(token)) throw new Error('valid token rejected');
  if (analytics.verifySession(token.slice(0, -2) + 'xx')) throw new Error('tampered token accepted');
  if (analytics.verifySession('nope')) throw new Error('garbage token accepted');
});

check('passwords compare in constant time', () => {
  process.env.U200_ANALYTICS_PASSWORD = 'hunter2';
  if (!analytics.checkPassword('hunter2')) throw new Error('correct password rejected');
  if (analytics.checkPassword('hunter3')) throw new Error('wrong password accepted');
  if (analytics.checkPassword('')) throw new Error('empty password accepted');
});

check('redis keys are namespaced', () => {
  const redis = require(path.join(root, 'api/_lib/redis.js'));
  equal(redis.PREFIX, 'u200kb:v1:');
  if (!redis.key('day', '2026-10-30').startsWith('u200kb:v1:')) throw new Error('bad namespace');
});

if (failures.length) {
  console.error('unit: ' + failures.length + ' failure(s)\n' + failures.map((f) => ' ✗ ' + f).join('\n'));
  process.exit(1);
}
console.log('unit: ' + passed + ' checks passed');
