/* Integration tests for the analytics API against a local stand-in for the
   Upstash REST API. No network, no production data, no shared database. */
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = [];
let passed = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed += 1; })
    .catch((error) => { failures.push(name + ': ' + error.message); });
}
function expect(condition, message) { if (!condition) throw new Error(message); }
function equal(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error((label || 'value') + ' expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}

/* ---------------- tiny Upstash stand-in ---------------- */
function createStore() {
  const hashes = new Map();
  const sets = new Map();
  const strings = new Map();
  const hll = new Map();

  function hash(key) {
    if (!hashes.has(key)) hashes.set(key, new Map());
    return hashes.get(key);
  }

  return {
    keys() { return [...strings.keys(), ...hashes.keys(), ...sets.keys(), ...hll.keys()]; },
    hashes,
    strings,
    sets,
    hll,
    execute(args) {
      const command = String(args[0] || '').toUpperCase();
      switch (command) {
        case 'HINCRBY': {
          const h = hash(args[1]);
          const next = Number(h.get(args[2]) || 0) + Number(args[3]);
          h.set(args[2], String(next));
          return next;
        }
        case 'HSET': {
          const h = hash(args[1]);
          for (let i = 2; i < args.length; i += 2) h.set(args[i], String(args[i + 1]));
          return 1;
        }
        case 'HGETALL': {
          const h = hash(args[1]);
          const out = [];
          h.forEach((value, field) => { out.push(field, value); });
          return out;
        }
        case 'SADD': {
          if (!sets.has(args[1])) sets.set(args[1], new Set());
          let added = 0;
          for (let i = 2; i < args.length; i += 1) {
            if (!sets.get(args[1]).has(args[i])) { sets.get(args[1]).add(args[i]); added += 1; }
          }
          return added;
        }
        case 'SMEMBERS': return [...(sets.get(args[1]) || [])];
        case 'PFADD': {
          if (!hll.has(args[1])) hll.set(args[1], new Set());
          for (let i = 2; i < args.length; i += 1) hll.get(args[1]).add(args[i]);
          return 1;
        }
        case 'PFCOUNT': {
          const union = new Set();
          for (let i = 1; i < args.length; i += 1) {
            (hll.get(args[i]) || new Set()).forEach((v) => union.add(v));
          }
          return union.size;
        }
        case 'GET': return strings.has(args[1]) ? strings.get(args[1]) : null;
        case 'SET': strings.set(args[1], String(args[2])); return 'OK';
        case 'INCR': {
          const next = Number(strings.get(args[1]) || 0) + 1;
          strings.set(args[1], String(next));
          return next;
        }
        case 'EXPIRE': return 1;
        case 'TTL': return strings.has(args[1]) ? 900 : -2;
        case 'DEL': strings.delete(args[1]); hashes.delete(args[1]); return 1;
        default: throw new Error('unsupported command ' + command);
      }
    }
  };
}

const store = createStore();
let commandCount = 0;

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8') || '[]';
    let body;
    try { body = JSON.parse(raw); } catch (e) { body = []; }
    commandCount += 1;
    res.setHeader('Content-Type', 'application/json');
    try {
      if (req.url === '/pipeline') {
        res.end(JSON.stringify(body.map((args) => ({ result: store.execute(args) }))));
      } else {
        res.end(JSON.stringify({ result: store.execute(body) }));
      }
    } catch (error) {
      res.end(JSON.stringify({ error: error.message }));
    }
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;

process.env.U200_ANALYTICS_REDIS_REST_URL = base;
process.env.U200_ANALYTICS_REDIS_REST_TOKEN = 'test-token';
process.env.U200_ANALYTICS_PASSWORD = 'correct-horse-battery';
process.env.U200_ANALYTICS_SECRET = 'unit-test-secret';
delete process.env.USH_ANALYTICS_PASSWORD;
delete process.env.USH_ANALYTICS_REDIS_REST_URL;

const collect = require(path.join(root, 'api/collect.js'));
const stats = require(path.join(root, 'api/stats.js'));
const gsc = require(path.join(root, 'api/gsc.js'));

function mockReq({ method = 'POST', headers = {}, body = undefined, query = {} } = {}) {
  return {
    method,
    headers,
    body: body === undefined ? JSON.stringify({}) : (typeof body === 'string' ? body : JSON.stringify(body)),
    query,
    socket: { remoteAddress: '203.0.113.42' }
  };
}

async function run(handler, req) {
  const out = { statusCode: 0, headers: {}, body: '', setHeader(name, value) { this.headers[name.toLowerCase()] = value; }, end(payload) { this.body = payload === undefined ? '' : String(payload); } };
  await handler(req, out);
  out.status = out.statusCode;
  out.json = () => { try { return JSON.parse(out.body); } catch (e) { return null; } };
  return out;
}

const UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Mobile Safari/537.36';

/* ---------------- collect ---------------- */
await check('view records visits, device, source and country', async () => {
  const res = await run(collect, mockReq({
    headers: { 'user-agent': UA, 'x-vercel-ip-country': 'NG', 'x-forwarded-for': '203.0.113.42' },
    body: { e: 'view', r: 'www.google.com' }
  }));
  equal(res.status, 204, 'status');
  const today = new Date().toISOString().slice(0, 10);
  const day = store.hashes.get('u200kb:v1:day:' + today);
  expect(day, 'daily hash missing');
  equal(day.get('pv'), '1', 'page views');
  equal(day.get('dev:mobile'), '1', 'device');
  equal(day.get('src:google'), '1', 'source');
  equal(day.get('c:NG'), '1', 'country');
  expect(store.sets.get('u200kb:v1:days').has(today), 'day not indexed');
});

await check('no identifier survives into Redis', async () => {
  const dump = JSON.stringify([...store.keys()]) + JSON.stringify([...store.hashes].map(([k, v]) => [k, [...v]])) +
    JSON.stringify([...store.strings]) + JSON.stringify([...store.sets].map(([k, v]) => [k, [...v]])) +
    JSON.stringify([...store.hll].map(([k, v]) => [k, [...v]]));
  expect(!dump.includes('203.0.113.42'), 'raw IP found in storage');
  expect(!dump.includes('Pixel 7'), 'user agent found in storage');
  const uv = [...store.hll.get('u200kb:v1:uv:' + new Date().toISOString().slice(0, 10))];
  equal(uv.length, 1, 'unique visitor recorded');
  expect(uv[0].length === 22, 'visitor hash should be truncated');
});

await check('every key stays in the u200kb namespace', async () => {
  const foreign = store.keys().filter((key) => !key.startsWith('u200kb:v1:'));
  equal(foreign, [], 'foreign keys');
});

await check('GPC and DNT suppress collection', async () => {
  const before = commandCount;
  const a = await run(collect, mockReq({ headers: { 'sec-gpc': '1', 'user-agent': UA }, body: { e: 'view' } }));
  const b = await run(collect, mockReq({ headers: { dnt: '1', 'user-agent': UA }, body: { e: 'compress', k: 'ok' } }));
  equal(a.status, 204, 'gpc status');
  equal(b.status, 204, 'dnt status');
  equal(commandCount, before, 'no Redis commands should run');
});

await check('bots are counted separately and never as visits', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const before = Number(store.hashes.get('u200kb:v1:day:' + today).get('pv') || 0);
  await run(collect, mockReq({ headers: { 'user-agent': 'Googlebot/2.1' }, body: { e: 'view' } }));
  const day = store.hashes.get('u200kb:v1:day:' + today);
  equal(Number(day.get('pv')), before, 'page views must not increase');
  equal(day.get('bots'), '1', 'bot counter');
});

await check('compression success, failure and direction are counted', async () => {
  const today = new Date().toISOString().slice(0, 10);
  await run(collect, mockReq({ headers: { 'user-agent': UA }, body: { e: 'compress', k: 'ok', d: 'image-pdf', t: 200, b: '<=200', ms: '1-3s' } }));
  await run(collect, mockReq({ headers: { 'user-agent': UA }, body: { e: 'compress', k: 'fail', d: 'pdf-jpg', t: 100, b: '<=100' } }));
  await run(collect, mockReq({ headers: { 'user-agent': UA }, body: { e: 'file_selected', k: 'pdf' } }));
  await run(collect, mockReq({ headers: { 'user-agent': UA }, body: { e: 'download', d: 'image-pdf' } }));
  const day = store.hashes.get('u200kb:v1:day:' + today);
  equal(day.get('a:compress_ok'), '1', 'ok');
  equal(day.get('a:compress_fail'), '1', 'fail');
  equal(day.get('dir:image-pdf'), '2', 'direction (compress + download)');
  equal(day.get('dir:pdf-jpg'), '1', 'fail direction');
  equal(day.get('tgt:<=200'), '1', 'target bucket');
  equal(day.get('a:file_pdf'), '1', 'file kind');
  equal(day.get('a:download'), '1', 'download');
});

await check('unknown events and junk payloads are ignored', async () => {
  const before = commandCount;
  const res = await run(collect, mockReq({
    headers: { 'user-agent': UA },
    body: { e: 'exfiltrate', filename: 'passport.jpg', ip: '1.2.3.4' }
  }));
  equal(res.status, 204, 'status');
  equal(commandCount, before, 'no commands for invalid events');
});

await check('only POST is accepted', async () => {
  const res = await run(collect, mockReq({ method: 'GET', headers: {} }));
  equal(res.status, 405, 'status');
});

await check('analytics failures never throw', async () => {
  const saved = process.env.U200_ANALYTICS_REDIS_REST_URL;
  process.env.U200_ANALYTICS_REDIS_REST_URL = 'http://127.0.0.1:1';
  const res = await run(collect, mockReq({ headers: { 'user-agent': UA }, body: { e: 'view' } }));
  process.env.U200_ANALYTICS_REDIS_REST_URL = saved;
  equal(res.status, 204, 'still returns 204');
});

/* ---------------- stats / dashboard auth ---------------- */
await check('dashboard rejects a wrong password', async () => {
  const res = await run(stats, mockReq({ body: { password: 'nope' }, headers: {} }));
  equal(res.status, 401, 'status');
  expect(!res.headers['set-cookie'], 'no cookie on failure');
});

await check('dashboard rejects the Ushcodex site password', async () => {
  process.env.USH_ANALYTICS_PASSWORD = 'ushcodex-secret';
  const res = await run(stats, mockReq({ body: { password: 'ushcodex-secret' }, headers: {} }));
  delete process.env.USH_ANALYTICS_PASSWORD;
  equal(res.status, 401, 'status');
});

let sessionCookie = '';
await check('dashboard sign-in sets a hardened cookie and returns aggregates', async () => {
  const res = await run(stats, mockReq({ body: { password: 'correct-horse-battery', range: '30' }, headers: {} }));
  equal(res.status, 200, 'status');
  const cookies = res.headers['set-cookie'];
  expect(cookies, 'missing Set-Cookie');
  expect(/HttpOnly/.test(cookies), 'cookie must be HttpOnly');
  expect(/Secure/.test(cookies), 'cookie must be Secure');
  expect(/SameSite=Strict/.test(cookies), 'cookie must be SameSite=Strict');
  sessionCookie = cookies.split(';')[0];
  const body = res.json();
  equal(body.ok, true, 'ok flag');
  expect(body.totals.visits >= 1, 'visits should be counted');
  expect(body.totals.ok === 1 && body.totals.fail === 1, 'compression totals');
  expect(body.devices.some((row) => row.name === 'mobile'), 'device breakdown');
  expect(body.sources.some((row) => row.name === 'google'), 'source breakdown');
  expect(body.directions.some((row) => row.name === 'image-pdf'), 'direction breakdown');
  expect(!JSON.stringify(body).includes('203.0.113'), 'no IPs in the report');
});

await check('unconfigured deployments degrade cleanly', async () => {
  const savedUrl = process.env.U200_ANALYTICS_REDIS_REST_URL;
  const savedToken = process.env.U200_ANALYTICS_REDIS_REST_TOKEN;
  delete process.env.U200_ANALYTICS_REDIS_REST_URL;
  delete process.env.U200_ANALYTICS_REDIS_REST_TOKEN;
  const collectRes = await run(collect, mockReq({ headers: { 'user-agent': UA }, body: { e: 'view' } }));
  const statsRes = await run(stats, mockReq({ method: 'GET', headers: {}, query: { range: '30' } }));
  process.env.U200_ANALYTICS_REDIS_REST_URL = savedUrl;
  process.env.U200_ANALYTICS_REDIS_REST_TOKEN = savedToken;
  equal(collectRes.status, 204, 'collect must stay a no-op 204');
  equal(statsRes.status, 503, 'stats should explain the missing configuration');
  expect(/not configured/i.test(statsRes.json().error || ''), 'clear message');
});

await check('stats requires a session', async () => {
  const res = await run(stats, mockReq({ method: 'GET', headers: {}, query: { range: '7' } }));
  equal(res.status, 401, 'status');
});

await check('stats accepts a valid session for each range', async () => {
  for (const range of ['7', '30', '90', 'all']) {
    const res = await run(stats, mockReq({ method: 'GET', headers: { cookie: sessionCookie }, query: { range } }));
    equal(res.status, 200, 'range ' + range);
    const body = res.json();
    expect(Array.isArray(body.daily), 'daily array');
    equal(body.range.key, range, 'range echoed');
  }
});

await check('tampered session cookies are rejected', async () => {
  const res = await run(stats, mockReq({ method: 'GET', headers: { cookie: sessionCookie + 'x' }, query: { range: '30' } }));
  equal(res.status, 401, 'status');
});

await check('logout clears the cookie', async () => {
  const res = await run(stats, mockReq({ body: { logout: true }, headers: {} }));
  equal(res.status, 200, 'status');
  expect(/Max-Age=0/.test(res.headers['set-cookie']), 'cookie should be cleared');
});

await check('dashboard login is rate limited', async () => {
  let last = null;
  for (let i = 0; i < 12; i += 1) {
    last = await run(stats, mockReq({ body: { password: 'wrong-' + i }, headers: { 'x-forwarded-for': '198.51.100.7' } }));
    if (last.status === 429) break;
  }
  equal(last.status, 429, 'expected 429 after repeated failures');
});

await check('stats reports storage outages without leaking details', async () => {
  const saved = process.env.U200_ANALYTICS_REDIS_REST_URL;
  process.env.U200_ANALYTICS_REDIS_REST_URL = 'http://127.0.0.1:1';
  const res = await run(stats, mockReq({ method: 'GET', headers: { cookie: sessionCookie }, query: { range: '30' } }));
  process.env.U200_ANALYTICS_REDIS_REST_URL = saved;
  expect(res.status === 502 || res.status === 200, 'unexpected status ' + res.status);
  if (res.status === 502) equal(res.json().ok, false, 'error flag');
});

/* ---------------- Search Console ---------------- */
await check('GSC reports "not configured" without credentials', async () => {
  delete process.env.U200_GSC_SERVICE_ACCOUNT_JSON;
  delete process.env.U200_GSC_SITE;
  const res = await run(gsc, mockReq({ method: 'GET', headers: { cookie: sessionCookie } }));
  equal(res.status, 200, 'status');
  equal(res.json().configured, false, 'configured flag');
});

await check('GSC requires a session', async () => {
  const res = await run(gsc, mockReq({ method: 'GET', headers: {} }));
  equal(res.status, 401, 'status');
});

await check('GSC aggregates queries with a read-only service account', async () => {
  const crypto = await import('node:crypto');
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.U200_GSC_SITE = 'sc-domain:ushcodex.tech';
  process.env.U200_GSC_SERVICE_ACCOUNT_JSON = JSON.stringify({
    client_email: 'reader@project.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' })
  });
  equal(publicKey.asymmetricKeyType, 'rsa', 'test key');

  const realFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), body: options && options.body });
    if (String(url).includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'ya29.test' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (String(url).includes('searchAnalytics/query')) {
      const payload = JSON.parse(options.body);
      if (payload.dimensions[0] === 'query') {
        return new Response(JSON.stringify({ rows: [
          { keys: ['compress image under 200kb'], clicks: 40, impressions: 900, ctr: 0.044, position: 4.2 },
          { keys: ['passport photo 200kb'], clicks: 10, impressions: 100, ctr: 0.1, position: 6.5 }
        ] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ rows: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error('unexpected fetch ' + url);
  };
  store.strings.delete('u200kb:v1:cache:gsc');
  const res = await run(gsc, mockReq({ method: 'GET', headers: { cookie: sessionCookie } }));
  global.fetch = realFetch;
  delete process.env.U200_GSC_SERVICE_ACCOUNT_JSON;
  delete process.env.U200_GSC_SITE;

  equal(res.status, 200, 'status');
  const body = res.json();
  equal(body.configured, true, 'configured');
  equal(body.totals.clicks, 50, 'clicks total');
  equal(body.totals.impressions, 1000, 'impressions total');
  equal(body.queries.length, 2, 'query rows');
  expect(calls.some((call) => call.url.includes('webmasters/v3/sites/')), 'Search Console API used');
  expect(!JSON.stringify(body).match(/cookie|ip|visitor/i), 'no visitor linkage in GSC payload');
});

server.close();
console.log('api: ' + passed + ' checks passed' + (failures.length ? ', ' + failures.length + ' failed' : ''));
if (failures.length) {
  console.error(failures.map((f) => ' ✗ ' + f).join('\n'));
  process.exit(1);
}
