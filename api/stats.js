/* /api/stats — the private Under 200KB dashboard feed.
 *
 * POST { password }  -> verifies the dashboard password, sets an HttpOnly
 *                       session cookie and returns the current range.
 * GET  ?range=7|30|90|all (with cookie) -> aggregate JSON.
 * POST { logout: true } -> clears the session.
 *
 * Reads only the u200kb:v1:* namespace and never writes outside it.
 */

'use strict';

const redis = require('./_lib/redis');
const analytics = require('./_lib/analytics');

const RANGES = { '7': 7, '30': 30, '90': 90, all: 0 };
const MAX_DAYS = 1500;
const CACHE_TTL = 180;
const LOGIN_WINDOW_SECONDS = 900;
const LOGIN_MAX_ATTEMPTS = 8;

const memoryLimits = new Map();

async function rateLimit(ip) {
  const bucket = redis.key('rl', analytics.visitorHash(ip, 'dashboard-login', 'static') || 'anon');
  if (redis.configured()) {
    try {
      const results = await redis.pipeline([['INCR', bucket], ['TTL', bucket]], 1500);
      const count = Number(results[0] || 0);
      if (count === 1) await redis.command(['EXPIRE', bucket, String(LOGIN_WINDOW_SECONDS)], 1500);
      return count <= LOGIN_MAX_ATTEMPTS;
    } catch (e) {
      // fall through to the in-memory guard
    }
  }
  const now = Date.now();
  const entry = memoryLimits.get(bucket) || { count: 0, reset: now + LOGIN_WINDOW_SECONDS * 1000 };
  if (now > entry.reset) {
    entry.count = 0;
    entry.reset = now + LOGIN_WINDOW_SECONDS * 1000;
  }
  entry.count += 1;
  memoryLimits.set(bucket, entry);
  return entry.count <= LOGIN_MAX_ATTEMPTS;
}

function emptyDay(date) {
  return { date: date, visits: 0, uniques: 0, ok: 0, fail: 0, downloads: 0, files: 0, bots: 0, devices: {}, sources: {}, countries: {}, directions: {}, targets: {} };
}

function bump(map, name, value) {
  if (!name) return;
  map[name] = (map[name] || 0) + value;
}

function applyHash(day, hash) {
  if (!hash || typeof hash !== 'object') return;
  for (let i = 0; i < hash.length; i += 2) {
    const field = String(hash[i]);
    const value = Number(hash[i + 1]) || 0;
    if (field === 'pv') day.visits += value;
    else if (field === 'bots') day.bots += value;
    else if (field === 'a:compress_ok') day.ok += value;
    else if (field === 'a:compress_fail') day.fail += value;
    else if (field === 'a:download') day.downloads += value;
    else if (field === 'a:file_image' || field === 'a:file_pdf') day.files += value;
    else if (field.startsWith('dev:')) bump(day.devices, field.slice(4), value);
    else if (field.startsWith('src:')) bump(day.sources, field.slice(4), value);
    else if (field.startsWith('c:')) bump(day.countries, field.slice(2), value);
    else if (field.startsWith('dir:')) bump(day.directions, field.slice(4), value);
    else if (field.startsWith('tgt:')) bump(day.targets, field.slice(4), value);
  }
}

