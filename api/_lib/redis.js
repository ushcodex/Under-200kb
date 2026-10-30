/* Minimal Upstash Redis REST client for Under 200KB.
 *
 * The team shares one Upstash database between several sites, so every key this
 * project touches lives under a dedicated prefix and nothing here ever lists,
 * scans or flushes keys outside it. Environment variables are project-scoped and
 * separate from the Ushcodex site's (USH_*) configuration.
 */

'use strict';

const PREFIX = 'u200kb:v1:';

function endpoint() {
  return (process.env.U200_ANALYTICS_REDIS_REST_URL || '').trim().replace(/\/+$/, '');
}

function token() {
  return (process.env.U200_ANALYTICS_REDIS_REST_TOKEN || '').trim();
}

function configured() {
  return Boolean(endpoint() && token());
}

/** Why the configuration cannot work, or null when it looks usable. */
function configProblem() {
  if (!endpoint() && !token()) return 'not-configured';
  if (!endpoint()) return 'missing-url';
  if (!token()) return 'missing-token';
  if (!/^https?:\/\/[^\s/]+/i.test(endpoint())) return 'bad-url';
  if (/^redis(s)?:\/\//i.test(endpoint())) return 'bad-url';
  if (/\s/.test(token())) return 'bad-token';
  return null;
}

async function call(path, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 2500);
  try {
    const response = await fetch(endpoint() + path, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token(),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: 'no-store'
    });
    if (!response.ok) {
      const error = new Error('redis http ' + response.status);
      error.status = response.status;
      throw error;
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Run one command; returns its result. */
async function command(args, timeoutMs) {
  if (!configured()) throw new Error('redis not configured');
  const data = await call('', args, timeoutMs);
  if (data && data.error) throw new Error(String(data.error));
  return data ? data.result : null;
}

/** Run many commands in a single HTTP round-trip; returns an array of results. */
/**
 * Run commands in one round trip.
 *
 * Upstash answers 200 even when individual commands inside the batch were
 * rejected (a wrong key type, for example), so a batched counter write can
 * fail while the HTTP call looks fine. With {strict:true} the first rejected
 * command throws instead, carrying a sanitised description of what was
 * refused. Without it the old forgiving behaviour is kept.
 */
async function pipeline(commands, timeoutMs, options) {
  if (!configured()) throw new Error('redis not configured');
  if (!commands.length) return [];
  const data = await call('/pipeline', commands, timeoutMs);
  if (!Array.isArray(data)) throw new Error('redis pipeline failed');
  const failures = [];
  data.forEach((entry, index) => {
    if (!entry || !Object.prototype.hasOwnProperty.call(entry, 'error')) return;
    const args = commands[index] || [];
    failures.push({
      index: index,
      command: String(args[0] || ''),
      key: String(args[1] || ''),
      message: String(entry.error || '').slice(0, 140)
    });
  });
  if (failures.length && options && options.strict) {
    const error = new Error(failures[0].message || 'redis command rejected');
    error.failures = failures;
    throw error;
  }
  return data.map((entry) => (entry && Object.prototype.hasOwnProperty.call(entry, 'result') ? entry.result : null));
}

/** Short, secret-free description of a rejected command. */
function failureInfo(error) {
  const list = (error && error.failures) || [];
  const first = list[0] || null;
  return {
    reason: describeError(error),
    command: first ? first.command : null,
    key: first ? first.key : null,
    message: first ? first.message : String((error && error.message) || '').slice(0, 140),
    count: list.length
  };
}

function key(...parts) {
  return PREFIX + parts.join(':');
}

/** Short, secret-free reason used in logs and in the dashboard status strip. */
function describeError(error) {
  if (!error) return 'unknown';
  if (error.name === 'AbortError') return 'timeout';
  const status = error.status;
  if (status === 401 || status === 403) return 'rejected-credentials';
  if (status === 404) return 'wrong-endpoint';
  if (status === 429) return 'rate-limited';
  if (status && status >= 500) return 'storage-unavailable';
  const message = String(error.message || '');
  if (/fetch failed|ENOTFOUND|EAI_AGAIN|network|Invalid URL/i.test(message)) return 'unreachable';
  if (/WRONGPASS|NOPERM|invalid.*(token|password)/i.test(message)) return 'rejected-credentials';
  if (/WRONGTYPE/i.test(message)) return 'wrong-type';
  if (/OOM|maxmemory|limit exceeded/i.test(message)) return 'quota';
  if (/^ERR/i.test(message)) return 'rejected-command';
  return 'error';
}

/**
 * Verify the configuration end to end: read, write and delete a probe key that
 * stays inside this project's namespace. Safe to call from the dashboard.
 */
async function diagnose() {
  const problem = configProblem();
  if (problem) return { ok: false, reason: problem };
  const probe = key('health', 'probe');
  try {
    const pong = await command(['PING'], 2500);
    if (String(pong).toUpperCase() !== 'PONG') return { ok: false, reason: 'unexpected-response' };
    await command(['SET', probe, String(Date.now()), 'EX', '60'], 2500);
    const value = await command(['GET', probe], 2500);
    await command(['DEL', probe], 2500);
    if (!value) return { ok: false, reason: 'write-not-persisted' };
    // Exercise the exact call the counter uses, still inside our namespace.
    const piped = await pipeline([['HINCRBY', key('health', 'probes'), 'count', '1']], 2500);
    if (Number(piped[0]) < 1) return { ok: false, reason: 'pipeline-failed' };
    return { ok: true, reason: 'ok' };
  } catch (error) {
    return { ok: false, reason: describeError(error) };
  }
}

module.exports = { PREFIX, key, configured, configProblem, command, pipeline, describeError, failureInfo, diagnose };
