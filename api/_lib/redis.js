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
  const base = (process.env.U200_ANALYTICS_REDIS_REST_URL || '').trim().replace(/\/+$/, '');
  return base;
}

function token() {
  return (process.env.U200_ANALYTICS_REDIS_REST_TOKEN || '').trim();
}

function configured() {
  return Boolean(endpoint() && token());
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
    if (!response.ok) throw new Error('redis ' + response.status);
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
async function pipeline(commands, timeoutMs) {
  if (!configured()) throw new Error('redis not configured');
  if (!commands.length) return [];
  const data = await call('/pipeline', commands, timeoutMs);
  if (!Array.isArray(data)) throw new Error('redis pipeline failed');
  return data.map((entry) => (entry && Object.prototype.hasOwnProperty.call(entry, 'result') ? entry.result : null));
}

function key(...parts) {
  return PREFIX + parts.join(':');
}

module.exports = { PREFIX, key, configured, command, pipeline };
