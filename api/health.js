/* GET /api/health: a session-protected self check for the dashboard.
 *
 * Answers the one question the dashboard cannot guess: why counts are not
 * arriving. It probes the existing Upstash database inside this project's own
 * namespace (u200kb:v1:health:probe) and returns a short reason code, never a
 * secret, URL or token.
 */

'use strict';

const redis = require('./_lib/redis');
const analytics = require('./_lib/analytics');

const REASONS = {
  ok: 'Storage is connected and recording.',
  'not-configured': 'Add U200_ANALYTICS_REDIS_REST_URL and U200_ANALYTICS_REDIS_REST_TOKEN to this Vercel project, then redeploy.',
  'missing-url': 'U200_ANALYTICS_REDIS_REST_TOKEN is set but U200_ANALYTICS_REDIS_REST_URL is missing.',
  'missing-token': 'U200_ANALYTICS_REDIS_REST_URL is set but U200_ANALYTICS_REDIS_REST_TOKEN is missing.',
  'bad-url': 'The Redis URL must start with https:// and contain no spaces.',
  'bad-token': 'The Redis token contains whitespace or a line break.',
  'rejected-credentials': 'The database rejected the token. Copy the REST token again from Upstash.',
  'wrong-endpoint': 'That URL does not look like an Upstash REST endpoint.',
  'unreachable': 'The database host could not be reached from the function.',
  'rate-limited': 'The shared database is rate limiting requests right now.',
  'storage-unavailable': 'The database reported a server error.',
  'unexpected-response': 'The database answered in an unexpected way.',
  'write-not-persisted': 'The database accepted a write but did not return it.',
  'pipeline-failed': 'The batched write that records visits did not go through.',
  timeout: 'The database did not answer in time.',
  error: 'The database call failed for an unknown reason.'
};

// The probe costs four Redis commands, so keep a short-lived verdict warm.
let memo = { at: 0, value: null };
const MEMO_MS = 60 * 1000;

async function storageVerdict() {
  if (memo.value && Date.now() - memo.at < MEMO_MS) return memo.value;
  const value = await redis.diagnose();
  memo = { at: Date.now(), value: value };
  return value;
}

async function handler(req, res) {
  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET');
    res.end();
    return;
  }

  // The storage verdict is public: it contains no secrets and no visitor data,
  // so a broken deployment can be diagnosed without signing in.
  const storage = await storageVerdict();

  const cookies = analytics.parseCookies(req.headers.cookie);
  const signedIn = analytics.verifySession(cookies[analytics.SESSION_COOKIE]);
  const summary = {
    ok: true,
    storage: {
      configured: !redis.configProblem(),
      reachable: Boolean(storage.ok),
      reason: storage.reason,
      message: REASONS[storage.reason] || REASONS.error
    },
    checkedAt: new Date().toISOString()
  };

  if (!signedIn) return analytics.sendJson(res, 200, summary);

  let daysTracked = null;
  let lastSeen = null;
  if (storage.ok) {
    try {
      const days = await redis.command(['SMEMBERS', redis.key('days')], 2500);
      daysTracked = Array.isArray(days) ? days.length : 0;
      const last = await redis.command(['HGET', redis.key('meta'), 'last_seen'], 2000);
      lastSeen = last ? Number(last) : null;
    } catch (e) { /* the probe already told us what we need */ }
  }

  return analytics.sendJson(res, 200, {
    ok: true,
    storage: {
      configured: !redis.configProblem(),
      reachable: Boolean(storage.ok),
      reason: storage.reason,
      message: REASONS[storage.reason] || REASONS.error,
      namespace: redis.PREFIX
    },
    env: {
      password: Boolean(analytics.dashboardPassword()),
      secret: Boolean(analytics.secret()),
      searchConsole: Boolean(process.env.U200_GSC_SERVICE_ACCOUNT_JSON && process.env.U200_GSC_SITE)
    },
    counters: { daysTracked: daysTracked, lastSeen: lastSeen },
    checkedAt: new Date().toISOString()
  });
};

// Tests and operators can force a fresh probe.
handler.resetCache = function () {
  memo = { at: 0, value: null };
};

module.exports = handler;
