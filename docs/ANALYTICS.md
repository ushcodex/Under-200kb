# Under 200KB: private analytics

Under 200KB keeps Vercel Analytics (the `/_vercel/insights` script in `index.html`) and adds its
own private, aggregate-only analytics with a protected dashboard.

Everything here is scoped to this project. It shares the team's existing Upstash database but
**only** through its own environment variables and its own key namespace `u200kb:v1:`. It never
reads, writes, lists or flushes keys belonging to `ushcodex.tech`, `usman.engineer` or anything
else in that database.

## What is collected

| Field | Example | Notes |
| --- | --- | --- |
| Event | `view`, `file_selected`, `compress`, `download` | allow-listed |
| Result | `ok` / `fail` | compression outcome |
| Direction | `image-jpg`, `image-pdf`, `pdf-jpg`, `pdf-pdf` | conversion direction |
| Limit bucket | `<=50`, `<=100`, `<=200`, `<=500`, `>500` | never the exact limit |
| Duration bucket | `<1s`, `1-3s`, `3-8s`, `>8s` | never exact timings |
| Referrer bucket | `google`, `social`, `ushcodex`, `direct`, … | host is classified server-side then discarded |
| Device class | `mobile`, `desktop`, `tablet` | from the user agent string |
| Country | `NG` | from the CDN edge header; the IP itself is never stored |

Never collected: file names, file contents, file sizes, exact limits, exact timings, cookies,
cross-site identifiers, raw IP addresses, or anything that can be joined to an individual.

The unique-visitor estimate uses a daily HyperLogLog of an HMAC of `IP + UA + day`, keyed by
`U200_ANALYTICS_SECRET`. The hash rotates every day, is truncated, and cannot be reversed. It is
only ever fed to `PFADD`/`PFCOUNT`, so no per-visitor rows exist.

## Checking that it counts

Open `/dashboard` (or `/api/health` directly) and look at the storage strip:

| Badge | Meaning | Fix |
| --- | --- | --- |
| Storage OK | write, read and delete all worked inside `u200kb:v1:` | nothing |
| Storage problem | the strip names the reason code | see below |

Reason codes: `not-configured`, `missing-url`, `missing-token`, `bad-url`, `bad-token`,
`rejected-credentials`, `wrong-endpoint`, `unreachable`, `timeout`, `rate-limited`,
`storage-unavailable`, `write-not-persisted`.

Failures are also logged as one short line in the Vercel function logs
(`[u200kb] collect: write failed (reason)`), with no payloads and no secrets.

To prove a visit is recorded, load `/` once and then press Refresh in the dashboard: Visits
increments for the current UTC day, and Sources/Devices fill in. Visits are not realtime (they are
aggregated per day), but they are booked immediately.

## Privacy controls

* `navigator.globalPrivacyControl === true` → nothing is sent (checked in the browser **and**
  re-checked from the `Sec-GPC` header on the server).
* `navigator.doNotTrack === '1'` / `DNT: 1` → nothing is sent.
* The footer has an explicit opt-out checkbox (`localStorage["u200kb-analytics-optout"]`).
* Analytics is fire-and-forget: `sendBeacon` first, `fetch` fallback, every failure swallowed.
  Nothing about it can interrupt compression, conversion or downloads.
* Dashboard traffic is `noindex`, `no-store`, and never analysed.

## Infinite retention

Days accumulate in a Redis set (`u200kb:v1:days`) and each day is one hash (`u200kb:v1:day:YYYY-MM-DD`).
Nothing expires, so **All time** is genuinely all time. To keep command usage low:

* one `pipeline` call per recorded event (3–6 commands),
* one `HGETALL` per day only when the dashboard is opened,
* a 3-minute cached JSON snapshot for the dashboard (`u200kb:v1:cache:stats:<range>`).
  Serving ~90 days costs about 95 commands the first time and **1** afterwards.

## Environment variables

Set these on the Vercel project `under-200kb` (Production + Preview). They are separate from the
`USH_*` variables used by the Ushcodex site.

| Variable | Required | Purpose |
| --- | --- | --- |
| `U200_ANALYTICS_REDIS_REST_URL` | yes | REST URL of the **existing** shared Upstash database |
| `U200_ANALYTICS_REDIS_REST_TOKEN` | yes | token for that same database |
| `U200_ANALYTICS_PASSWORD` | yes | password for `/dashboard`, different from every other dashboard |
| `U200_ANALYTICS_SECRET` | yes | HMAC key for sessions and visitor hashes |
| `U200_GSC_SITE` | optional | e.g. `sc-domain:ushcodex.tech`, used by `/api/gsc` |
| `U200_GSC_SERVICE_ACCOUNT_JSON` | optional | read-only service-account key (raw JSON or base64) |

`U200_ANALYTICS_PASSWORD` and `U200_ANALYTICS_SECRET` are already provisioned. View or rotate them
in **Vercel → under-200kb → Settings → Environment Variables**; do not paste them into chat or
into the repository. The Redis URL/token must be copied from the existing Upstash database
(Upstash console → database → REST API) because Vercel marks the copies used by the other
projects as write-only "sensitive" values that cannot be read back through the API.

Without them the tool works exactly as before: `/api/collect` answers `204` and `/api/stats`
answers `503` with a clear message.

## Google Search Console

`/api/gsc` returns site-wide, aggregated search performance for the configured property: top
queries with clicks, impressions, CTR and position, plus a daily series. It requires the dashboard
session cookie.

* Create a Google Cloud service account with no roles, enable the *Search Console API*, and add
  the service account's `client_email` as a **Full** or **Restricted** user on the verified
  property that covers `under200kb.ushcodex.tech` (`sc-domain:ushcodex.tech` covers the subdomain).
* Store the key JSON in `U200_GSC_SERVICE_ACCOUNT_JSON`.
* Scope requested is `webmasters.readonly`, so access is read only.

Search data is never joined to visit data, so the dashboard cannot attribute a search term to a
visitor, and the UI says so.

## API

| Route | Method | Auth | Purpose |
| --- | --- | --- | --- |
| `/api/collect` | POST | none, allow-listed payloads, GPC/DNT aware | counters |
| `/api/stats` | POST `{password}` | password → HttpOnly session cookie (8 h) | sign in + first payload |
| `/api/stats` | GET `?range=7\|30\|90\|all` | session cookie | dashboard payload |
| `/api/stats` | POST `{logout:true}` | none | clear the cookie |
| `/api/gsc` | GET | session cookie | Search Console aggregate |
| `/api/health` | GET | none for the storage verdict, session for counters | self check |

Login attempts are limited to 8 per 15 minutes per visitor hash.

## Tests

```
npm test                       # unit, API (with a local Upstash stand-in), DOM, contrast
npm run dev                    # local preview on http://0.0.0.0:3000 (in-memory store)
CHROME_PATH=… node tests/browser.e2e.mjs    # real Chromium: JPG/PDF flows, offline, mobile
```

The API tests never touch the shared database: they point `U200_ANALYTICS_REDIS_REST_URL` at a
local stand-in and assert that every key written starts with `u200kb:v1:`.
