/* Shared helpers for the Under 200KB analytics API. */

'use strict';

const crypto = require('crypto');

const SESSION_COOKIE = 'u200_dash';
const SESSION_TTL_SECONDS = 60 * 60 * 8;

function secret() {
  return (process.env.U200_ANALYTICS_SECRET || process.env.U200_ANALYTICS_PASSWORD || '').trim();
}

function dashboardPassword() {
  return (process.env.U200_ANALYTICS_PASSWORD || '').trim();
}

function sign(value) {
  const key = secret();
  if (!key) return '';
  return crypto.createHmac('sha256', key).update(value).digest('base64url');
}

/** Constant-time comparison that never compares strings of different length. */
function safeEqual(a, b) {
  const left = crypto.createHash('sha256').update(String(a || '')).digest();
  const right = crypto.createHash('sha256').update(String(b || '')).digest();
  return crypto.timingSafeEqual(left, right);
}

function checkPassword(candidate) {
  const expected = dashboardPassword();
  if (!expected || !candidate) return false;
  return safeEqual(candidate, expected);
}

function createSession() {
  const payload = JSON.stringify({ exp: Date.now() + SESSION_TTL_SECONDS * 1000 });
  const encoded = Buffer.from(payload).toString('base64url');
  return encoded + '.' + sign(encoded);
}

function verifySession(tokenValue) {
  if (!tokenValue || typeof tokenValue !== 'string') return false;
  const parts = tokenValue.split('.');
  if (parts.length !== 2) return false;
  const expected = sign(parts[0]);
  if (!expected || !safeEqual(parts[1], expected)) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' && payload.exp > Date.now();
  } catch (e) {
    return false;
  }
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  String(header).split(';').forEach((pair) => {
    const index = pair.indexOf('=');
    if (index === -1) return;
    const name = pair.slice(0, index).trim();
    if (!name) return;
    out[name] = decodeURIComponent(pair.slice(index + 1).trim());
  });
  return out;
}

function sessionCookie(tokenValue, maxAgeSeconds) {
  const parts = [
    SESSION_COOKIE + '=' + tokenValue,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    'Max-Age=' + String(maxAgeSeconds)
  ];
  return parts.join('; ');
}

function clearCookie() {
  return SESSION_COOKIE + '=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0';
}

/** Salted, one-way identifier used for approximate uniques inside a HyperLogLog. */
function visitorHash(ip, userAgent, day) {
  const key = secret();
  if (!key) return null;
  return crypto
    .createHmac('sha256', key)
    .update(String(ip || '') + '|' + String(userAgent || '') + '|' + String(day || ''))
    .digest('base64url')
    .slice(0, 22);
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim();
  if (Array.isArray(forwarded) && forwarded.length) return String(forwarded[0]).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || '';
}

function sendJson(res, status, body, extraHeaders) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  if (extraHeaders) {
    Object.keys(extraHeaders).forEach((name) => res.setHeader(name, extraHeaders[name]));
  }
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  // Beacons may arrive as application/json, text/plain or a raw buffer.
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (Buffer.isBuffer(req.body)) {
    try { return JSON.parse(req.body.toString('utf8')); } catch (e) { return {}; }
  }
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch (e) { return {}; }
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8 * 1024) throw new Error('payload too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (e) {
    return {};
  }
}

/** Traffic-source bucket derived from the referrer host the browser reported. */
const SOURCE_DOMAINS = [
  ['google', ['google.com', 'google.co.uk', 'google.com.ng', 'googleusercontent.com']],
  ['bing', ['bing.com']],
  ['duckduckgo', ['duckduckgo.com']],
  ['yahoo', ['yahoo.com']],
  ['search-other', ['yandex.com', 'yandex.ru', 'baidu.com', 'ecosia.org', 'search.brave.com', 'brave.com', 'qwant.com', 'startpage.com']],
  ['social', ['wa.me', 'whatsapp.com', 't.me', 'telegram.org', 'facebook.com', 'fb.com', 'instagram.com', 'threads.net', 'twitter.com', 'x.com', 't.co', 'linkedin.com', 'lnkd.in', 'reddit.com', 'tiktok.com', 'snapchat.com', 'pinterest.com', 'youtube.com']],
  ['ushcodex', ['ushcodex.tech']],
  ['usman.engineer', ['usman.engineer']]
];

function hostMatches(host, domain) {
  return host === domain || host.endsWith('.' + domain);
}

function classifySource(host) {
  const h = String(host || '').toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  if (!h) return 'direct';
  for (let i = 0; i < SOURCE_DOMAINS.length; i += 1) {
    const bucket = SOURCE_DOMAINS[i][0];
    const domains = SOURCE_DOMAINS[i][1];
    for (let d = 0; d < domains.length; d += 1) {
      if (hostMatches(h, domains[d])) return bucket;
    }
  }
  // Any other google ccTLD or regional search host.
  if (/(^|\.)google\.[a-z.]{2,}$/.test(h)) return 'google';
  return 'referral';
}

function classifyDevice(userAgent) {
  const ua = String(userAgent || '').toLowerCase();
  if (!ua) return 'unknown';
  if (/ipad|tablet|playbook|silk|(android(?!.*mobile))/.test(ua)) return 'tablet';
  if (/mobi|iphone|ipod|android|blackberry|iemobile|opera mini/.test(ua)) return 'mobile';
  if (/bot|crawler|spider|headless|lighthouse|pingdom|monitor/.test(ua)) return 'bot';
  return 'desktop';
}

function classifyCountry(req) {
  const raw = String(req.headers['x-vercel-ip-country'] || '').toUpperCase();
  return /^[A-Z]{2}$/.test(raw) ? raw : 'XX';
}

function dayKey(date) {
  return date.toISOString().slice(0, 10);
}

module.exports = {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  secret,
  dashboardPassword,
  safeEqual,
  checkPassword,
  createSession,
  verifySession,
  parseCookies,
  sessionCookie,
  clearCookie,
  visitorHash,
  clientIp,
  sendJson,
  readJson,
  classifySource,
  classifyDevice,
  classifyCountry,
  dayKey
};
