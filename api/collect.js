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

const EVENTS = new Set(['view', 'file_selected', 'compress', 'download']);
const DIRECTIONS = new Set(['image-jpg', 'image-pdf', 'pdf-jpg', 'pdf-pdf']);
const BUCKETS = new Set(['<=50', '<=100', '<=200', '<=500', '>500']);
const KINDS = new Set(['image', 'pdf']);

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

function optOutRequested(req) {
  const gpc = String(req.headers['sec-gpc'] || '');
  const dnt = String(req.headers.dnt || '');
  return gpc === '1' || dnt === '1';
}

module.exports = async function handler(req, res) {
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
  if (optOutRequested(req)) return noContent(res);
  const problem = redis.configProblem();
  if (problem) {
    if (problem !== 'not-configured') log('collect: storage ' + problem);
    return noContent(res);
  }

  let payload;
  try {
    payload = await analytics.readJson(req);
  } catch (e) {
    return noContent(res);
  }

  const event = typeof payload.e === 'string' ? payload.e : '';
  if (!EVENTS.has(event)) return noContent(res);

  const now = new Date();
  const day = analytics.dayKey(now);
  const daily = redis.key('day', day);
  const commands = [];

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
      if (!kind) return noContent(res);
      commands.push(['HINCRBY', daily, 'a:file_' + kind, '1']);
    } else if (event === 'compress') {
      if (payload.k !== 'ok' && payload.k !== 'fail') return noContent(res);
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

    if (commands.length) await redis.pipeline(commands, 2000);
  } catch (e) {
    // The browser must never see this, but it has to be visible to us.
    log('collect: write failed (' + redis.describeError(e) + ')');
  }
  return noContent(res);
};
