/* GET /api/gsc: aggregate Google Search Console performance for the
 * Under 200KB property. Requires a signed-in dashboard session and an optional
 * read-only service account:
 *
 *   U200_GSC_SITE                   e.g. sc-domain:ushcodex.tech
 *   U200_GSC_SERVICE_ACCOUNT_JSON   the service account key (raw JSON or base64)
 *
 * Only site-level, aggregated search data is returned (query, clicks,
 * impressions, CTR, position). It is never joined to visit statistics, so the
 * dashboard cannot attribute a search term to an individual visitor.
 * When the env vars are absent the endpoint reports `configured: false`.
 */

'use strict';

const crypto = require('crypto');
const redis = require('./_lib/redis');
const analytics = require('./_lib/analytics');

const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CACHE_TTL = 6 * 60 * 60;
const WEBMASTER_SCOPE_CHECK = 400;

function serviceAccount() {
  const raw = (process.env.U200_GSC_SERVICE_ACCOUNT_JSON || '').trim();
  if (!raw) return null;
  try {
    const text = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    const parsed = JSON.parse(text);
    if (!parsed.client_email || !parsed.private_key) return null;
    return parsed;
  } catch (e) {
    return null;
  }
}

function propertyUrl() {
  return (process.env.U200_GSC_SITE || '').trim();
}

function signJwt(account) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claim = Buffer.from(JSON.stringify({
    iss: account.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600
  })).toString('base64url');
  const signature = crypto.createSign('RSA-SHA256').update(header + '.' + claim).sign(account.private_key).toString('base64url');
  return header + '.' + claim + '.' + signature;
}

async function accessToken(account) {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: signJwt(account)
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || 'Google token request failed');
  }
  return data.access_token;
}

function isoDate(daysAgo) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return date.toISOString().slice(0, 10);
}

async function query(token, site, startDate, endDate, dimensions, rowLimit) {
  const url = 'https://searchconsole.googleapis.com/webmasters/v3/sites/' + encodeURIComponent(site) + '/searchAnalytics/query';
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ startDate, endDate, dimensions, rowLimit: rowLimit || 25, dataState: 'all' })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = (data.error && data.error.message) || 'Search Console request failed';
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return data.rows || [];
}

async function buildReport() {
  const account = serviceAccount();
  const site = propertyUrl();
  if (!account || !site) return { ok: true, configured: false };

  const cacheKey = redis.key('cache', 'gsc');
  if (redis.configured()) {
    try {
      const cached = await redis.command(['GET', cacheKey], 1500);
      if (cached) return JSON.parse(cached);
    } catch (e) { /* recompute */ }
  }

  const startDate = isoDate(28);
  const endDate = isoDate(1);
  const token = await accessToken(account);
  const [queryRows, dateRows, pageRows] = await Promise.all([
    query(token, site, startDate, endDate, ['query'], 25),
    query(token, site, startDate, endDate, ['date'], 90),
    query(token, site, startDate, endDate, ['page'], 10)
  ]);

  const totals = queryRows.reduce((acc, row) => {
    acc.clicks += row.clicks || 0;
    acc.impressions += row.impressions || 0;
    return acc;
  }, { clicks: 0, impressions: 0 });

  const report = {
    ok: true,
    configured: true,
    site: site,
    startDate: startDate,
    endDate: endDate,
    totals: {
      clicks: Math.round(totals.clicks),
      impressions: Math.round(totals.impressions),
      ctr: totals.impressions ? totals.clicks / totals.impressions : 0,
      position: averagePosition(queryRows)
    },
    queries: queryRows.map((row) => ({
      query: row.keys && row.keys[0] ? row.keys[0] : '',
      clicks: Math.round(row.clicks || 0),
      impressions: Math.round(row.impressions || 0),
      ctr: row.ctr || 0,
      position: row.position || 0
    })),
    pages: pageRows.map((row) => ({
      page: row.keys && row.keys[0] ? row.keys[0] : '',
      clicks: Math.round(row.clicks || 0),
      impressions: Math.round(row.impressions || 0)
    })),
    daily: dateRows.map((row) => ({
      date: row.keys && row.keys[0] ? row.keys[0] : '',
      clicks: Math.round(row.clicks || 0),
      impressions: Math.round(row.impressions || 0)
    })),
    generatedAt: new Date().toISOString()
  };

  if (redis.configured()) {
    try {
      await redis.command(['SET', cacheKey, JSON.stringify(report), 'EX', String(CACHE_TTL)], 1500);
    } catch (e) { /* best effort */ }
  }
  return report;
}

function averagePosition(rows) {
  let weighted = 0;
  let impressions = 0;
  rows.forEach((row) => {
    weighted += (row.position || 0) * (row.impressions || 0);
    impressions += row.impressions || 0;
  });
  return impressions ? Math.round((weighted / impressions) * 10) / 10 : 0;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET');
    res.end();
    return;
  }
  const cookies = analytics.parseCookies(req.headers.cookie);
  if (!analytics.verifySession(cookies[analytics.SESSION_COOKIE])) {
    return analytics.sendJson(res, 401, { ok: false, error: 'Sign in required.' });
  }
  try {
    const report = await buildReport();
    return analytics.sendJson(res, 200, report);
  } catch (e) {
    const message = String(e.message || 'Search Console request failed');
    const friendly = WEBMASTER_SCOPE_CHECK && /permission|forbidden|not verified|403/i.test(message)
      ? 'The service account does not have access to this Search Console property yet.'
      : 'Search Console data could not be loaded right now.';
    return analytics.sendJson(res, 502, { ok: false, configured: true, error: friendly, detail: message.slice(0, 200) });
  }
};
