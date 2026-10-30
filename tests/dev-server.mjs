/* Local preview server: serves the static tool and runs the real /api/*
   handlers, with optional in-memory Upstash stand-in when no database is
   configured. Never used in production. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || 3000);

process.env.U200_ANALYTICS_PASSWORD = process.env.U200_ANALYTICS_PASSWORD || 'preview-password';
process.env.U200_ANALYTICS_SECRET = process.env.U200_ANALYTICS_SECRET || 'preview-secret';

/* In-memory Upstash look-alike so the dashboard works without a database. */
if (!process.env.U200_ANALYTICS_REDIS_REST_URL) {
  const hashes = new Map();
  const strings = new Map();
  const sets = new Map();
  const hll = new Map();
  const execute = (args) => {
    const command = String(args[0] || '').toUpperCase();
    const hash = (key) => { if (!hashes.has(key)) hashes.set(key, new Map()); return hashes.get(key); };
    switch (command) {
      case 'HINCRBY': { const h = hash(args[1]); const next = Number(h.get(args[2]) || 0) + Number(args[3]); h.set(args[2], String(next)); return next; }
      case 'HSET': { const h = hash(args[1]); for (let i = 2; i < args.length; i += 2) h.set(args[i], String(args[i + 1])); return 1; }
      case 'HGETALL': { const out = []; hash(args[1]).forEach((v, k) => out.push(k, v)); return out; }
      case 'SADD': { if (!sets.has(args[1])) sets.set(args[1], new Set()); sets.get(args[1]).add(args[2]); return 1; }
      case 'SMEMBERS': return [...(sets.get(args[1]) || [])];
      case 'PFADD': { if (!hll.has(args[1])) hll.set(args[1], new Set()); for (let i = 2; i < args.length; i += 1) hll.get(args[1]).add(args[i]); return 1; }
      case 'PFCOUNT': { const union = new Set(); for (let i = 1; i < args.length; i += 1) (hll.get(args[i]) || new Set()).forEach((v) => union.add(v)); return union.size; }
      case 'GET': return strings.has(args[1]) ? strings.get(args[1]) : null;
      case 'SET': strings.set(args[1], String(args[2])); return 'OK';
      case 'INCR': { const next = Number(strings.get(args[1]) || 0) + 1; strings.set(args[1], String(next)); return next; }
      case 'EXPIRE': return 1;
      case 'TTL': return 900;
      default: throw new Error('unsupported ' + command);
    }
  };
  const memory = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      let body = [];
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '[]'); } catch (e) { body = []; }
      res.setHeader('Content-Type', 'application/json');
      try {
        if (req.url === '/pipeline') res.end(JSON.stringify(body.map((args) => ({ result: execute(args) }))));
        else res.end(JSON.stringify({ result: execute(body) }));
      } catch (error) {
        res.end(JSON.stringify({ error: error.message }));
      }
    });
  });
  await new Promise((resolve) => memory.listen(0, '127.0.0.1', resolve));
  process.env.U200_ANALYTICS_REDIS_REST_URL = 'http://127.0.0.1:' + memory.address().port;
  process.env.U200_ANALYTICS_REDIS_REST_TOKEN = 'preview';
  console.log('preview: using an in-memory analytics store');
}

const handlers = {
  '/api/collect': require(path.join(root, 'api/collect.js')),
  '/api/stats': require(path.join(root, 'api/stats.js')),
  '/api/gsc': require(path.join(root, 'api/gsc.js'))
};

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (handlers[url.pathname]) {
    req.query = Object.fromEntries(url.searchParams);
    try {
      await handlers[url.pathname](req, res);
    } catch (error) {
      res.statusCode = 500;
      res.end(JSON.stringify({ ok: false, error: 'dev server error' }));
    }
    return;
  }

  // Local stand-in for Vercel Analytics so the page has no 404s in preview.
  if (url.pathname === '/_vercel/insights/script.js') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    res.end('/* Vercel Analytics (local stand-in) */');
    return;
  }

  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/dashboard' || pathname === '/dashboard/') pathname = '/dashboard.html';
  if (pathname === '/') pathname = '/index.html';
  const file = path.join(root, pathname);
  if (!file.startsWith(root)) { res.statusCode = 403; res.end('Forbidden'); return; }
  fs.readFile(file, (error, data) => {
    if (error) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<h1>Not found</h1><p><a href="/">Back to Under 200KB</a></p>');
      return;
    }
    const type = TYPES[path.extname(file)] || 'application/octet-stream';
    const compressible = /text|javascript|json|svg/.test(type) && data.length > 1024;
    const accepts = String(req.headers['accept-encoding'] || '');
    res.statusCode = 200;
    res.setHeader('Content-Type', type);
    // Mirror Vercel's compression so local Lighthouse runs are representative.
    if (compressible && accepts.includes('gzip')) {
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Vary', 'Accept-Encoding');
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
      res.end(zlib.gzipSync(data, { level: 9 }));
      return;
    }
    res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    res.end(data);
  });
});

server.listen(port, '0.0.0.0', () => {
  console.log('Under 200KB preview on http://0.0.0.0:' + port);
  console.log('Dashboard: /dashboard (password: ' + process.env.U200_ANALYTICS_PASSWORD + ')');
});
