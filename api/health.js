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

async function storageVerdict(fresh) {
  if (!fresh && memo.value && Date.now() - memo.at < MEMO_MS) return memo.value;
  const value = await redis.diagnose();
  memo = { at: Date.now(), value: value };
  return value;
}

/** When did the counter endpoint last record anything? One small read. */
async function receiverStatus(storage) {
  if (!storage.ok) return { received: false, lastWriteAt: null, lastEvent: null };
  try {
    const raw = await redis.command(['HGETALL', redis.key('rx')], 2000);
    const fields = {};
    if (Array.isArray(raw)) {
      for (let i = 0; i < raw.length; i += 2) fields[String(raw[i])] = raw[i + 1];
    }
    const at = Number(fields.at || 0) || null;
    return {
      received: Boolean(at),
      lastWriteAt: at ? new Date(at).toISOString() : null,
      lastEvent: fields.event || null
    };
  } catch (e) {
    return { received: false, lastWriteAt: null, lastEvent: null, reason: redis.describeError(e) };
  }
}

/* Deletes one counter key that is holding the wrong Redis type.
 * Signed in only, one key only, and only inside this project's namespace.
 * That is a targeted repair, never a reset. */
async function repair(req, res) {
  if (!analytics.verifySession(analytics.parseCookies(req.headers.cookie)[analytics.SESSION_COOKIE])) {
    return analytics.sendJson(res, 401, { ok: false, error: 'Sign in required.' });
  }
  let body = {};
  try { body = await analytics.readJson(req); } catch (e) { body = {}; }
  if (!body || body.action !== 'repair') {
    return analytics.sendJson(res, 400, { ok: false, error: 'Unknown action.' });
  }
  let key = '';
  try {
    const note = await redis.command(['HGET', redis.key('health', 'lastfail'), 'key'], 2000);
    key = String(note || '');
  } catch (e) {
    return analytics.sendJson(res, 502, { ok: false, error: 'Could not read the failure note.' });
  }
  if (!key || !/^u200kb:v1:[A-Za-z0-9:_-]{1,80}$/.test(key)) {
    return analytics.sendJson(res, 400, { ok: false, error: 'There is no repairable key.' });
  }
  try {
    await redis.command(['DEL', key], 2500);
    await redis.command(['DEL', redis.key('health', 'lastfail')], 2000);
  } catch (e) {
    return analytics.sendJson(res, 502, { ok: false, error: 'The delete did not go through.' });
  }
  memo = { at: 0, value: null };
  return analytics.sendJson(res, 200, { ok: true, removed: key });
}

async function handler(req, res) {
  if (req.method === 'POST') return repair(req, res);
  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET, POST');
    res.end();
    return;
  }

  // The storage verdict is public: it contains no secrets and no visitor data,
  // so a broken deployment can be diagnosed without signing in.
  // ?fresh=1 skips the 60 s memo so a test event can be checked immediately.
  const fresh = /(\?|&)fresh=1(&|$)/.test(String(req.url || ''));
  const storage = await storageVerdict(fresh);

  const cookies = analytics.parseCookies(req.headers.cookie);
  const signedIn = analytics.verifySession(cookies[analytics.SESSION_COOKIE]);
  const receiver = await receiverStatus(storage);
  const summary = {
    ok: true,
    storage: {
      configured: !redis.configProblem(),
      reachable: Boolean(storage.ok),
      reason: storage.reason,
      message: REASONS[storage.reason] || REASONS.error
    },
    receiver: receiver,
    checkedAt: new Date().toISOString()
  };

  if (!signedIn) return analytics.sendJson(res, 200, summary);

  let daysTracked = null;
  let lastSeen = null;
  let lastFailure = null;
  if (storage.ok) {
    try {
      const days = await redis.command(['SMEMBERS', redis.key('days')], 2500);
      daysTracked = Array.isArray(days) ? days.length : 0;
      const last = await redis.command(['HGET', redis.key('meta'), 'last_seen'], 2000);
      lastSeen = last ? Number(last) : null;
      const note = await redis.command(['HGETALL', redis.key('health', 'lastfail')], 2000);
      if (Array.isArray(note) && note.length) {
        const fields = {};
        for (let i = 0; i < note.length; i += 2) fields[String(note[i])] = note[i + 1];
        lastFailure = {
          at: fields.at ? new Date(Number(fields.at)).toISOString() : null,
          event: fields.event || null,
          command: fields.command || null,
          key: fields.key || null,
          reason: redis.describeError({ message: fields.error || '' })
        };
      }
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
    receiver: receiver,
    counters: { daysTracked: daysTracked, lastSeen: lastSeen },
    lastFailure: lastFailure,
    checkedAt: new Date().toISOString()
  });
};

// Tests and operators can force a fresh probe.
handler.resetCache = function () {
  memo = { at: 0, value: null };
};

module.exports = handler;