function sortMap(map) {
  return Object.keys(map)
    .map((name) => ({ name, count: map[name] }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function mergeMaps(target, source) {
  Object.keys(source).forEach((name) => bump(target, name, source[name]));
}

async function buildStats(rangeKey) {
  const cacheKey = redis.key('cache', 'stats', rangeKey);
  if (redis.configured()) {
    try {
      const cached = await redis.command(['GET', cacheKey], 1500);
      if (cached) return JSON.parse(cached);
    } catch (e) { /* recompute below */ }
  }

  const dayNames = (await redis.command(['SMEMBERS', redis.key('days')], 2500)) || [];
  const allDays = dayNames.filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name)).sort();
  const wanted = RANGES[rangeKey] || 0;
  const truncated = wanted === 0 && allDays.length > MAX_DAYS;
  const selected = wanted > 0 ? allDays.slice(-wanted) : allDays.slice(-MAX_DAYS);

  const daily = [];
  for (let i = 0; i < selected.length; i += 80) {
    const slice = selected.slice(i, i + 80);
    const rows = await redis.pipeline(slice.map((date) => ['HGETALL', redis.key('day', date)]), 4000);
    slice.forEach((date, index) => {
      const day = emptyDay(date);
      applyHash(day, rows[index]);
      daily.push(day);
    });
  }

  let rangeUniques = 0;
  if (selected.length) {
    try {
      const uvKeys = selected.slice(0, 1000).map((date) => redis.key('uv', date));
      rangeUniques = Number(await redis.command(['PFCOUNT'].concat(uvKeys), 3000)) || 0;
    } catch (e) {
      rangeUniques = 0;
    }
  }

  const totals = { visits: 0, uniques: rangeUniques, ok: 0, fail: 0, downloads: 0, files: 0, bots: 0 };
  const devices = {};
  const sources = {};
  const countries = {};
  const directions = {};
  const targets = {};
  daily.forEach((day) => {
    totals.visits += day.visits;
    totals.ok += day.ok;
    totals.fail += day.fail;
    totals.downloads += day.downloads;
    totals.files += day.files;
    totals.bots += day.bots;
    mergeMaps(devices, day.devices);
    mergeMaps(sources, day.sources);
    mergeMaps(countries, day.countries);
    mergeMaps(directions, day.directions);
    mergeMaps(targets, day.targets);
    delete day.devices;
    delete day.sources;
    delete day.countries;
    delete day.directions;
    delete day.targets;
  });

  let meta = null;
  try {
    const raw = await redis.command(['HGETALL', redis.key('meta')], 1500);
    if (Array.isArray(raw)) {
      meta = {};
      for (let i = 0; i < raw.length; i += 2) meta[String(raw[i])] = raw[i + 1];
    }
  } catch (e) { /* optional */ }

  const result = {
    ok: true,
    generatedAt: new Date().toISOString(),
    range: {
      key: rangeKey,
      days: wanted || allDays.length,
      from: selected.length ? selected[0] : null,
      to: selected.length ? selected[selected.length - 1] : null,
      trackingSince: allDays.length ? allDays[0] : null,
      totalDaysTracked: allDays.length,
      truncated: truncated
    },
    totals: totals,
    devices: sortMap(devices),
    sources: sortMap(sources),
    countries: sortMap(countries),
    directions: sortMap(directions),
    targets: sortMap(targets),
    daily: daily,
    lastSeen: meta && meta.last_seen ? Number(meta.last_seen) : null
  };

  if (redis.configured() && selected.length > 5) {
    try {
      await redis.command(['SET', cacheKey, JSON.stringify(result), 'EX', String(CACHE_TTL)], 1500);
    } catch (e) { /* caching is best-effort */ }
  }
  return result;
}

module.exports = async function handler(req, res) {
  if (!redis.configured()) {
    return analytics.sendJson(res, 503, { ok: false, error: 'Analytics is not configured on this deployment.' });
  }

  const cookies = analytics.parseCookies(req.headers.cookie);
  const session = cookies[analytics.SESSION_COOKIE];
  const ip = analytics.clientIp(req);

  if (req.method === 'POST') {
    let body = {};
    try { body = await analytics.readJson(req); } catch (e) { body = {}; }

    if (body.logout) {
      res.setHeader('Set-Cookie', analytics.clearCookie());
      return analytics.sendJson(res, 200, { ok: true, signedOut: true });
    }

    const provided = typeof body.password === 'string' ? body.password : '';
    const allowed = await rateLimit(ip);
    if (!allowed) {
      return analytics.sendJson(res, 429, { ok: false, error: 'Too many attempts. Try again in 15 minutes.' });
    }
    if (!analytics.checkPassword(provided)) {
      return analytics.sendJson(res, 401, { ok: false, error: 'That password does not match.' });
    }

    const rangeKey = RANGES[body.range] !== undefined ? String(body.range) : '30';
    res.setHeader('Set-Cookie', analytics.sessionCookie(analytics.createSession(), analytics.SESSION_TTL_SECONDS));
    try {
      const data = await buildStats(rangeKey);
      return analytics.sendJson(res, 200, data);
    } catch (e) {
      return analytics.sendJson(res, 502, { ok: false, error: 'Analytics storage did not respond.' });
    }
  }

  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET, POST');
    res.end();
    return;
  }

  if (!analytics.verifySession(session)) {
    return analytics.sendJson(res, 401, { ok: false, error: 'Sign in required.' });
  }

  const rangeKey = RANGES[req.query && req.query.range] !== undefined ? String(req.query.range) : '30';
  try {
    const data = await buildStats(rangeKey);
    return analytics.sendJson(res, 200, data);
  } catch (e) {
    return analytics.sendJson(res, 502, { ok: false, error: 'Analytics storage did not respond.' });
  }
};
