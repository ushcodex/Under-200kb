# Under 200KB

Compress an image or PDF to a strict file-size limit, and switch between JPG and PDF on the way
out. An [Ushcodex Technologies](https://ushcodex.tech/) tool.

**Live:** https://under200kb.ushcodex.tech/

Everything is client-side. Files are read from disk, drawn on a canvas and encoded in the tab;
nothing is uploaded, and no file name, content or size is ever sent anywhere.

## How it works

* Images: capped at 2500 px on the long edge, then JPEG quality steps down from `0.9` in `0.05`
  increments until the blob fits the limit (minimum quality `0.1`). Transparent images get a white
  matte so PNGs don't turn black.
* PDF in: page 1 is rendered with pdf.js, then compressed like an image.
* PDF out: the compressed JPEG is wrapped into a one-page PDF with jsPDF.
* Names: `passport.jpg` → `passport-under200kb.jpg`; `result.pdf` → `result-compressed.pdf`.
  The original stem is kept (multiple dots, non-Latin scripts and emoji included) with unsafe
  filesystem characters replaced.

## Layout

```
index.html          tool page (CSS is inlined at build time)
styles.css          source of truth for styles, run `npm run inline-css` after editing
app.js              the compressor
analytics.js        opt-out aware, non-blocking analytics client
sw.js               service worker (v3: network-first pages, SWR assets)
dashboard.html/.js  private analytics dashboard
api/collect.js      POST counter endpoint
api/stats.js        protected dashboard feed
api/gsc.js          Search Console aggregate
api/health.js       storage self check shown in the dashboard
vendor/             self-hosted pdf.js + jsPDF (no CDN, works offline)
fonts/              self-hosted Inter + Space Mono subsets
docs/ANALYTICS.md   analytics design, privacy posture and environment setup
```

## Commands

```
npm install
npm run inline-css # re-inline styles.css into index.html
npm run dev        # preview on http://0.0.0.0:3000 (in-memory analytics store)
npm test           # unit + API + DOM + contrast tests
```

Browser-level checks (real Chromium: JPG/PDF flows, offline reload, mobile layout):

```
CHROME_PATH=/path/to/chrome node tests/browser.e2e.mjs
```

## Deploy

Vercel, project `under-200kb`, production branch `main`. No build step is required for the static
files; `vercel.json` sets the security headers, cache policy and the `api/*` function config.
See [docs/ANALYTICS.md](docs/ANALYTICS.md) for the analytics environment variables.

## Licence

Tool code © Ushcodex Technologies. Bundled libraries keep their own licences
(`vendor/PDFJS-LICENSE.txt`, `vendor/JSPDF-LICENSE.txt`).
