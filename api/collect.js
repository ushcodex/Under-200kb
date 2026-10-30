/* POST /api/collect: anonymous, aggregate-only counters for Under 200KB.
 *
 * Nothing identifying is stored: no file names, no file contents, no IP
 * addresses, no cookies, no per-visitor rows. A visit writes a handful of
 * counter increments into one daily hash so command usage stays small.
 * Any failure returns 204 so analytics can never affect the tool.
 */

'use strict';

const redis = require('./_lib/redis');
const analytics = require('./_lib/analytics');

const EVENTS = new Set(['view', 'file_selected', 'compress', 'download', 'ping']);
const DIRECTIONS = new Set(['image-jpg', 'image-pdf', 'pdf-jpg', 'pdf-pdf']);
const BUCKETS = new Set(['<=50', '<=100', '<=200', '<=500', '>500']);
const KINDS = new Set(['image', 'pdf']);

const DEBUG = process.env.U200_DEBUG === '1';

function log(message) {
  // One short line, no payload, no secrets. Shows up in Vercel logs.
  console.error('[u200kb] ' + message);
}

function noContent(res) {
  res.statusCode = 204;
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.end();
}

/* Normal beacons always get an empty 204: the browser learns nothing and the
 * tool never sees an error. The dashboard's "Send test event" button adds
 * ?probe=1 so it can be told exactly what happened to its own request. The
 * reply describes this request only, never a visitor. */
function reply(res, probe, info) {
  if (!probe) return noContent(res);
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.end(JSON.stringify(info));
}

function dropped(res, probe, why, extra) {
  const info = { ok: true, recorded: false, dropped: why };
  if (extra) Object.keys(extra).forEach((key) => { info[key] = extra[key]; });
  return reply(res, probe, info);
}

function optOutRequested(req) {
  const gpc = String(req.headers['sec-gpc'] || '');
  const dnt = String(req.headers.dnt || '');
  return gpc === '1' || dnt === '1';
}

module.exports = async function handler(req, res) {
  const probe = /(\?|&)probe=1(&|$)/.test(String(req.url || ''));
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Allow', 'POST, OPTIONS');
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Allow', 'POST, OPTIONS');
    res.end();
    return;
  }
  // Honour browser-level privacy signals even if the client is tampered with.
  if (optOutRequested(req)) {
    const gpc = String(req.headers['sec-gpc'] || '') === '1';
    return dropped(res, probe, 'privacy-signal', { signal: gpc ? 'gpc' : 'dnt' });
  }
  const problem = redis.configProblem();
  if (problem) {
    if (problem !== 'not-configured') log('collect: storage ' + problem);
    return dropped(res, probe, 'storage', { reason: problem });
  }

  let payload;
  try {
    payload = await analytics.readJson(req);
  } catch (e) {
    return dropped(res, probe, 'payload');
  }

  const event = typeof payload.e === 'string' ? payload.e : '';
  if (!EVENTS.has(event)) return dropped(res, probe, 'event');

  const now = new Date();
  const day = analytics.dayKey(now);
  const daily = redis.key('day', day);
  const receiver = redis.key('rx');
  const commands = [];

  // Every accepted call leaves one small receipt in our own namespace so the
  // dashboard can prove the endpoint is being reached, without any visitor data.
  commands.push(['HSET', receiver, 'at', String(now.getTime()), 'event', event]);
  commands.push(['HINCRBY', daily, 'rx', '1']);

  const receiptCommands = commands.slice(0, 2);
  let receiptOk = false;
  let countersOk = false;
  let failure = null;

  try {
    if (event === 'view') {
      const device = analytics.classifyDevice(req.headers['user-agent']);
      if (device === 'bot') {
        commands.push(['HINCRBY', daily, 'bots', '1']);
      } else {
        const source = analytics.classifySource(payload.r);
        const country = analytics.classifyCountry(req);
        commands.push(['HINCRBY', daily, 'pv', '1']);
        commands.push(['HINCRBY', daily, 'dev:' + device, '1']);
        commands.push(['HINCRBY', daily, 'src:' + source, '1']);
        commands.push(['HINCRBY', daily, 'c:' + country, '1']);
        const visitor = analytics.visitorHash(analytics.clientIp(req), req.headers['user-agent'], day);
        if (visitor) commands.push(['PFADD', redis.key('uv', day), visitor]);
      }
      commands.push(['SADD', redis.key('days'), day]);
      commands.push(['HSET', redis.key('meta'), 'last_seen', String(now.getTime())]);
    } else if (event === 'file_selected') {
      const kind = KINDS.has(payload.k) ? payload.k : null;
      if (!kind) return dropped(res, probe, 'payload');
      commands.push(['HINCRBY', daily, 'a:file_' + kind, '1']);
    } else if (event === 'compress') {
      if (payload.k !== 'ok' && payload.k !== 'fail') return dropped(res, probe, 'payload');
      const ok = payload.k === 'ok';
      const direction = DIRECTIONS.has(payload.d) ? payload.d : null;
      commands.push(['HINCRBY', daily, ok ? 'a:compress_ok' : 'a:compress_fail', '1']);
      if (direction) commands.push(['HINCRBY', daily, 'dir:' + direction, '1']);
      if (BUCKETS.has(payload.b)) commands.push(['HINCRBY', daily, 'tgt:' + payload.b, '1']);
      commands.push(['SADD', redis.key('days'), day]);
    } else if (event === 'download') {
      const direction = DIRECTIONS.has(payload.d) ? payload.d : null;
      commands.push(['HINCRBY', daily, 'a:download', '1']);
      if (direction) commands.push(['HINCRBY', daily, 'dir:' + direction, '1']);
    }

    if (commands.length) await redis.pipeline(commands, 2000, { strict: true });
    receiptOk = true;
    countersOk = true;
    if (DEBUG) log('collect: recorded ' + event);
  } catch (e) {
    failure = redis.failureInfo(e);
    // The browser must never see this, but it has to be visible to us.
    log('collect: write failed (' + failure.reason + (failure.command ? ' on ' + failure.command : '') + ')');
    // A rejected counter must not hide the arrival: retry the receipt alone.
    try {
      await redis.pipeline(receiptCommands, 2000, { strict: true });
      receiptOk = true;
    } catch (e2) {
      log('collect: receipt failed (' + redis.describeError(e2) + ')');
    }
    // Leave a note for the dashboard, inside our own namespace.
    try {
      await redis.pipeline([['HSET', redis.key('health', 'lastfail'),
        'at', String(now.getTime()), 'event', event,
        'command', String(failure.command || ''), 'key', String(failure.key || ''),
        'error', String(failure.message || '').slice(0, 140)]], 2000);
    } catch (e3) { /* storage itself is down: the log already says so */ }
  }

  return reply(res, probe, {
    ok: true,
    recorded: receiptOk,
    event: event,
    at: now.toISOString(),
    counters: countersOk,
    dropped: receiptOk ? null : 'write',
    reason: failure ? failure.reason : null,
    command: failure ? failure.command : null
  });};
