# RoxyBrowser Clone · Anti-Detect Browser for Cross-Border E-Commerce (Desktop)

[简体中文](./README.md) | **English**

> **Terminology**: the Chinese README uses 环境 ("environment") for what the API calls a
> `profile` (`/api/profiles`). This translation uses **profile** throughout. Other recurring
> terms: 体检 → **health check**, 伪装度 → **spoof score**, 全空间快照 → **workspace snapshot**,
> 回收站 → **trash**, 分组 → **group**. Code identifiers, endpoints, paths and environment
> variables are kept verbatim.

A desktop anti-detect browser modeled on RoxyBrowser, built for cross-border e-commerce and
multi-account social-media operations where account linkage must be avoided. Every browser
profile gets **isolated cookies/cache + an isolated device fingerprint + an isolated proxy
exit IP**, so accounts stay fully separated.

## Documentation Index

| Document | Content | Language |
| ---- | ---- | ---- |
| [README.md](./README.md) | Architecture, directory layout, run & build commands (Chinese original) | 简体中文 |
| [README.en.md](./README.en.md) | This file — English translation | English |
| [FEATURES.md](./FEATURES.md) | Detailed feature documentation and automation API examples | 简体中文 |
| [CHANGELOG.md](./CHANGELOG.md) | Chronological record of features and fixes | 简体中文 |

> `FEATURES.md` and `CHANGELOG.md` are currently Chinese-only. The AI "Product Support"
> mode draws its knowledge from `README.md` + `FEATURES.md`, so feature questions are
> answerable there. The English README is intentionally **not** added to that knowledge
> source — indexing both languages would return duplicate chunks for every query.

## Tech Stack

| Layer | Technology |
| ------ | -------------------------------------------------------------------------------- |
| Desktop shell | Electron 45 (Chromium 156) |
| Build | electron-vite 5 + Vite 7 + pnpm |
| Frontend | React 19 + TypeScript + Ant Design 6 + React Router 6 |
| Backend | Express + TypeORM (embedded in the Electron main process; local API + automation API) |
| Database | MySQL (**bring your own server**; defaults to `127.0.0.1:3306`, `root` / `1234560`; database `roxy_browser` is created automatically on first launch) |

## Quick Start

```bash
pnpm install      # install deps (first run: allow electron's build script, see Notes below)
pnpm dev          # dev mode (Vite HMR + auto-restart Electron)
pnpm build        # production build (outputs to out/)
pnpm app          # launch the client from the production build
pnpm dist         # build the Windows installer (outputs to release/)

pnpm test         # run the full offline test suite (43 tests: compile shared modules + run each)
pnpm db:check     # read-only check for schema/entity drift (executes no DDL)
pnpm db:sync      # create tables + seed data (default admin / 123456, idempotent)
pnpm migrate:secrets        # encrypt legacy plaintext credentials (dry-run by default)
pnpm migrate:secrets --apply  # actually run the migration
pnpm clean:out    # reclaim stale build artifacts in out/ (dry-run by default; --apply to delete)
```

First launch creates the database, tables and a default account: **`admin` / `123456`**.

**Runtime behavior**: closing the main window does *not* quit the app — it minimizes to the
system tray while the local API and automation endpoints keep serving. **Single-click the tray
icon to reopen the main window**; to quit completely, right-click the tray icon → "Exit".

**App icons** (`resources/`): `icon.ico` is the brand icon (blue-purple gradient rounded
square + browser window + fingerprint), containing seven sizes from 16 to 256 for the exe /
installer / taskbar; `icon.png` (512) is used on Linux and in dev windows; `tray.png` (32) is
the tray icon. `src/main/index.ts` probes three paths in order for each: inside asar /
asar.unpacked / extraResources.

> **Port**: the default listener is `39100`, and it auto-increments when occupied. External
> scripts must not hardcode the port. After startup, read the real address from
> `~/.roxy-clone/api-base.json`:
>
> ```bash
> # Read the real API base (the port may not be 39100)
> API=$(grep -o '"apiBase":"[^"]*"' ~/.roxy-clone/api-base.json | cut -d'"' -f4)
> curl "$API/api/v1/profiles" -H "Authorization: Bearer <token>"
> ```

Database settings can be overridden with `DB_HOST` `DB_PORT` `DB_USER` `DB_PASS` `DB_NAME`.

## Database (Read This First)

This project **requires MySQL** (not an embedded database). The backend connects directly via
TypeORM; if MySQL is down or unreachable, startup fails with an explicit error — there is no
silent fallback. **Make sure a reachable MySQL is running before you start the app.**

### 1. Start a MySQL server (pick one)

The quickest route is Docker (port and credentials already match the defaults below; once it
is up, `pnpm dev` just works):

```bash
docker run -d --name roxy-mysql \
  -e MYSQL_ROOT_PASSWORD=1234560 \
  -p 3306:3306 \
  mysql:8.0 \
  --character-set-server=utf8mb4 --collation-server=utf8mb4_general_ci
```

> Wait a few seconds after starting the container (MySQL needs time to initialize); watch
> `docker logs -f roxy-mysql` for `ready for connections` before launching the app.
> Equivalents: a local MySQL 5.7+ / 8.0 listening on `3306`, XAMPP, or an existing MySQL
> instance — anything matching the connection settings below.
> **Port conflict?** If `3306` is already taken locally, change `-p 3306:3306` above to
> `-p 3307:3306` (host 3307 → container 3306) and start with `DB_PORT=3307`. No code changes.

### 2. Default connection settings

| Item | Default | Override |
| -- | -- | -- |
| Host | `127.0.0.1` | `DB_HOST` |
| Port | `3306` | `DB_PORT` |
| Force schema sync | off | `ROXY_FORCE_SYNC=1` |
| User | `root` | `DB_USER` |
| Password | `1234560` | `DB_PASS` |
| Database | `roxy_browser` (created if missing) | `DB_NAME` |

### 3. No manual schema setup — first launch initializes everything

When you run `pnpm dev` / `pnpm app`, the backend `bootstrap()` does, in order:

1. Run `CREATE DATABASE IF NOT EXISTS roxy_browser` (utf8mb4) as root;
2. Create / sync all tables via TypeORM `synchronize: true`;
3. Create the default administrator **`admin` / `123456`** (once, on first launch only).

So **no SQL needs to be run manually**: just open the app and log in with `admin / 123456`.

### 4. Optional: create the schema manually (`db/schema.sql`)

If you prefer "create the DB before starting the app" (e.g. for DBA review, or environments
where `synchronize` is restricted), the repo ships an equivalent script `db/schema.sql`
(containing `CREATE DATABASE` plus every table):

```bash
mysql -uroot -p1234560 < db/schema.sql
```

Use it **instead of** automatic `synchronize`, not in addition. The script is all
`IF NOT EXISTS`, so repeated runs are safe.

> If MySQL is not running, startup shows an error dialog: "Cannot connect to the database or
> start the service... make sure MySQL is running (default 127.0.0.1:3306, root/1234560)".

## Core Features

- **Profile management**: unlimited isolated profiles (each with its own `persist:env-{id}`
  session), batch open/close, group filters, trash, whole-profile export/import migration,
  manual proxy line switching.
- **Browser fingerprint**: UA / UA-CH / platform / language / timezone / resolution / CPU &
  memory / Canvas & Audio noise / **WebGL + WebGPU** / **full WebAudio characteristics** /
  WebRTC / font leak protection / geolocation; desktop and four mobile form factors, plus a
  fingerprint preset library. Kernel version switching (Chrome 150–154 major versions) with
  UA and UA-CH client hints kept in sync.
- **Proxy IP**: HTTP(S) / SOCKS5, one-click check (exit IP / region / latency / anonymity),
  IP-pool view, one-click assignment, scheduled checks, QR export, **self-healing** (automatic
  rebinding after consecutive failures, without ever creating a new IP linkage — see below).
- **Profile health check**: spoof score + consistency traffic lights — each configured
  fingerprint value is compared against the value **actually read back inside the profile
  window** (see below).
- **Online scan (external perspective)**: really navigate a profile window to third-party
  fingerprint test sites (PixelScan / BrowserLeaks / CreepJS / AmIUnique), capture page text
  + screenshot into a report. External sites judge from real-world population distributions,
  catching "mutually contradictory settings" or "a value outside the real population" —
  problems an in-app health check cannot see (see below).
- **Clone factory**: derive N copies from one parent profile — same behavior (OS / UA /
  language / timezone), different fingerprints (resolution / CPU / memory / GPU / fonts); see
  below.
- **Workspace snapshot**: package the entire team space (profiles + proxies + RPA + extension
  references) into a single JSON, import it on a new machine to restore everything; optional
  scheduled local backups; see below.
- **Multi-window sync**: keystroke/mouse-trajectory-level sync (stable selectors + relative
  coordinates inside elements + Bézier interpolation).
- **RPA scripts**: record & replay, variable substitution, scheduled runs, run logs, **script
  marketplace** (6 built-in presets, one-click install into "My Scripts").
- **AI Agent**: local Ollama by default (zero token cost), optional cloud BYOK; supports a
  "see screen → decide → act" execution loop.
- **Scheduled AI automation**: natural-language instructions + a timer that drives the AI
  Agent inside running profiles; after each run the action sequence is distilled into an RPA
  template (replayable offline, zero tokens next time); see below.
- **Team collaboration / account center / cookies / extensions**: role-based permissions,
  bulk account import, per-profile cookie isolation and bulk import, per-profile Chrome
  extensions.
- **Dashboard / automation API (v1)**: key metrics and trend charts; a Bearer-token local
  HTTP API for external schedulers. **All token write operations are logged** (actor recorded
  as `api:<token name>`; delete/import/export auto-flagged as sensitive), leaving no audit
  blind spots.
- **Two-factor authentication (2FA / TOTP)**: login requires an authenticator code in addition
  to the password; enable/disable by QR scan in Settings. TOTP uses Node's built-in crypto —
  no external dependency.
- **Revocable sessions**: logout and "sign out all devices" **revoke** all of that user's
  session tokens (no longer "clear local storage while the token stays valid server-side for
  7 days"); other devices get a 401 on their next request and are redirected to login (below).
- **Webhook notifications**: push operation-log events (profile create/open, proxy add/remove,
  team changes, AI Agent runs, ...) to your own service in real time for automation and
  auditing; HMAC-SHA256 signatures, a "send test" button in Settings, per-category
  subscriptions (including "all events"); see below.
- **Operation log export**: export the current filtered result to CSV / JSON in one click for
  audit retention; the export itself is logged (sensitive operation); available in all four
  UI languages; see below.
- **Team switcher**: switch workspaces between "teams I belong to" from the top bar without
  logging out; switching re-issues the session token with your **live role in that team** and
  closes profiles running under the old team, then reloads the page with all data scoped to
  the new team; see below.
- **Profile transfer**: a per-row "Transfer" action moves a profile (with its cookies /
  accounts) to another team. Cross-team data is strictly isolated by `teamId`, so "transfer"
  rewrites ownership to the target team; only teams you are also a member of are eligible.
- **Profile screenshot**: capture the current viewport of a running profile window as PNG
  (SEO reports, index checks, A/B test evidence, competitor research), downloadable from the
  dialog. The profile must be open first.
- **Geolocation spoofing (GEO)**: overrides `navigator.geolocation`, feeding coordinates of a
  "representative city" derived from the profile's timezone; coordinates and timezone stay
  mutually consistent, avoiding contradictory signals like "Tokyo timezone + New York coords".
- **Tracker blocking**: per-profile switch that blocks requests to known analytics / ad /
  telemetry domains (GA, GTM, Facebook Pixel, Hotjar, Mixpanel, ...), so repeated competitor
  research does not get you tagged by their pixels, cookies or third-party scripts. Only
  explicit analytics/ad subdomains are blocked — logins and normal CDN assets are unaffected.
- **Fingerprint depth (WebGPU / WebAudio)**: fills in two previously missing high-entropy
  dimensions, eliminating self-contradictions like "WebGL and WebGPU disagree" or "audio
  characteristics left bare" — contradictions that actively give you away.
- **EME / Widevine spoofing (P1 + P3)**: profile windows report Widevine + ClearKey to test
  sites (hidden entirely under iOS spoofing), and `getConfiguration()` reports a realistic
  CENC/CBCS capability set (initDataTypes including cenc/cbcs, covering avc/hevc/vp9/av1
  video and aac/opus/flac audio); avoids "iOS UA but Widevine exposed" or "resolves but no
  capability list". The health check's `eme` item verifies Widevine + ClearKey + CENC.
- **HTTP security warning (P2)**: navigating a profile window to a plaintext `http://` site
  injects a red banner warning that the connection is unencrypted and vulnerable to
  eavesdropping/tampering (localhost and app-owned pages are exempt), matching RoxyChrome
  154's HTTP Security Warnings.
- **Anti-automation trace removal (Tier 1)**: forces `navigator.webdriver = false` (hidden
  entirely under iOS spoofing) and removes global variables injected by CDP / ChromeDriver
  (`cdc_` / `$cdc_` / `__nightmare` / `callPhantom`, ...), avoiding detection by Cloudflare /
  PerimeterX. The health check adds an "anti-automation traces" item (weight 5).
- **Platform API consistency (Tier 2)**: hides capabilities the spoofed OS should not have but
  the host exposes natively — `bluetooth`/`usb` on all desktop + Android, `serial`/`hid` on
  desktop only, `nfc` on Android only, none on iOS — avoiding "iOS spoofing but desktop Web
  APIs exposed". Verified by a health-check item.
- **Media query preferences (Tier 2)**: `prefers-color-scheme` (light/dark/no-preference) and
  `prefers-reduced-motion` are driven deterministically by the fingerprint; `matchMedia`
  returns the fp value for exactly these two queries and passes everything else through to
  native. Verified by a health-check item.
- **Font depth checks (Tier 3)**: the font-leak patch extends from `document.fonts.check` /
  Canvas `measureText` to DOM width enumeration (both `style.fontFamily` assignment and
  `setProperty('font-family')` filter out-of-list fonts), closing the classic "set a font, read
  offsetWidth" side channel. A health-check item verifies `fp.fonts` against `fp.os`
  (core fonts present, no fonts exclusive to another OS).
- **Batch health overview (app layer)**: multi-select profiles → "Batch Health Check" runs the
  full check per profile server-side and aggregates average spoof score, pass count, and a
  **system-wide issue distribution** (sorted by number of failing profiles, quickly exposing
  shared misconfigurations such as the wrong OS font set or uncleared `webdriver`). Per-profile
  detail is expandable. Only **open** profiles are sampled; others are marked skipped.
- **Smart proxy allocation (app layer)**: multi-select → "Smart Allocate" assigns a
  **distinct** exit IP to each profile from the available pool. Supports country/type filters;
  profiles already on a compliant dedicated proxy are left in place, running profiles are
  untouched, and profiles that cannot be served are marked skipped (never force-reused).
  Core logic is a pure function `allocateProxies` (20 offline unit tests, all green).
- **Bulk account ↔ profile binding (app layer)**: select accounts in the Account Center and
  bind them all to one target profile in a single action (rewrites `AccountEntity.profileId`).
  Only accounts visible to the current user are affected (members can only move their own),
  and the target must be a valid non-template profile — no more editing accounts one by one
  in a dialog.
- **List search / filter / favorites (app layer)**: both the profile list and account list
  support keyword search (name/remark/platform for profiles; platform/account/remark for
  accounts), filters (group / owning profile / platform), combinable via backend GET params.
  Both have a star column and a "Favorites only" toolbar toggle; favorites live in browser
  localStorage (no DB column), with stale IDs pruned on deletion.
- **AI Assistant Planner (product support)**: a floating assistant queries all project data
  (profiles / proxies / accounts / cookies / logs / teams ...) in natural language; results
  carry **deep links** that jump to and highlight the relevant row. It can also execute
  actions with risk-tiered confirmation (safe = immediate / medium = confirm bar /
  destructive = strong confirm + audit). Sensitive data (`api_tokens` / `users`, password and
  token fields) is hard-blocked in the backend, returning "please do this manually" instead of
  query results; see below.
- **Rate limiting + login lockout**: sliding-window rate limits raise the cost of brute force;
  failed logins are counted **per username** with temporary lockout; lockout events are logged
  and pushed via webhook; see below.
- **Encryption at rest**: account passwords / proxy passwords / 2FA secrets / cloud API keys
  are all stored as AES-256-GCM ciphertext; the key comes from an env var or a local file and
  **never falls back to a hardcoded default**; legacy plaintext can be migrated in one step.
- **CDP debugging port**: optionally expose the profile windows to Playwright / Puppeteer and
  provide an exact "profile → target" mapping; **listens on 127.0.0.1 only**; see below.

For detailed module documentation and API examples see [FEATURES.md](./FEATURES.md)
(Chinese).

### Profile Health Check (spoof score + consistency traffic lights)

Click "Health Check" on any profile row (the profile must be open). The backend **executes
real JS inside that profile's window** to read back the effective fingerprint values, then
compares them item by item against the fingerprint stored in the database:

- **Spoof score 0–100**: weighted across UA / platform / language / screen / timezone / UTC
  offset / WebGL / UA-CH / CPU & memory / Canvas & Audio noise / WebRTC / font protection,
  each shown as "configured / measured / OK".
- **Consistency traffic lights**: whether proxy exit-IP country ↔ timezone ↔ browser language
  ↔ UA platform are mutually coherent — incoherence is a **high-risk linkage signal** (being
  coherent matters more than any single fingerprint looking realistic).
- Noise and protection switches are judged by **whether the patch is actually installed**,
  not by configuration: it checks whether prototype methods were rewritten (native methods'
  `toString()` contains `[native code]`) to verify Canvas / Audio / font protection are live.
- Environment limits do not produce false alarms: when no GPU is available and a WebGL
  context cannot be created, that item is marked "not applicable" with weight 0 — it is not
  reported as an injection failure.

### Clone Factory (batch derivation · same behavior / different fingerprints)

The most common operator request is "give me N more just like this one". But **copying a
fingerprint verbatim ties N accounts to the same device** — one comparison by the platform and
they all fall together. The clone factory therefore splits fields into two groups:

- **Keep (same behavior)**: OS, UA / UA version, platform, language, timezone, touch, device
  pixel ratio, noise switches, WebRTC policy — these decide "does it look like the same kind of
  user", and sharing them is what makes batch operations meaningful.
- **Jitter (different fingerprint)**: resolution, CPU cores, memory, GPU, fonts — the
  high-distinguishability device dimensions, unique per clone.
- Canvas / Audio noise needs no special handling: the preload noise seed is derived from
  `profileId`, so a new profile gets a new id and therefore naturally different noise.

**Usage**: select one parent profile → "Clone Factory" → enter a count (1–50) and a name
prefix → start.

> Cookies are **not** copied — copying login state actively creates linkage. Proxy bindings
> are not inherited either (assign them separately). Account records can optionally be copied.

### Profile Lifecycle / Expiry (optional expiry + list warnings + open interception)

Batch account operations always eventually need "this one should be retired". This project
deliberately has **no subscription billing** — expiry is just a lightweight "time to clean up"
signal.

- **No new database column** (project rule #24): expiry is stored inside the existing
  `ProfileEntity.fingerprint` JSON column (key `expiresAt`, ISO string), read/written by two
  pure functions `getEnvExpiresAt` / `withEnvExpiresAt` in `src/shared/envExpiry.ts`, shared
  by frontend and backend.
- **Key invariant**: `normalizeFingerprint` must **preserve** the custom `expiresAt` key.
  Normalization runs before every edit/import write; if it were dropped as an unknown field,
  the expiry would **silently disappear**. `tests/envExpiry.test.cjs` locks this down.
- **Three enforcement points**: an "Expires" column in the profile list (reusing the proxy
  expiry warning styling); a friendly interception before opening an expired profile; the same
  interception on batch open.

### Workspace Snapshot (whole-team packaging / migration + scheduled backup)

Anyone running multi-account cross-border operations eventually faces "new machine / reinstall
/ full migration" — exporting and re-importing profiles, proxies, RPA scripts and extensions
one by one is slow and error-prone. A workspace snapshot packages the **entire team space**
into one JSON file:

- **Contents**: the full single-profile structure for each profile (fingerprint / group /
  proxy / accounts / cookies / extension name references) + the proxy pool (with country,
  region, expiry metadata) + RPA scripts + extension metadata references.
- **One-click restore**: import on a new machine and everything comes back — proxies are
  reused by name (created from their details if missing), profiles are recreated with **fresh
  ids** to avoid collisions, and accounts/cookies follow their profile.
- **Reuses existing importers**: snapshot export/import directly reuses the logic from single
  profile migration, proxy batch import and RPA, so single-module and whole-team migrations
  share one code path — no "single export restores fine but the snapshot drops fields" drift.
- **Extensions are name references**: actual extension files cannot be serialized and are not
  included; only names are recorded. The importer remaps by name and ignores references with
  no local match (same as single-profile import).
- **Scheduled backups**: enable in Settings → "Workspace Snapshot" to write a JSON per team
  space to a local directory at a configurable hourly interval, keeping the latest 7 per team
  (older ones auto-pruned so the disk does not fill up). Missing or unwritable directories are
  silently skipped. It reuses the proxy-check `setInterval` scheduler; saving settings restarts
  it.

**Usage**: Settings → "Workspace Snapshot" card → "Export Snapshot" downloads `.json`;
"Import Snapshot" restores; the "Scheduled Backup" section below configures the toggle,
directory and interval.

### Scheduled AI Automation (natural language + timer + RPA distillation)

Turns the AI Agent execution loop into **unattended scheduled tasks**: one natural-language
instruction drives running profiles at a set interval, and the resulting action sequence is
distilled into an RPA template for offline, zero-token replay next time.

- **Configuration**: Settings → "Scheduled AI Automation"; each task has name / instruction /
  target profiles (multi-select) / interval (minutes) / max steps per run / enabled / distill
  into RPA template. Multiple tasks supported.
- **Scheduling**: reuses the proxy-check `setInterval` scanner
  (`AgentRunner.startAutoTaskScheduler()`, `src/main/agent/runner.ts`), debounced per task by
  `intervalMin`. Changes take effect immediately after saving — the scheduler re-reads
  `AppSettings.aiAutoTasks` every 60s, no restart needed.
- **Never opens windows automatically**: only **running** profiles are driven; targets that
  are not open are skipped with a log entry, never launched (same convention as RPA scheduling).
- **Visual pre-check**: each run performs the same vision-model pre-check as `agent:start`
  (local Ollama / cloud BYOK); if the model is not ready the round is skipped with a log entry
  instead of failing mid-loop.
- **RPA distillation**: with the option enabled, the `rpaSteps` from each profile run are saved
  as a new RPA script (scheduling off by default), owned by the source profile's team / creator
  — next time, replay offline via RPA with zero tokens.

> Prerequisite: this reuses the AI Agent loop, so enable and configure a local vision model
> (or cloud BYOK vision model) in Settings → AI Agent first. Target profiles must already be
> running.

### Webhook Notifications (real-time operation-log delivery)

Push "who did what in which profile" to your own receiver over HTTP POST, for ops bots, audit
archives or integration with external systems.

- **Trigger points**: reuses the single convergence point for operation logs (`writeLog` /
  `saveSchedulerLog` / `writeAgentLog`), so every action that writes a log triggers one —
  profile CRUD and open/close, proxy CRUD and allocation, team/member changes, account/cookie
  operations, RPA scripts, AI Agent runs, scheduled jobs, etc.
- **Configuration**: Settings → "Webhook Notifications", multiple entries; each with name /
  URL / signing secret (optional) / enabled / subscribed events. Subscriptions support "all
  events" or per-category (profile / proxy / team / account / cookie / RPA / AI Agent / login).
  Matching is "event name contains the keyword" (e.g. `profile` matches `create_profile` /
  `open_profile` / `batch_delete_profile`).
- **Delivery**: `fire-and-forget`, never throws or blocks the main flow; 8-second timeout;
  headers `X-Roxy-Event` (event name), `X-Roxy-Delivery` (unique delivery id for dedup),
  `X-Roxy-Signature: sha256=<HMAC>` (when a secret is set). Payload: `event` / `eventId` /
  `timestamp` / `teamId` / `actor` / `detail`.
- **Signature verification**: the receiver computes `HMAC-SHA256` over the raw request body
  with the same secret and compares it to `X-Roxy-Signature`. Leaving the secret empty disables
  signing.
- **Send test**: each entry has a "Send Test" button that fires a single delivery immediately
  (even while disabled) and returns the HTTP status — verify URL and secret before saving.
- **Performance**: webhook config is cached in memory (refreshed on settings read/save);
  event dispatch reads the cache, no DB query.

**Receiver example (Node)**:

```js
import { createHmac } from 'node:crypto'
import express from 'express'
const app = express()
app.use(express.json({ limit: '1mb' }))
app.post('/roxy-webhook', (req, res) => {
  const secret = process.env.ROXY_HOOK_SECRET
  if (secret) {
    const sig = 'sha256=' + createHmac('sha256', secret).update(JSON.stringify(req.body)).digest('hex')
    if (sig !== req.headers['x-roxy-signature']) return res.status(401).end()
  }
  console.log('[roxy]', req.headers['x-roxy-event'], req.body)
  res.sendStatus(200)
})
app.listen(4000)
```

### Operation Log Export (CSV / JSON)

Export the current filtered result (keyword / sensitive only) as CSV or JSON for audit
retention and offline analysis.

- **Backend**: `GET /api/logs/export?format=csv|json` (login required), exports only the
  current team's data, reuses the list's keyword filter, plus `sensitive=1` / `action` /
  `from` / `to` filters. CSV includes a UTF-8 BOM (so Chinese opens correctly in Excel), with
  columns `id, createdAt, teamId, userId, username, action, detail, sensitive`; `createdAt` is
  ISO UTC (unambiguous for audit), and fields containing commas / quotes / newlines are quoted
  and escaped.
- **Exports are audited**: the export itself writes an operation log (`export_logs`, flagged
  sensitive), so "who exported the logs" is also traceable.
- **Frontend**: `Logs.tsx` toolbar "Export" dropdown (CSV / JSON), fetches the file with a
  Bearer header and downloads locally (the token never enters the URL); filename comes from the
  `Content-Disposition` response header.
- **Pure-function unit tests**: CSV assembly lives in `src/main/logExport.ts` (same shape as
  `webhook.ts`, no express dependency); offline tests cover escaping / BOM / column order /
  JSON round-trips (19 passing).

### Team Switcher (multi-team workspace switching)

One login account can belong to several teams (memberships). The session token issued at login
carries a "current team `tid`", and all business data is isolated by it. The switcher changes
workspaces without logging out.

- **List**: `GET /api/auth/teams` (login required) returns all teams you belong to as
  `[{ id, name, role, isCurrent }]`.
- **Switch**: `POST /api/auth/switch-team` (login required, body `{ teamId }`) — verifies
  membership, re-issues the token with your **live role in that team** (`tid` changes, same
  7-day lifetime); closes all running profile windows beforehand (they belong to the old team
  and would otherwise fail with a `teamId` mismatch), and writes an audit log `switch_team`
  under the new team.
- **Frontend**: a top-bar dropdown; selecting another team swaps the local token and reloads
  the page, after which every list is scoped to the new team. With only one team, the dropdown
  shows just the current one.
- **Security**: re-issuing reuses the already-passed login state (including 2FA), so no code
  re-entry; the new role is read live from `team_members`, not from the old JWT, avoiding
  "changed the role but it did not take effect".

### Profile Transfer (cross-team)

The switcher enables the multi-team model while all data remains strictly isolated by `tid`.
Transfer lets you **move / share** a profile with another team: since isolation is by `teamId`,
a "transfer" rewrites the ownership of the profile and its related data.

- **Endpoint**: `POST /api/profiles/:id/transfer` (login required, body `{ teamId }`) —
  verifies the profile belongs to the current team and is not running; verifies the actor is
  **also a member of the target team** (otherwise you could push data into a team you cannot
  access); rewrites `ProfileEntity.teamId/ownerId`, cascades the profile's `Cookie` rows (which
  have their own `teamId` column) to the target team, and syncs `ownerId` on `Account` rows
  (which belong implicitly via `profileId`, with no `teamId` column). A sensitive
  `transfer_profile` audit log is written.
- **Frontend**: each profile row has a "Transfer" button; the dialog lists teams from
  `GET /api/auth/teams` that you belong to but are not currently in. After confirmation the
  profile disappears from the current list (ownership changed) and the success message names
  the target team. With only one team, a "cannot transfer" hint is shown.

### Profile Screenshot (viewport PNG)

Mirrors the "screenshot report" selling point in RoxyBrowser's SEO use case — capture the
current viewport of a running profile window as PNG for SEO rank checks, index checks, A/B
test evidence, competitor research, etc.

- **Endpoint**: `POST /api/profiles/:id/screenshot` (login required) — verifies the profile
  belongs to the current team, is not soft-deleted, and `status === 'running'` (like the health
  check, `capturePage` needs a real window context); calls `webContents.capturePage()` via
  `browserBridge.captureScreenshot`, returns the PNG as base64
  `data:image/png;base64,...`; writes an audit log `screenshot_profile`.
- **Frontend**: a "Screenshot" button (`CameraOutlined`) per row opens a dialog showing the
  image with its capture time and a "Download PNG" button (`downloadDataUrl` decodes the data
  URL into a Blob); when the profile is not running, the button hints to open it first.
- **Reuse**: the underlying capture reuses the AI Agent's existing `webContents.capturePage()`
  channel (`src/main/agent/session.ts`) instead of adding a second one.

### Geolocation Spoofing (GEO / navigator.geolocation)

Previously only timezone, language and proxy exit IP were spoofed; any page calling
`navigator.geolocation.getCurrentPosition()` would see the host's real coordinates (or error
out) — the last remaining hole in the fingerprint surface.

- **Data model**: `Fingerprint` gains `geoLatitude` / `geoLongitude` / `geoAccuracy`,
  linked to `timezone` — every `TZ_POOL` entry carries a "representative city coordinate"
  (e.g. `Asia/Tokyo → 35.6762, 139.6503`).
- **Injection**: `browser-preload.ts` replaces `navigator.geolocation` wholesale
  (`getCurrentPosition` / `watchPosition` / `clearWatch`) and returns the fingerprint coords.
  Replacing the whole object (rather than patching methods) bypasses Chromium's native
  location-permission flow.
- **Self-consistency (critical)**: jitter is deliberately tiny (random ±0.04° ≈ 4km, clone
  derivation ±0.03°) — enough to make profiles differ, small enough not to land in a
  neighbouring city/country and contradict the configured timezone and language. Legacy
  profiles (created before GEO existed) are backfilled in `normalizeFingerprint` by looking up
  coordinates from **their own timezone**, rather than from a random baseline.
- **Linkage**: changing the timezone in the profile form auto-follows latitude / longitude /
  accuracy to that timezone's representative city; manual fine-tuning is still allowed.

### Tracker Blocking (stealth hardening)

Mirrors RoxyBrowser's "block trackers / auto-clean fingerprints": repeatedly visiting a
competitor's site from the same profile can get you identified by their telemetry, cookies or
third-party scripts — even counter-monitored.

- **Implementation differs from other fingerprint items**: request interception can only happen
  in the **main process** — `browserManager.openWindow` attaches
  `session.webRequest.onBeforeRequest` to the profile session and cancels matches. A preload
  script runs in the renderer, can only change JS, and **cannot see network requests**. The
  hook must be attached before navigation, or the first page's analytics scripts already fired.
- **Rules**: `src/shared/trackers.ts` is a pure module (offline-testable) exporting
  `TRACKER_HOSTS` and `isTrackerUrl(url, extraHosts)`; a match is hostname equality or a
  subdomain suffix of a listed entry.
- **List principles (important — do not add carelessly)**: block **explicit analytics / ad
  subdomains only**, never the main domain — blocking `facebook.com` would prevent login,
  whereas blocking `connect.facebook.net` only removes the SDK and leaves login working. CDNs
  (jsdelivr / unpkg / cdnjs) and error reporting (Sentry / Bugsnag) are also excluded, or
  pages break and consoles flood.
- **Switch**: `Fingerprint.blockTrackers`, **on by default** for new profiles (like Canvas /
  Audio noise), individually switchable under the profile form's "Advanced Settings"; clones
  inherit the parent so batch accounts behave consistently.
- **Compatibility**: profiles created before this feature has no such field; following the
  "do not change existing profiles' behavior" rule, blocking is off for them until enabled in
  the form.
- **2.0: a host list alone misses things**. Telemetry scripts are often hosted on **your own
  site or a CDN** (`/gtag/js`, `/matomo.php`, `/analytics.js`) — the hostname is the site's own
  and will never match a domain list. `isTrackerRequest` therefore uses **two paths**: domain
  list + **subresource path signatures**.
- **No false positives (more important than the feature itself)**: path signatures apply only
  to **non-top-level documents** — anything in `mainFrame` is always passed through, otherwise
  a user sitting on a page whose URL happens to contain `gtag` would get a blank page.
  `localhost` / `127.0.0.1` / `10.x` / `192.168.x` private ranges and `blob:` / `data:` /
  `about:` are all exempt, protecting local development and intranet apps.
- **WebSocket / fetch / beacon covered**: in Chromium these also surface as `webRequest`
  events carrying a hostname, so the same rule covers them with no extra machinery.

### WebGL ↔ OS Consistency Guard (contradictions are worse than single wrong values)

The original WebGL health-check item only verified "configured == measured", which proves
**injection works**, not "does the combination look like a real person". What detection sites
actually look for is **contradiction**: iOS spoofing reporting an NVIDIA discrete GPU, Android
spoofing reporting a desktop GPU — combinations that do not exist in the real world and
amount to announcing "this profile has been modified".

- **Implementation**: `src/shared/webglOsMatch.ts`, pure function
  `webglMatchesOs(os, vendor, renderer)`, zero dependencies, offline tests
  (`tests/webglOsMatch.test.cjs`, 23 cases).
- **Rules tightened per OS**: iOS / macOS **must** be Apple (ANGLE always reports Apple);
  Android forbids desktop GPUs (NVIDIA / AMD / Intel) but allows Adreno / Mali / PowerVR;
  Windows / Linux conversely forbid mobile GPUs without mandating a specific desktop brand.
- **Legacy data does not false-alarm**: empty fields are marked "not applicable" (weight 0)
  and excluded from the total — distinguishing "environment limitation" from "injection
  failure" is a fundamental health-check principle.

### Fingerprint Depth (WebGPU + WebAudio)

The official product's iteration focus has shifted from feature breadth to **fingerprint
depth** (Chromium 150→153 kernel updates repeatedly adjusted WebGL output rules, WebAudio and
WebGPU). These two dimensions were previously empty here — a gap that **actively exposes you
through self-contradiction**.

**WebGPU** (`src/shared/webgpu.ts`): real Chrome's `navigator.gpu.requestAdapter()` exposes
`GPUAdapterInfo` (vendor / architecture), now routinely collected by creepjs, pixelscan and
browserleaks. Spoofing only WebGL while leaving WebGPU alone produces "WebGL says RTX 4090,
WebGPU says the host's integrated GPU" — **a contradiction is more suspicious than no spoofing
at all**; it tells the detector the environment was modified.

- **No new database column**: `info` is derived entirely from the existing `webglVendor` /
  `webglRenderer`, so it is naturally consistent with WebGL and **legacy profiles take effect
  with zero migration**.
- **Rewrite the real instance**: only the two non-enumerable getters `vendor` / `architecture`
  are overridden on the native `GPUAdapterInfo` instance, so `instanceof GPUAdapterInfo` still
  holds and the remaining fields (`subgroupMinSize`, etc.) keep coming from native. An early
  attempt that substituted a hand-made plain object turned those dimensions into `undefined`
  and broke `instanceof` — producing values a real browser could never emit.
- **Give up when unrecognized**: for an unknown model (a user-typed `webglRenderer`) return
  empty info so the health-check item becomes "not applicable", rather than falling back to
  some architecture that fights with WebGL.
- **Hide entirely on iOS**: iOS WebKit does not support WebGPU, so `navigator.gpu` must be
  removed when spoofing iOS.

**WebAudio** (`src/shared/webaudio.ts`): audio is one of fingerprintjs's core entropy sources.
Previously only `AudioBuffer.getChannelData` had noise added (**one dimension**), while the
values detectors more commonly collect — `sampleRate`, `baseLatency`, `maxChannelCount`,
`DynamicsCompressorNode.reduction` — were all bare.

- Derived deterministically from the profile seed: stable within one profile, different across
  profiles. `baseLatency` always equals `bufferSize / sampleRate` (128 / 256 / 512), so no
  self-contradictory numeric combination can appear.
- **Do not touch `OfflineAudioContext`**: its sample rate must equal the constructor argument;
  changing it desynchronizes the rendered result from the expected length, which is worse than
  not changing it. The patch is on `BaseAudioContext.prototype` and skips it via `instanceof`.
- **Deliberately no `outputLatency` injection**: on a real `AudioContext` with no audio playing
  this is 0; forcing 0.015~0.045 diverges from the real population while leaking almost no
  hardware information — the gain does not justify the risk of exposure.

Both feed into the **health check** (new items "WebGPU GPU" / "audio characteristics" /
"audio compressor reduction"), so injection status is visible in the report.

**Four items already delivered** (once listed as "future hardening" — do not treat as TODO):

- **Do not spoof WebGPU software-rendering fallback** (`webGpuSpoofAllowed`): when
  `adapter.isFallbackAdapter === true` (SwiftShader / llvmpipe), vendor / architecture are
  **not** overridden — otherwise a new contradiction appears ("WebGL says RTX 4090, WebGPU says
  software rendering"), extending the principle above. Wired into `browser-preload.ts` and the
  health check.
- **Pass subgroup sizes through natively** (`subgroupMinSize` / `subgroupMaxSize`): the
  "WebGPU subgroup sizes" item only checks the self-consistency "min ≤ max and > 0", weight 0.
- **Canvas noise derived per canvas** (`src/shared/canvasNoise.ts`): a detector's **first**
  check is "read the same canvas twice — do they match?". The noise seed is now derived from
  `(profile seed, width, height)`, so the same canvas always yields the identical noise
  sequence. Two extras: tiny canvases (< 8px, 1×N solid reference strips) skip noise to avoid
  anti-tamper solid-colour probes; a seed of 0 / NaN falls back to a `webglVendor` hash so
  seedless profiles do not all share one noise pattern and get clustered. The health check's
  `canvasNoise` item requires **consistency** (draw the probe twice, compare `toDataURL`) — a
  mismatch is a genuine injection defect, not an environment limitation.
- **WebAudio IAMF deliberately not injected**: IAMF is a **codec capability query**
  (`canPlayType` / `MediaCapabilities`), determined by Chromium version and OS, **not a
  hardware fingerprint**; the bundled Chromium does not support it natively, and faking it
  would create "claims support but cannot actually decode". The health check adds an
  informational "audio codec capability" item (weight 0) that truthfully displays the codec
  surface (IAMF / Opus / AAC).

> **Note for maintainers**: the Chinese original frames the IAMF decision with "Electron's
> bundled Chromium is below 152", which predates the current Electron 45 / Chromium 156
> kernel. The *decision* (do not inject IAMF) is unchanged; the version argument needs
> re-verification against the current kernel.

### Online Scan (external perspective)

The in-app health check is "writing your own exam and grading it" — it can only prove injection
works. Platforms actually identify accounts using **external detection sites**, which judge
"does this combination of metrics look like one person" against real population
distributions. The two are complementary and both are needed.

- **Sites**: four representative detectors covering "consistency → composite fingerprint →
  deep analysis → uniqueness" — PixelScan (proxy exit IP / timezone / language coherence, the
  closest to anti-linkage needs), BrowserLeaks (Canvas / WebGL / fonts / WebRTC measured),
  CreepJS (trust score / detected lies / entropy), AmIUnique (how large a sample makes your
  fingerprint unique).
- **Evidence first, judgment minimal**: detector DOM changes frequently, so parsing with exact
  selectors would rot. Only two robust things are done — grab visible page text + a screenshot
  as evidence, then extract relevant lines from the body using per-site `hints` keywords to
  aid reading. **No absolute pass/fail verdict is issued.**
- **Implementation**: `src/main/fingerprintScan.ts` (`SCAN_SITES` definitions, pure
  `extractHighlights`, page extraction script, `runSiteScan`); wired to profile windows via
  `browserManager.scanSite`, endpoints `POST /api/profiles/:id/scan` and `GET /api/scan-sites`,
  displayed inside the health-check report Drawer.
- **Concurrency safety**: only one scan per profile at a time (in-flight lock). Two overlapping
  navigations make the earlier read see the later site's page — "site says A, content is B" —
  which is fatal for a feature whose whole value is evidence, so it must be blocked.
- **Failures still produce evidence**: on network failure, dead proxy or a CAPTCHA
  (Cloudflare), the screenshot and error-page text are still attached where possible, and
  Chromium network error codes are translated into readable hints. Scan errors are also logged
  (these records are exactly the ones you most need to trace).
- **Does not navigate back**: after scanning, the window stays on the results page rather than
  returning to the start page — returning would reload and could drop login state or form data.
  Go back manually if needed.
- **Privacy notice**: this feature sends the profile window's real fingerprint to third-party
  sites; the UI states this in an explicit Alert. Use with caution on high-value account
  profiles.

### Rate Limiting + Login Lockout

**Risk assessment first, to avoid over-engineering**: the local API listens only on
`127.0.0.1` (`server.ts`: `s.listen(port, '127.0.0.1')`) and is **not exposed to the LAN** —
the external attack surface is already small. Rate limiting is therefore not about "network
attacks" but about two points that still hold:

1. **Malicious scripts in a browser**: `fetch('http://127.0.0.1:39100/api/...')` works from
   any page on the same machine. CORS blocks *reading* the response, not *sending* the request,
   so the same-origin policy does not help here.
2. **Login brute force**: any local process can hammer `/auth/login` indefinitely, and the
   default account is `admin / 123456` — without lockout, brute force costs almost nothing.

> Point 1 is now handled **server-side** by the local API request guard (2026-11-05,
> commit `9132735`): the Host must be loopback (blocks DNS rebinding), the Origin must be
> allow-listed, and `Origin: null` must carry a one-shot nonce — with **no CORS allow headers
> on rejection**. The previous blanket `app.use(cors())` has been removed.
> See `FEATURES.md` §9.1 / `VERIFY.md` §12 (both are Chinese-only documents).
> Rate limiting and login lockout cover point 2; the two are complementary.

- **Sliding window, not fixed window**: a fixed window (counter resets each minute) has the
  classic bypass — fill N at the end of one window and N more at the start of the next, for
  double the effective rate. A sliding window keeps per-request timestamps, so boundaries
  cannot be gamed. Logic in `src/shared/rateLimit.ts` (pure, offline-testable).
- **Failures counted per username, not per IP — the single most important decision here.**
  All local requests come from `127.0.0.1`; counting by IP means **everyone shares one quota**:
  an attacker hammering any account could lock out legitimate users too (self-DoS). Counting by
  username targets only the brute-forced account.
- **But per-username counting can be bypassed by rotating usernames** — so the registration
  endpoint is rate limited too (10/hour per client), otherwise an attacker could register new
  accounts to evade lockout.
- **Check lockout before comparing passwords**: an early check rejects immediately; comparing
  first lets an attacker keep submitting password attempts during lockout (no session, but
  password-probing capability preserved).
- **Reset the failure count when the lockout expires** — otherwise the user's first typo after
  unlocking locks them again, permanently. Implemented as **lazy cleanup** (`pruneHits` on the
  next call) with no extra timer.
- **Show remaining attempts only near the limit** (≤3 remaining): showing it earlier helps an
  attacker pinpoint the threshold.
- **Rejected requests do not consume quota**: counting them would incorrectly extend recovery.
- **Distinct status codes**: rate limit 429, lockout 423 (Locked), with `Retry-After` and
  `X-RateLimit-Remaining` headers.
- **Limits are memory-cached**: the middleware runs before every request; an `await
  getSettings()` each time would add a MySQL query and become a bottleneck under polling. The
  cache is invalidated on `PUT /settings` — "changes take effect immediately, no restart".
- **`/healthz` is exempt**: external schedulers may probe frequently; rate limiting it would
  make the service look dead.
- **Lockout events are logged and pushed via webhook** (`login_locked`) for alerting. At that
  moment there may be no login session at all (even a brute-forced non-existent username), so
  the system log entry is written with `tid=0` — "who is being attacked" matters more than
  "which team to file it under".

Settings → "Security" exposes three knobs: rate limit (0 = off), lockout threshold (0 = no
lockout), lockout duration.

### Operation Log Archiving (whole-month moves, no data deletion)

Audit logs are append-only; after six months a single table can hold millions of rows — lists
slow down and backups balloon. But **deleting destroys evidence**: discovering during an
incident investigation that "who exported cookies three months ago" was purged is
unacceptable.

So retention is **two-tier**:

| Zone | Table | Contents |
| -- | -- | -- |
| Hot | `operation_logs` | Recent N days (setting `logRetentionDays`, default 90); serves daily queries and exports |
| Archive | `operation_log_archives` | Older data, packaged **by whole calendar month**; excluded from the list endpoint, searchable on demand via "Operation Log → Archive" |

- **Split by calendar month, not a fixed day count**: "all logs from July 2026" is a
  deliverable audit period; "day 87 to day 102" is not.
- **Only archive *complete* months** (the easiest thing to get wrong): on 15 July with 30-day
  retention, 1–14 June is still inside the retention window. Cutting by a point in time would
  destroy evidence early. Logic in `src/shared/logArchive.ts`, locked by 40+ offline tests.
- **List only months that *actually have records***: a naive implementation would walk back from
  the boundary month to 1970 and produce 600 "archivable months", most empty — writing those
  into a batch id would display `1976-07~2026-06` and make users think they are archiving 50
  years. So the DB first buckets existing months via `DATE_FORMAT`, then intersects.
- **Month bucketing must use local time**: `toISOString()` would classify 1 January 00:xx as
  December of the previous year.
- **Every batch is reversible**: archiving is irreversible, but without an undo a single setting
  could destroy all audit evidence. Each batch has a `batchId` and a one-click restore to hot.
- **Irreversible operations have a pre-flight gate**: `validateArchive` refuses to run when
  "the oldest log is still inside the retention window" (a sign the time math is wrong) or a
  single batch exceeds 500k rows.
- **Batched, transactional moves**: one `DELETE ... WHERE createdAt < ?` over hundreds of
  thousands of rows would hold a table lock for a long time. Instead: read a batch → inside a
  transaction "insert into archive + delete from hot" → repeat until empty; each batch commits
  atomically.
- **dry-run by default**: manually triggering an archive defaults to `dryRun=true`, reporting
  the range without touching data; actually executing requires ticking a confirmation box in
  the UI.
- **Scheduled at 03:10, deliberately off the hour**: the top of the hour is crowded with cron
  jobs; offsetting avoids competing for disk I/O with proxy checks and RPA scheduling. Uses
  **recursive `setTimeout`** rather than `setInterval` — a fixed interval drifts further from
  03:10 after each run.
- Does not run at startup (would slow the first screen); changing retention via `PUT /settings`
  restarts the scheduler so the new range takes effect promptly.

### Encryption at Rest (AES-256-GCM)

Previously `accounts.password`, `proxies.password`, `users.twoFactorSecret` and
`app_settings.aiAgent.cloudApiKey` were **all stored in plaintext** — the project had no
crypto implementation at all. For a product whose selling point is "multi-account anti-linkage"
and which explicitly blocks `api_tokens` in queries, a single `mysqldump` yielding every store
account plus long-term 2FA takeover was a self-contradictory hard flaw.

- **Transparent encryption**: hooked into TypeORM's `ValueTransformer` (`secretTransformer` in
  `entities.ts`) so "encrypt on entering an entity, decrypt on leaving" is the default. **This
  is the only approach that prevents future code from forgetting to encrypt** — credentials are
  scattered across dozens of paths (account CRUD, proxy checks, exports, snapshots, RPA, AI
  assistant); a manual retrofit would inevitably miss some.
- **Four credential types covered**: `accounts.password`, `proxies.password`,
  `users.twoFactorSecret` (a leaked TOTP secret = long-term account takeover, as sensitive as
  a password), `app_settings.aiAgent.cloudApiKey` (a JSON column, which cannot take a
  Transformer, so it is funneled through `getSettings()` / `PUT /settings`).
- **Ciphertext format**: `rb1:<b64(iv)>:<b64(authTag)>:<b64(ct)>`. The prefix distinguishes
  legacy plaintext: pre-upgrade rows lack `rb1:`, and `decryptSecret` returns them **as is**,
  so reads are unaffected (lazy compatibility).
- **GCM, not CBC**: the auth tag makes a tampered ciphertext (DB edited, backup corrupted)
  **throw** instead of producing garbage plaintext. For "can this password log in", silently
  producing a wrong value is far more dangerous than an error. The upper layer is uniformly
  fail-closed and returns an empty string — a 500 on the whole list endpoint for one bad row is
  too costly, while an empty string causes login/connection failure (failing safely), never
  reuse of an incorrect password.
- **Key management** (`src/main/secretKey.ts`, same shape as `jwtSecret.ts`):
  `ROXY_SECRET_KEY` env var > `~/.roxy-clone/secret-key` persisted file > first-run random
  generation. **Never falls back to any hardcoded default** — that would rest all credential
  security on a public string. The JWT secret and the credential key are separate materials:
  leaking the former allows forging login state, leaking the latter exposes every credential.
- **Column widths were widened**: ciphertext is longer than plaintext (256 chars → ~385). A
  column still at 256 would be **silently truncated by MySQL**, showing up as "password
  mysteriously wrong" with the error far from the cause. Hence
  `accounts.password` / `proxies.password` / `users.twoFactorSecret` all use
  `SECRET_COLUMN_LENGTH = 512`.
- **Legacy migration**: `pnpm migrate:secrets` scans all tables and encrypts plaintext,
  **dry-run by default**, `--apply` to write; idempotent (rows already prefixed `rb1:` are
  skipped). Lazy encryption on read is not enough — long-unused profiles and abandoned proxies
  would never be read, so their passwords would sit in the DB as plaintext forever.
- **Note**: once the key file or env var changes, old ciphertext **cannot be recovered** (an
  inherent property of symmetric encryption, not a defect). Export a workspace snapshot before
  rotating. On decryption failure the app logs a prominent error explaining why.

Offline tests: `tests/secretCrypto.test.cjs` (40 cases) covering round-trips (including
Chinese / emoji / newlines / 256 chars), random IVs, tamper detection, wrong-key fail-closed,
legacy plaintext compatibility, empty-value semantics and key precedence.

### Session Revocation (logout really invalidates / sign out all devices)

Session tokens are `jwt.sign({...}, secret, { expiresIn: '7d' })` — **stateless**. Two
unavoidable problems follow:

1. "Logout" used to only clear localStorage on the frontend; the token stayed **valid for the
   full 7 days server-side**. If a token is stolen (XSS, log leak, backup file), an attacker can
   use the account fully until expiry — logout was security theater.
2. Users had no way to force all sessions of an account offline (e.g. suspected compromise).

- **Why `tokenVersion` rather than a JWT blacklist**: JWTs are stateless; revoking a single
  token requires a blacklist, which either grows forever or gets pruned incorrectly (**a missed
  deletion means a dead token stays valid**). What we actually need is "invalidate all sessions
  of a user" — logout, password change and admin force-offline all share that semantic.
  Incrementing `users.tokenVersion` (one integer) revokes every token for that user:
  **O(1), no storage, no cleanup**.
- **The cost is "changing the password logs out all devices"** — but that is exactly the
  **expected behavior** (if a password leaks, you want other devices kicked off), not a defect.
- **Upgrades do not kick users out**: legacy tokens missing `ver` are treated as version 0.
  Treating "missing" as invalid would instantly log out every online user at upgrade time.
  `tests/sessionRevoke.test.cjs` locks this down.
- **Reverse inconsistency is rejected too**: a token version **higher** than the current DB
  value (DB rolled back/reset, or a token from another environment) is also refused — allowing
  it would bypass revocation.
- **Issuance funneled into one entry point** `signSessionToken()`: previously five places
  hand-wrote their `jwt.sign` payloads; missing `ver` causes no compile error and no test
  failure, it just makes tokens from that path **never revocable**. Centralizing removes the
  possibility structurally.
- **2FA challenge tokens also carry `ver`**: otherwise a 5-minute challenge token issued before
  a password change could still be exchanged for a full token, bypassing revocation.
- **Frontend 401 auto-logout** (`api.ts` + `SessionGuard`): after server-side revocation,
  another device's next request gets a 401 and automatically clears the local token and
  redirects to login. Previously 401 was unhandled, so kicked devices would keep erroring with
  a dead token until someone manually cleared localStorage.
- **The logout request must be sent before clearing the local token**: after `clearToken()` the
  request no longer carries `Authorization`, server auth fails and revocation never runs —
  precisely the hole this feature fixes.
- **Endpoints**: `POST /api/auth/logout` (normal logout, **revokes this device only**),
  `POST /api/auth/logout-all` (sign out all devices), `GET /api/auth/session` (session
  status / expiry). Revocations write an audit log `logout`.

#### Device-level logout (normal logout no longer kicks other devices)

Previously `/auth/logout` and `/auth/logout-all` **were the same implementation** (both
incremented `tokenVersion`). Consequence: a normal "Logout" on machine A kicked machine B
offline for no reason — switching machines meant getting logged out, with no explanation and
no self-recovery. A classic "user is stuck and cannot get out" problem.

`tokenVersion` is **user-level** and cannot express device-level revocation, so a device
dimension was added:

- **Tokens carry a `dev` claim**: a device fingerprint is written at issuance and checked at
  validation. Issuer and validator **must share** `shared/sessionRevoke.deviceFingerprint()` —
  writing the hash rule twice will eventually diverge, showing up as "token still valid after
  logout" with no error at all.
- **Device fingerprint = hash of User-Agent (not raw UA)**: UA contains OS and browser version
  and is itself linkable user data; storing a hash leaves only an irreversible digest in the DB,
  matching the "no sensitive data at rest" convention, and prevents reverse lookup of devices
  from a UA.
- **Revocation list in `users.revokedDevices` (JSON text), not a new table**: revocation only
  matters for the token's lifetime, so `pruneRevokedDevices` reclaims by TTL with a hard cap of
  50 entries. A table + migration for a naturally bounded structure costs far more than it
  returns.
- **It must be bounded — the old blacklist problem**: without a cap, many devices logging out
  repeatedly would grow that column without limit. So appends **deduplicate** (same device keeps
  only the latest timestamp) and when full **drop the oldest** (nearest expiry, least harmful)
  rather than the newest.
- **Upgrades do not kick users out**: tokens missing `dev` (issued before this feature) **skip
  device-level checks** — treating missing as invalid would log out everyone online at upgrade.
  `tests/sessionRevoke.test.cjs` locks this down.
- **Fallback to all-device revocation when no fingerprint is available**: some proxies strip the
  UA header; **silently succeeding is not acceptable** (the user clicked logout but the token
  stays valid 7 days — the exact hole being fixed), so prefer kicking extra devices. The
  fallback path leaves a `console.warn` trace.
- **`revokeAllSessions` clears the revocation list**: `tokenVersion` already invalidated every
  old token, so every entry has nothing left to revoke and keeping them would wrongly kill a
  same-fingerprint device at next login.
- **Password changes still use `tokenVersion`**: when a password leaks, users do expect "all
  other devices offline" — existing correct behavior, unchanged by this work.
- **⚠️ Upgrading users must run `pnpm db:sync` manually** to add the `revokedDevices` column —
  `synchronize` now runs on demand (only on first table creation), so new columns will not
  appear automatically.

### Profile Data Partition Cleanup (`persist:env-<id>` lifecycle)

Each profile gets independent cookies / localStorage / IndexedDB / cache via
`session.fromPartition('persist:env-<id>')`. The `persist:` prefix means the data is **written
to disk** under `userData/Partitions/env-<id>/` — closing a window or quitting the app does not
clear it. There was previously **no cleanup logic at all**; this was a known gap.

- **Why cleanup is mandatory (two real consequences)**:
  1. **Unbounded disk/memory growth**: the more profiles and the longer they run, the more
     cookies and cache accumulate. The Notes section records a measurement where just three
     windows pushed process memory to 1.4GB; Chromium cache and IndexedDB are a large part.
  2. **Account cross-contamination (most severe)**: after a profile is permanently deleted,
     its MySQL cookie rows are gone, but Chromium's own localStorage / IndexedDB / Service
     Worker **remain on disk**. If an id is ever reused (clearing the DB, testing, reinstalling
     — all common), the new profile **inherits the previous profile's login state** — the one
     accident an anti-detect browser cannot tolerate.
- **Why not clean automatically**: partition data is part of the profile; clearing on window
     close would mean "losing the fingerprint" — a user closes and reopens a window expecting
     to still be logged in, and instead gets logged out. So automatic cleanup happens only at
     **permanent deletion**, the one unambiguous irreversible moment; a manual entry point
     handles space reclamation otherwise.
- **Two-step cleanup** (`browserManager.clearProfilePartition`): first
  `ses.clearStorageData()` + `ses.clearCache()` lets Chromium clear via its own indexes, then
  `rm -rf userData/Partitions/env-<id>` catches leftovers (Service Worker cache, Code Cache,
  GPU cache). Doing only the first step misses the second group.
- **Running profiles are always hard-blocked**: `clearStorageData()` deletes storage Chromium
  is actively using, so pages immediately show "login state lost / localStorage unreadable"
  with no explanation to the user. The check uses the **live window Map**, not the DB `status`
  — `status` can be stale after a renderer crash, and mistakenly clearing a running page would
  drop its login state, so the strictest source wins.
- **Cleanup failure does not block deletion**: the DB record is already gone; trapping the user
  in an error at that point helps nobody. Instead it logs via `console.error` and returns
  `partitionCleared: false`, with the audit log stating "browser data partition cleanup
  failed". **Failure is never silently swallowed** — that would regress to "deleted but residue
  remains" with nobody the wiser.
- **Decision logic extracted as a pure function** `shared/envPartition.ts`
  (`canClearPartition`), zero Node dependencies and offline-testable;
  `tests/envPartition.test.cjs` locks down the three high-risk branches: "hard-block running",
  "reject purge cleanup when not permanently deleted", "reject invalid ids".
- **Partition name funneled through `partitionName(id)`**: `browserManager` used to build the
  string inline while cleanup had to locate the same on-disk directory — duplicating that rule
  was bound to drift.
- **Manual entry point**: `POST /api/profiles/:id/clear-partition` plus a "Clear Browser Data"
  button in the list's action column (with a Popconfirm explaining the destructiveness). It
  allows clearing **profiles still in use** — disk pressure usually comes from long-used
  profiles and nobody deletes a profile just to clear its cache. Note that imported cookies are
  unaffected (re-injected by `seedCookies` on the next window open); what is lost is local
  storage / cache / non-persisted sessions.
- **Both deletion paths covered automatically**: single `DELETE /profiles/:id/purge` and bulk
  `POST /profiles/batch-purge` call the same cleanup function; the bulk path counts successes
  and writes them into its aggregate audit log.

### One-Click Consistency Fix (from "can diagnose" to "can repair")

The health check could find problems but users had to open the edit dialog and fix each item.
Most inconsistencies are actually **deterministically repairable** — timezone should follow the
proxy, language should follow the timezone, UA should follow the configured OS.

- **Anchor: which side is fact, which is configuration**. The same inconsistency can be fixed
  in two directions; choosing wrong breaks the side that was already coherent:

  | Inconsistency | Anchor (unchanged) | Side changed |
  | -- | -- | -- |
  | Timezone ↔ proxy country | **Proxy** (a paid external fact) | `timezone` |
  | Language ↔ timezone country | **Timezone** (already proxy-aligned) | `languages[0]` |
  | UA platform ↔ configured OS | **OS** (determines GPU pool / fonts / platform APIs) | `userAgent` + `platform` |

- **Only fix what is certain**: mobile UAs contain specific device models (Pixel 8 / iPhone 15
  Pro) that cannot be synthesized, so only bidirectional windows ↔ mac replacement is
  supported; everything else gets an **explicit reason it cannot be fixed** — otherwise users
  assume "cannot fix" means the tool is broken.
- **Three hard constraints**: running profiles are refused outright (changing a fingerprint does
  not affect an already-open window and would desync DB from window); `tzOffset` and `timezone`
  must be updated together; after fixing, a re-check is required (a stored field only counts as
  effective after one in-window measurement).
- **The assistant can fix too**: action `fixConsistency`, e.g. "fix this profile's consistency".
  There is an inherent conflict — **knowing which inconsistencies exist needs a health check,
  which needs an open window; but fixing needs the window closed**. The three consistency items
  happen to depend only on configuration + proxy country, not on measurement, so the assistant
  can compute them with windows closed; it shares `checkConsistency` with the health check so
  the two never disagree.
- **Newly exposed inconsistencies are handled in the same pass**: changing the timezone from
  Shanghai to New York makes the previously coherent "language ↔ timezone" incoherent. So all
  three items are passed in and re-evaluated against the intermediate repaired state, otherwise
  **fixing one creates another**.
- **No silent automatic modification**: the report drawer lists "fixable / needs manual" and
  shows the fields about to change in a confirmation, then a before → after comparison per
  field. Logic in `src/shared/healthFix.ts` (pure, 23 offline tests); consistency in
  `shared/healthcheck.ts`'s `checkConsistency` (11 tests).

### Health Check Baseline (detect "an injection change broke things" instead of relying on users remembering last week's score)

A single health-check report is **throwaway**. Yet when fingerprint injection code changes, one
bad change usually affects **every** profile — exactly the signal that should be caught
immediately, and exactly the hardest to catch by users re-checking manually: nobody runs a
batch check daily, let alone remembers a score from two weeks ago.

So batch checks include **baseline comparison**: after each run, per-check pass rates are
stored as a baseline; the next run compares item by item and alarms on collective decline
(log entry + webhook `health_baseline_regressed`), with the details shown in a red bar at the
top of the report.

- **Judge "collective degradation", not "one profile scored low"** — a single-profile
  fluctuation is usually network jitter or a changed proxy exit; all profiles dropping on the
  same item almost certainly means the injection code broke.
- **Two noise gates** (without them this becomes a noise generator on day one): minimum sample
  size **5** (otherwise "1 profile failed this item" = 100% failure and daily false alarms),
  and a decline threshold of **25 percentage points** (a 1–2 point dip is real-world noise).
- **No new database table**: the baseline lives in the `app_settings` singleton as
  `settings.healthBaseline`. First, existing users should not have to run `pnpm db:sync` on
  upgrade; second, injection logic is global — **what breaks is code, not one team's data**.
- **Baseline can be reset**: a "Reset Baseline" button in the report
  (`POST /api/health/baseline/reset`, idempotent). The baseline is built from the previous
  batch check; if that run hit a gateway hiccup or deliberately selected only the worst
  profiles, the baseline itself is skewed and every later check keeps false-alarming with no
  way out. **A diagnostic tool must not lock itself into a wrong baseline.** The confirmation
  dialog lists items whose "baseline pass rate < 50%", usually the root cause of false alarms.
- Logic in `src/shared/healthBaseline.ts` (pure, 18 offline tests).

### Expiry Alerts & Bulk Renewal (from "user has to ask" to "system tells you")

Both proxies and profiles can have expiry dates (an expired profile **refuses to open**, matching
the official product's subscription expiry). Previously this depended **entirely on users
remembering to look** — there was an expiry column and the assistant could answer "expiring in
3 days", but nobody proactively asks. Expiry is invisible until it suddenly fails, hence
proactive notification.

- **Scheduled alerts** (event `expiry_alert`): scan expiring / expired proxies and profiles,
  merge into one message per team, write an operation log + push webhook. Settings → "Expiry
  Alerts" (scan interval default 24h, lead time default 7 days, both disableable).
  - **Separate interval from proxy checks**: checks care about "does it work", alerts care about
    "how long it still works" — different time scales; coupling them prevents tuning one alone.
  - **On by default** (unlike invisible major changes such as "auto-change profile IP"), and
    **one scan runs at startup**.
  - **No duplicate spam**: the dedup key includes `expiresAt`, so each expiry item is reported
    once; changing the date allows a new alert.
  - Already-expired and soon-to-expire are **worded differently** — they demand different
    actions from the user.
- **Bulk expiry editing**: select profiles → "Bulk Change Expiry", three modes: extend each by
  N days (negative = move earlier) / set all to a specific date / clear expiry (permanent). The
  assistant can do it too ("renew these accounts by 30 days").
  - **Two honest reports**: profiles that were permanent are skipped (not silently given an
    expiry); profiles **still in the past after extension** are called out explicitly (an
    account expired six months ago +30 days is probably still expired, and reporting only
    "extended N" would make users think everything was renewed).
- Logic in `src/shared/expiryAlert.ts` (pure, zero dependencies, 25 offline tests); boundaries
  use `ceil` (23 hours left counts as 1 day) and `≤` (exactly 7 days counts as "expiring").

### Proxy Self-Healing (auto-rebind after failed checks, so profiles never run naked)

Scheduled checks used to simply set `proxies.status = invalid` and stop — **no follow-up at
all**. For matrix operations, one profile's proxy going down means that profile's exit IP
becomes the host's real IP; several going down at once can pile them onto the same IP — the
cardinal sin of anti-linkage.

- **Off by default**: automatically changing a profile's IP is an "invisible major change"; the
  user must explicitly opt in rather than have the app decide for them. Enable and set the
  threshold in Settings → "Proxy Check".
- **Three non-negotiable constraints** (the easiest traps when building this; all decisions live
  in the pure, offline-testable `shared/proxyHeal.ts`):

  1. **Never rebind two profiles to the same exit IP**. The naive "pick any available proxy"
     approach funnels all N failed profiles onto one new proxy — actively creating linkage,
     worse than the original failure. Selection therefore excludes proxies whose exit IP is
     already taken.
  2. **Never rebind to the same exit IP as the original proxy**. Different proxy addresses can
     share one exit IP (different access points from the same provider); switching to one
     changes nothing while still rewriting config.
  3. **Require a consecutive-failure threshold** (default 2 rounds). Network jitter and
     occasional detector timeouts cause single check failures; rebinding on one failure makes a
     profile's IP jump every few minutes — **itself a very strong automation signal** that also
     triggers platform risk controls.

- **Cross-profile deduplication (the most important implementation detail)**: if each profile
  decides independently, two profiles sharing one dead proxy will **both pick the same
  fallback** — healing "completes" while they still share an exit IP, so nothing was fixed and
  the user believes it was. `planProxyHealing` therefore tracks `claimedProxyIds` /
  `claimedExitIps` for the round and excludes them from later decisions.
  `tests/proxyHeal.test.cjs` locks this down with the "two profiles share one dead proxy" case.
- **Running profiles are not rebound**: a proxy change needs a window restart to take effect
  and would interrupt the user; leave them as is and explain why in the log.
- **If no compliant replacement exists, keep the current proxy and alert** — never settle.
  Better to leave a visibly failed proxy than to switch to one that creates linkage. The
  `proxy_heal_failed` log + webhook event fires (matches the `proxy` keyword in subscriptions).
- **A thrown check also counts as a failed round**: otherwise, during a general network outage,
  every `checkProxy` throws and healing never triggers.
- **The consecutive-failure counter is in-process state**, reset to 0 on restart — meaning a
  restart will not accidentally trigger bulk IP changes (better late than wrong).
- **Every rebind is logged** (`proxy_heal`, actor `system`) and can push the `proxy_heal`
  webhook for ops bots.

### CDP Debugging Port (external automation tools take over profiles)

Previously external automation could only "open/close profiles" through the local HTTP API and
could not actually **operate** pages — Playwright / Puppeteer / Selenium could not connect at
all, a half-closed system. With CDP enabled, external tools can drive running profile windows
directly.

- **Architectural difference (read this first)**: most anti-detect browsers run "one Chrome
  process per profile → one port per profile", and tools connect to a single profile via
  `connectOverCDP('http://127.0.0.1:<that profile's port>')`. **This is an Electron app**;
  profile windows are multiple `BrowserWindow`s inside one Chromium instance, and
  `remote-debugging-port` is a **process-level command-line switch** (set once before app
  ready, global). There is no "one port per window". The shape here is **one endpoint + many
  targets**: connect once and see every profile window.
- **Exact profile ↔ target mapping**: CDP gives external tools only `targetId + url + title`,
  with no way to tell "which target is which profile" — guessing from the URL breaks as soon as
  two profiles open the same site. `browser-preload.ts` therefore injects
  `window.__roxyProfileId` (non-enumerable, to minimize impact on detection surfaces); the
  main process evaluates it per target via `Runtime.evaluate` and maps targets back to profile
  ids, showing the result in a Settings table for tools to consume.
- **Config lives in a local file, not the DB — the trickiest part**:
  `app.commandLine.appendSwitch` must run **before** `app.whenReady()`, while MySQL is only
  connected inside `whenReady` (`bootstrap`) — **at the moment the setting is read, the DB is
  not reachable yet**. Storing the toggle in `app_settings` creates a startup deadlock: read
  setting → need DB → need whenReady → but the switch must be set before whenReady. So runtime
  reads only `~/.roxy-clone/cdp-config.json` (same "local config that affects startup" family
  as `jwt-secret` / `secret-key`); `app_settings` keeps a copy purely for Settings UI display.
- **Requires restart**: Chromium command-line switches cannot change at runtime; the Settings
  page says so explicitly. If the port is occupied it **auto-increments**, and
  `cdp-info.json` records the **effective** port — tools should read that rather than the
  configured value.
- **Security**: a CDP endpoint is **full browser control** (read pages, execute scripts, inject
  cookies). Hence: disabled by default, listens on `127.0.0.1` only (never `0.0.0.0`, so no LAN
  access), enable/disable are logged (`enable_cdp` / `disable_cdp`, sensitive operations), and
  Settings shows a prominent Alert.
- **Endpoints**: `GET /api/v1/cdp` (Bearer token) returns endpoint, effective port and target
  mapping; `GET/PUT /api/cdp` (login session) for the Settings UI.

```js
// Playwright: distinguish profiles by __roxyProfileId after connecting
const browser = await chromium.connectOverCDP('http://127.0.0.1:39222')
for (const ctx of browser.contexts()) {
  const page = await ctx.newPage()
  // ... use the profileId → targetId mapping from GET /api/v1/cdp
}
```

### Script Marketplace (RPA preset catalog)

Cross-border e-commerce / overseas social-media matrix operations repeat the same daily
actions. The marketplace turns these high-frequency flows into **built-in presets** — install
one from the RPA page's "Script Marketplace" tab into your own script library and replay it,
no recording from scratch.

- **Six presets by scenario**: `Google SERP Scraper` (SEO), `Index Check site:` (SEO),
  `Amazon Product Search / Price Compare` (e-commerce), `Competitor Price Monitor`
  (e-commerce), `Daily Login Check-in` (accounts), `Scheduled Social Post` (social).
- **Install = clone**: `POST /api/rpa/market/install/:id` clones the preset into a new script
  for the current team (owned by the current user, schedule reset); from then on it can be
  edited / replayed / scheduled like any normal script.
- **Preset design principles**: mostly `navigate` (open URL) + `wait` / `scroll`, so they are
  cross-site and runnable immediately; `input` / `click` steps that depend on DOM selectors are
  left as templates with a `note` telling users to adjust to their site's real DOM. Every
  parameterizable part is exposed as `{{variable}}` (substituted at replay by
  `substituteVars` in `shared/rpa.ts`); account passwords are never hardcoded into scripts.
- **Data locations**: `src/main/rpaMarket.ts` (main-process-only pure data module),
  `GET /api/rpa/market` lists the catalog, `POST /api/rpa/market/install/:id` installs;
  `Rpa.tsx` splits "My Scripts / Script Marketplace" into two Tabs.

### AI Assistant Planner (product support)

A floating bubble at bottom-right (hidden on the login page and full-screen browser page) that
answers natural-language questions about all project data — e.g. "which profiles are about to
expire", "which proxy expires within 3 days", "which profiles were deleted recently".

- **Can find it**: covers profiles / proxies / accounts / cookies / extensions / RPA scripts /
  operation logs / groups / teams. Every result has a **deep link** — "Jump to →" navigates to
  the page and highlights that row (profile and proxy pages are wired up).
- **Understands semantics**: "profiles about to expire" has no expiry field of its own; it maps
  to "the bound proxy's `expiresAt` is within the next 7 days" and adds "profiles using that
  proxy" to the result.
- **Can act (and stay controllable)**: actions are risk-tiered — `safe` (open profile, run RPA,
  health check) executes immediately; `medium` (assign proxy, rename, **create profile, import
  profile, bulk re-randomize fingerprint, bulk-bind proxies**) shows a confirmation bar;
  `destructive` (delete profile / proxy, bulk delete, transfer team, remove member) requires a
  strong confirmation dialog + sensitive audit. The criterion is not "how serious it looks" but
  **recoverability after a mistake**: anything reversible is medium; only actions with no
  per-item undo are destructive.
- **One confirmation for a batch action**: the `collect` orchestrator turns "change proxies for
  these 12 profiles" into **one** action instead of 12 — one click, not twelve. It coexists
  with the existing `forEach` (N rows → N independent actions, for "delete these 3 expired
  proxies one by one"); the proposal uses mutually exclusive `bulk` / `batch` fields so the
  frontend can render them differently. Ids are aggregated and deduplicated by the backend,
  invalid values removed, capped at 200 — **the model never enumerates them** (small local
  models frequently get long lists wrong).
- **Batch actions do not lie**: running / deleted profiles are skipped automatically (fingerprint
  changes, proxy binding and deletion never touch a running window), and the skip count is
  reported honestly in the reply; if everything was skipped, it errors instead of saying
  "processed 0".
- **No `closeEnv` action**: closing a window the user is actively working in could interrupt
  them, and the model has no way to know that kind of live context.
- **Sensitive data hard-blocked in the backend**: `api_tokens` / `users` cannot be queried at
  all; password / token / cookie-value fields are stripped, returning "this data is sensitive,
  please do it manually in the corresponding module". All three gates (sensitive blocking →
  read-only whitelist → action mapping) are enforced server-side and **do not rely on the model
  behaving**; queries use a whitelist + parameterized QueryBuilder with forced team / owner
  isolation.
- **Prerequisite**: enable in Settings → AI Agent. Default is local Ollama (`qwen2.5:7b`, zero
  tokens); cloud BYOK is also available.

## Directory Structure

```
src/
├── main/                     # Electron main process (Node environment)
│   ├── index.ts              # Entry: start local services → open main window
│   ├── server.ts             # Express + TypeORM: auth / middleware / rate limiting / schedulers + route registration (no inline routes; all business logic delegated to routes/*)
│   ├── browserBridge.ts      # BrowserBridge interface (types only, shared by server and routes/v1 to avoid reverse imports and circular deps)
│   ├── apiAudit.ts           # Automation API audit: method+path → action / detail derivation (pure, testable)
│   ├── webhook.ts            # Webhook engine: signing / event matching / fire-and-forget delivery (pure, testable)
│   ├── logExport.ts          # Operation log export (CSV / JSON) assembly: escaping / BOM / column order (pure, testable)
│   ├── entities.ts           # Table entities (users/teams/proxies/profiles/accounts/cookies/...) + credential encryption Transformer
│   ├── secretKey.ts          # Credential encryption key: env var > ~/.roxy-clone/secret-key > random generation (never a default)
│   ├── cdpManager.ts         # CDP port: app.commandLine switches / port probing / target→profileId mapping (Node side)
│   ├── agent/                # AI Agent: ollama.ts local model adapter + knowledge.ts knowledge retrieval
│   ├── browserManager.ts     # Profile window management: isolated sessions, proxies, cookie injection, sync forwarding
│   ├── browser-preload.ts    # Fingerprint injection script (injected into every page of every profile window)
│   ├── exporters.ts          # Reusable export/import primitives (single profile / proxy pool / RPA), shared by routes and workspace snapshots
│   ├── rpaMarket.ts          # RPA marketplace: built-in preset script catalog (pure data module, offline-testable)
│   ├── healthProbe.ts        # Health-check collection: execute JS inside a profile window, read back effective fingerprint values
│   ├── fingerprintScan.ts    # Online scan: site definitions / text extraction / navigation scan (runSiteScan, pure extractHighlights)
│   ├── cookieText.ts         # Cookie pure functions: entity→DTO mapping + Netscape / Set-Cookie / JSON text parsing (offline-testable)
│   ├── authScope.ts          # Shared account-isolation definitions: AuthedRequest type + isAdminRole / ownerScope / ownerAndWhere
│   ├── jwtSecret.ts          # JWT signing key: env var > ~/.roxy-clone/jwt-secret persisted > random (never a default)
│   ├── routes/               # Route modules split by domain (deps injected to avoid runtime cycles with server.ts)
│   │   ├── auth.ts           #   Auth: register / login / logout / session / team switch / 2FA (12 endpoints)
│   │   ├── settings.ts       #   Settings: API tokens / global settings / CDP port / webhook test
│   │   ├── logs.ts           #   Operation logs: list (take 500) + CSV/JSON export
│   │   ├── cookies.ts        #   Cookie management: CRUD / bulk import-export / inject into open windows now
│   │   ├── v1Cookie.ts       #   Cookie automation API (Bearer auth, filtered by teamId + profileId)
│   │   ├── proxies.ts        #   Proxies: CRUD / bulk import-export / pool status / allocation
│   │   ├── accounts.ts       #   Accounts: CRUD / bulk bind profiles / import-export (plaintext passwords visible to admins only)
│   │   ├── team.ts           #   Teams: member CRUD / email invite / accept invite / SMTP test
│   │   ├── extensions.ts     #   Extensions: upload or add local dir / fetch icon / delete (with on-disk rollback)
│   │   ├── rpa.ts            #   RPA scripts: CRUD / import-export / marketplace / record / replay
│   │   ├── assistant.ts      #   AI Agent & assistant: probes / chat / Planner actions / skill library
│   │   ├── trash.ts          #   Trash: list / restore / permanent delete / manual partition clear + two bulk endpoints
│   │   ├── profileCrud.ts    #   Profile CRUD: list / export / quick create / single CRUD / line switching / fingerprint presets
│   │   ├── profileWindow.ts  #   Profile window ops: open/close / health check / screenshot / online scan / template clone / cross-team transfer
│   │   ├── profileMigrate.ts #   Migration & batch: import / workspace snapshot / clone / bulk re-randomize / move·bind·delete·open
│   │   ├── system.ts         #   System & groups: window sync / open windows / system stats / profile new-tab page / group CRUD
│   │   └── v1.ts             #   Automation API v1: token auth + {code,data} convention + audit middleware
├── preload/index.ts          # Main-window preload: exposes the API base to the renderer
├── shared/                   # Shared by main and renderer processes
│   ├── types.ts              # DTOs and fingerprint types
│   ├── fingerprint.ts        # Random fingerprint generator (UA / timezone / GPU pool / GEO coords / anti-tracking switches)
│   ├── secretCrypto.ts       # Encryption at rest: AES-256-GCM + rb1: version prefix + lazy legacy-plaintext compatibility (pure, testable)
│   ├── cdp.ts                # CDP endpoint: port normalization / allocation / endpoint assembly (**zero Node deps**, also imported by renderer)
│   ├── proxyHeal.ts          # Proxy self-healing: threshold gate / compliant replacement selection / cross-profile exit-IP dedup (pure, testable)
│   ├── sessionRevoke.ts      # Session revocation: tokenVersion comparison / type checks (pure, testable)
│   ├── rateLimit.ts          # Rate limiting & login lockout: sliding window / failure counts / lockout expiry (pure, testable)
│   ├── logArchive.ts        # Log archiving: whole-month split / integrity checks / undo decisions (pure, testable)
│   ├── crashReason.ts       # Renderer crash classification: which reasons should reset status (pure, testable)
│   ├── pollBackoff.ts       # Polling backoff: auto-pause on 429, avoids "the more limited, the harder it hits" (pure)
│   ├── windowLimit.ts       # Concurrent window cap: prevents opening too many and crashing the main process (pure)
│   ├── trashBatch.ts        # Trash bulk ops: independent per-item decisions + result wording (pure)
│   ├── trackers.ts           # Tracker blocking: analytics / ad / telemetry domain list + isTrackerUrl decision (pure, testable)
│   ├── webgpu.ts             # WebGPU fingerprint: derive GPUAdapterInfo from WebGL vendor/renderer (pure, testable)
│   ├── webaudio.ts           # WebAudio fingerprint: derive sampleRate / baseLatency / channels / reduction from profile seed (pure, testable)
│   ├── canvasNoise.ts        # Canvas noise seed: deterministic from (profile seed, width, height), identical twice on one canvas (pure, testable)
│   ├── webglOsMatch.ts       # WebGL ↔ OS consistency guard: GPU brand vs OS contradiction detection (pure, testable)
│   ├── envExpiry.ts          # Profile expiry read/write (expiresAt inside fingerprint JSON, no new column; pure, testable)
│   ├── countries.ts          # 16 major cross-border e-commerce countries (code / Chinese+English name / IANA timezone / default language)
│   ├── locales.ts            # Supported languages (zh-CN / en-US / ja-JP / de-DE) + antd·dayjs package mapping
│   ├── timezone.ts           # IANA timezone utilities: local hour, UTC offset, DST detection
│   ├── healthcheck.ts        # Health-check comparison: configured fingerprint vs measured → spoof score + consistency lights (pure)
│   └── snapshot.ts           # Workspace snapshot: file structure + pure validation/normalization (no DB / Electron deps, testable)
└── renderer/src/             # React frontend
    ├── pages/                # Login, profiles, templates, proxies, accounts, cookies, team, logs, API, settings, new tab
    ├── i18n/                 # i18n: I18nProvider / useT / message dictionary / antd·dayjs locale bridge
    ├── components/ThemeSwitch.tsx  # Three-state theme switch (light / dark / auto)
    └── theme.ts              # Theme resolution: resolveDark / useIsDark (based on local time in the selected country)
```

## Notes & Pitfalls

> The Chinese original numbers this list with two `6`s, no `24`, and duplicate content at
> `18`/`27`. This translation renumbers them continuously 1–27 (keeping a note at #27) so the
> items can be referenced unambiguously. The Chinese README's "Core Features" list also has
> three entries run together on one line; they are presented as separate bullets here.

1. **pnpm build scripts**: pnpm blocks dependency postinstall scripts by default. If the
   `electron` binary was not downloaded, run `pnpm install` at the project root; to allow the
   scripts, run `pnpm approve-builds` and tick `electron` and `esbuild`.
2. **TypeORM + esbuild**: esbuild does not support `emitDecoratorMetadata`, so every `@Column`
   **explicitly declares `type`** (e.g. `type: 'varchar'`). Keep this convention when adding
   entity fields or you will get `Column type is not defined`.
3. **Column names**: no snake_case naming strategy is enabled; DB column names match property
   names (e.g. `teamId`). Never write `team_id` in a QueryBuilder.
4. **`ELECTRON_RUN_AS_NODE`**: if this env var is set in the current terminal, Electron starts
   in pure Node mode and `ipcMain` / `app` / `BrowserWindow` are all unavailable. The symptom
   is misleading — **build and startup logs look normal** (you even see `[roxy] API 服务已启动` /
   "API service started"), then it exits with
   `TypeError: Cannot read properties of undefined (reading 'on')`. Run
   `unset ELECTRON_RUN_AS_NODE` first (Windows PowerShell: `$env:ELECTRON_RUN_AS_NODE=$null`).
5. **Slow / stuck Electron binary downloads**: binaries come from GitHub Releases by default,
   often unreachable from mainland China. The npmmirror mirror is configured in **both**
   **`.npmrc`** and **`package.json`'s `config.electron_mirror`** — both are needed: pnpm v11
   does not pass the `.npmrc` value to a dependency's postinstall (measured:
   `npm_config_electron_mirror` is null, while `npm_package_config_electron_mirror` is passed).
   If it still hangs, fetch it manually via the mirror:
   ```bash
   cd node_modules/.pnpm/electron@<version>_*/node_modules/electron
   ELECTRON_MIRROR="https://registry.npmmirror.com/-/binary/electron/" node install.js
   ```
6. **Interrupted `pnpm add` corrupts node_modules**: if dependency installation is interrupted
   (e.g. electron postinstall fails), broken symlinks may remain, showing up as
   `Cannot find package 'electron-vite'`. Try `node scripts/fix-pnpm-links.mjs` first (rebuilds
   only electron-related links, does not overwrite typescript etc.); for a clean fix, delete
   `node_modules` and reinstall.
7. **`pnpm dev` opens no window / exits immediately** — check in this order (first two are most
   common):
   - **GPU crash**: in VMs, remote desktops and on old GPUs, Chromium repeatedly logs
     `GPU process exited unexpectedly` and finally terminates with
     `FATAL: GPU process isn't usable. Goodbye.` Hardware acceleration is disabled by default
     (`src/main/index.ts`; re-enable with `ROXY_ENABLE_GPU=1`).
   - **Broken dependency install**: on Windows, pnpm junction creation **fails without an
     error** — `pnpm install` still prints `Done`, but top-level `node_modules/<pkg>` links are
     missing, producing `Cannot find module`, `Cannot find package`,
     `_lruCache is not a constructor`, or a typecheck with hundreds of
     `Property 'x' does not exist` (types come from the missing package, degrade to `any`, and
     member access then fails). **Fix: delete `node_modules` and re-run `pnpm install` in a
     normal (non-sandboxed / unrestricted) terminal.** Do not hand-build symlinks — with
     multiple versions coexisting (e.g. `@babel/runtime` 7.x and 8.x) you can easily link a
     7.x dependency to 8.x and get near-untraceable errors like
     `Missing "./helpers/esm/..." specifier`.
   - **electron / esbuild binary missing**: `Error: Electron uninstall` or
     `Host version "x" does not match binary version "y"`. Binaries are downloaded by
     postinstall, which often fails in sandboxes. Fix: run
     `node node_modules/electron/install.js` (needs network); if that fails, do not use
     `--ignore-scripts` with `pnpm install`.
8. **Builds do not clean the output directory**: `electron.vite.config.ts` sets
   `emptyOutDir: false` to avoid bulk-delete failures in restricted environments. Set it to
   `true` for a clean build in a normal terminal, or use `pnpm clean:out` — it recursively
   resolves reachable chunks from the current build entry and **deletes only files proven
   unreachable** (dry-run by default, `--apply` to delete).
9. **Never store base64 images in a `text` column**: MySQL `text` caps at 64KB, while a base64
   image is often hundreds of KB or 1MB+. Using `text` silently truncates / fails the write,
   appearing as "uploading a large image neither errors nor saves". Use `longtext` (see
   `TeamEntity.icon`) and compress on the frontend before uploading.
10. **The JWT secret has no default**: on first launch it is generated with
    `crypto.randomBytes(32)` and persisted to `~/.roxy-clone/jwt-secret`; you can also set the
    `JWT_SECRET` env var. **Never fall back to a hardcoded default** — anyone with that value
    could mint JWTs and bypass all auth. After an upgrade, old tokens become invalid and one
    re-login is expected; deleting the file is equivalent to rotating the key.
11. **Run the tests before changing entities**: `pnpm test` compiles shared modules and runs
    the full offline suite (43 tests). Invariants like "`normalizeFingerprint` must preserve
    custom keys such as `expiresAt`" are locked by tests and turn red immediately if broken.
12. **Register new entities in DataSource**: `synchronize` only creates tables for entities
    **registered** in the `entities` array in `server.ts`. Missing one means the table does not
    exist on a fresh install (and `db/schema.sql` will not create it either), showing up as
    `ER_NO_SUCH_TABLE` on first use. After adding an entity, run `pnpm db:check` — you should
    see the corresponding incremental `CREATE TABLE`.
13. **New credential columns need `secretTransformer` and enough width**: any column in
    `entities.ts` with password/key semantics **must** carry
    `transformer: secretTransformer`, or it goes back to plaintext — encryption is automatic
    only at that layer, and bypassing the ORM (raw SQL, `QueryBuilder.getRawMany()`) yields
    ciphertext. JSON columns cannot use a Transformer, so encryption is funneled through
    `getSettings()` / `PUT /settings`; a new credential field inside JSON must also be added to
    `SETTINGS_SECRET_PATHS`. **Column width must exceed 256**: ciphertext is ~1.5× longer, so
    use `SECRET_COLUMN_LENGTH = 512`, or MySQL **silently truncates** it — presenting as
    "password mysteriously wrong" and very hard to trace.
14. **The credential key cannot be rotated**: once `~/.roxy-clone/secret-key` (or
    `ROXY_SECRET_KEY`) changes, all previous ciphertext **cannot be recovered** — inherent to
    symmetric encryption. Export a workspace snapshot before rotating. Conversely, deleting
    the file generates a new key and old data fails closed (login failure + a clear error log),
    never silently producing a wrong value.
15. **`src/shared/` must not import Node modules**: shared is used by both main and renderer;
    as soon as the renderer (`@shared/xxx`) references a file, Vite bundles it for the browser.
    Importing `net` / `fs` / `path` breaks the build with
    `Module "net" has been externalized for browser compatibility`. Split Node-capable logic
    into two files — pure logic in `shared/`, Node side in `main/` (e.g. `shared/cdp.ts` only
    normalizes ports and assembles endpoints; `probePort` lives in `main/cdpManager.ts`).
16. **New session-token `jwt.sign` calls must go through `signSessionToken()`**: a hand-written
    payload missing `ver` (session version) produces no compile error and no test failure — it
    just makes tokens from that path **never revocable**, silently breaking revocation and very
    hard to trace. See `shared/sessionRevoke.ts`. Likewise, any change that "requires clients to
    re-login" must also verify that the 401 branch in `api.ts` clears the local token and
    redirects to login.
17. **Splitting routes into `routes/` requires deps injection and no reverse import of server**:
    `routes/* → server → routes` creates a runtime cycle, and `AppDataSource` is an
    `export let` (assigned at runtime by `initDb`) — capturing it by value at module load gives
    `undefined`, showing up as "fails on first call" and only after startup. So always pass
    `getDs` as `() => AppDataSource`, and use `import type` across modules (erased at compile
    time). Even pure helpers like `clientKeyOf` belong in `shared/` to avoid a `routes → main`
    reverse dependency. Also mind **registration order**: static paths like `/logs/export` must
    be registered before `/logs`, or the dynamic route swallows them.
18. **Per-request logic must not hit the DB directly**: rate-limit middleware runs before every
    request; an `await getSettings()` each time adds a MySQL query and becomes a bottleneck
    under polling. Use an in-memory cache invalidated on writes (`PUT /settings`) — "changes
    take effect immediately, no restart". Likewise, `BucketStore` sweeps empty buckets on a
    timer, and that timer must be `unref()`'d or it keeps the app alive.
19. **`pnpm typecheck` can miss errors — discriminated unions are especially risky**:
    `tsconfig.node.json` enables `composite: true`, so `tsc` writes a `.tsbuildinfo` incremental
    cache and **skips unchanged files**. Measured: for a narrowing issue on
    `{ ok: true } | { ok: false; reason: string }`, `pnpm typecheck` reported zero errors while
    `tsc <single file> --outDir ...` (no cache) immediately reported
    `Property 'reason' does not exist`. The disagreement itself means the code is risky.
    **Mitigation: ① do not rely on narrowing — flatten fields into independent variables;
    ② when you suspect a miss, `rm -rf out-tsc *.tsbuildinfo` and re-run.**
20. **JSX short-circuit rendering leaks a "0"**: MySQL `tinyint` columns come back through
    TypeORM as **numbers** `0`/`1`, not booleans. So `{x.sensitive && <Tag>Sensitive</Tag>}`
    evaluates to the **number `0`** (not `false`) when `x.sensitive === 0`, and React renders it
    as the text "0" — every non-sensitive row gets a stray zero. **Rule: any JSX condition on a
    numeric field from the backend must be `!!x && ...`.** Same for `{x.count && ...}` and
    `{x.enabled && ...}` when the backend returns 0/1. Also declare the DTO field as
    `number | boolean` rather than `boolean` — declaring it boolean only fools the compiler,
    not the runtime.
21. **Startup no longer auto-syncs the schema — run it explicitly after entity changes**: to
    save ~156ms of schema comparison per launch (measured 163ms → 7ms), `bootstrap()` now only
    runs `SHOW TABLES LIKE 'users'` to check "do tables exist". **Fresh installs still create
    tables automatically** (measured: 16 tables after rebuilding the DB), but "tables exist yet
    a new column is missing" (upgrade from an older version) is skipped, showing up as
    `ER_BAD_FIELD_ERROR` with no startup hint. So: **after an entity change, always run
    `pnpm db:check` → `pnpm db:sync`**; for a quick workaround set `ROXY_FORCE_SYNC=1` for
    that launch. This is an intentional trade-off — `synchronize` can silently drop columns on a
    release build, so making schema changes explicit and reviewable is safer.
22. **A renderer crash leaves profile status stuck at `running`**: `win.on('closed')` is the
    **only** place that resets `status` to idle, but when the renderer crashes (page OOM, GPU
    failure, hundreds of tabs exhausting memory) it is the **renderer process** that dies, not
    the window shell — `closed` may never fire. `status` stays `running`, the user is blocked
    by "window is already running" when clicking Open, no window is visible, and **only an app
    restart recovers**. Three exits must be covered: ① `attachCrashGuards()` listens on
    `webContents.on('render-process-gone')` and actively destroys the window for
    `crashed`/`oom`/`launch-failed`/`integrity-failure`/`memory-eviction`/`abnormal-exit`
    (`clean-exit`/`killed` are normal paths — treating them as crashes misleads debugging);
    ② `openWindow()` uses `windows.get()` + `isDestroyed()` instead of `windows.has()` and
    prunes zombie entries; ③ `getRunningWindowIds()` filters destroyed windows or the UI
    reports phantom "running" profiles. **Note `render-process-gone` exists on both `app` and
    `WebContents` with different signatures** (3 args vs 2) — attaching to the wrong object
    means the event never fires. `getWindow()` / `getRunningWindows()` already guard with
    `isDestroyed()`; only `getRunningWindowIds()` was missing it.
23. **401 / 423 / 429 / 500 each have their own meaning — do not treat every `.catch()` as auth
    failure**: `Layout.tsx` once did
    `.catch(() => { clearToken(); navigate('/login') })` for `/api/auth/me`, so **rate limiting
    (429) was treated as session expiry**. 429 is easy to hit here — the default is only
    120/min, while the profiles page has two pollers (list 5s = 12/min + window status 3s =
    20/min) plus user clicks, so busy usage inevitably tops out. Users saw "switching menus
    frequently → suddenly logged out" with no apparent link to rate limiting. **Rules: ①
    `api.ts` throws `ApiError` (with `status` / `code` / `retryAfterSec`) and callers branch on
    `e.isSessionExpired` (401 only) and `e.isRateLimited` (429 only); ② back off by
    `Retry-After` — each 429 still counts as a request, so "the more limited, the harder you
    hit" keeps the window from ever recovering (see `shared/pollBackoff.ts`).**
24. **Too many profile windows crashes the entire app (not just the windows)**: measured main
    process ~**390MB** resident, plus **180–400MB** per profile window's renderer/GPU
    processes. Around the third window the whole process can exit — and it is the **main
    process**, so **all windows disappear and the local API stops serving**, interrupting every
    running profile. Root cause is resource accumulation approaching a system limit: Electron
    cannot obtain new GPU/renderer contexts and dies wholesale. **Two defenses**: ①
    `windowLimit.ts` blocks over-limit requests in `openWindow()` with an actionable message
    (current count / cap / memory cost / where to change it); the cap is configurable in
    Settings and 0 means unlimited — **a hard crash leaves users with nothing but repeated
    restarts**; ② `index.ts` installs `uncaughtException` / `unhandledRejection` handlers that
    show a dialog with **the window count and the reason at crash time** (Node previously
    terminated silently with zero context). Also note every profile uses a
    `persist:env-${id}` partition — **data is not released when a window closes**, so the more
    profiles you have ever opened, the more accumulates.
25. **Bulk operations need "independent per-item decisions + honest rejection reasons"**:
    permanent trash deletion is irreversible and each item can fail for different reasons
    (running, not in trash, not owned by you, state changed concurrently). Two bad approaches:
    ① "one failure aborts the batch" → user selected 50, two are running, and must retry dozens
    of times; ② "continue on failure without reporting" → user thinks all were deleted, a few
    remain, and are cleaned up later to their surprise. Correct: `planBatch()` decides each
    item into `okIds` / `rejected`, reports exactly how many succeeded and lists reasons
    (summarized beyond 3 to avoid flooding); the frontend uses **warning, not success** — a
    green toast implies everything succeeded. Two more: `planBatch` **deduplicates ids** (no
    double-delete); `GET /profiles/trash` **must return `status`** — trashed profiles are
    theoretically idle, but a soft-deleted one can be relaunched by RPA/automation, and without
    `status` you would misjudge and delete a running profile.
26. **Do not implement bulk operations as "loop over the single-item endpoint"**: 50 profiles =
    50 auth checks + 50 log writes, slow and likely to trip rate limiting; on a mid-run failure
    the frontend cannot distinguish "done" from "not done", so retries duplicate operations;
    and logs get 50 lines. Use an aggregate endpoint + one audit log entry. `ownerScope` is
    **even more important** on bulk paths — bulk endpoints are a prime vector for bulk
    privilege escalation, so never trust ids supplied by the frontend.
27. **`pnpm typecheck` can miss errors — discriminated unions are especially risky** (duplicate
    of #19 in the Chinese original, kept here to preserve numbering): `tsconfig.node.json`
    enables `composite: true`, so `tsc` writes a `.tsbuildinfo` incremental cache and **skips
    unchanged files**. Mitigation: flatten fields into independent variables
    (`const bad = v as { ok: false; ... }` rather than `else` + narrowing) and, when in doubt,
    `rm -rf out-tsc *.tsbuildinfo` before re-running.

## Packaging & Distribution

```bash
pnpm icon         # generate resources/tray.png and resources/icon.ico (pure Node, no third-party deps)
pnpm dist         # build + package the Windows installer (NSIS + portable) → dist/
pnpm dist:dir     # portable unpacked directory only → release/win-unpacked/ (faster for debug distribution)
```

Packaging config lives in **`electron-builder.yml`**. `README.md`, `README.en.md` and
`FEATURES.md` are listed under `files`, so installed builds still ship the docs:

- `appId: com.roxyclone.browser`, product name `RoxyBrowserClone`, Simplified Chinese installer
  wizard (`nsis.language: 2052`)
- Custom install path, desktop and Start Menu shortcuts
- Both an NSIS installer and a Portable build:
  - `dist/RoxyBrowserClone-1.0.0-win32-x64.exe` (≈84 MB, installer)
  - `dist/RoxyBrowserClone-1.0.0-win32-x64-Portable.exe` (≈75 MB, double-click and go)
- `resources/` goes into `app.asar`; the tray icon is probed across three paths
  ("inside asar / asar.unpacked / extraResources", `trayIconPath()` in `src/main/index.ts`)
- Mainland China mirrors: Electron uses `.npmrc`'s `electron_mirror`; builder binaries use the
  env var
  `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`

### Code Signing (eliminate the SmartScreen "unknown publisher" warning)

Signing is off by default (with no certificate on a local machine / CI, electron-builder skips
it with a warning and does not break the build). For official distribution, set these env vars
on the signing machine and run `pnpm dist`:
- `CSC_LINK`: path or download URL of the Authenticode code-signing certificate (`.pfx`) — an
  EV certificate is recommended for faster SmartScreen reputation
- `CSC_KEY_PASSWORD`: the certificate's private-key password

> electron-builder automatically signs the main `RoxyBrowserClone.exe` and the NSIS installer;
> the Portable build is a self-extracting 7z archive and cannot be signed — internal
> distribution only.

### Auto Update (electron-updater)

- `electron-updater` is integrated: the installed build silently checks once at startup; the
  "About" section in Settings offers a manual "Check for Updates" with one-click download and
  install (no automatic download, so it does not interrupt multi-account work).
- The update source is `publish.generic` in `electron-builder.yml` (placeholder default
  `https://update.roxyclone.com`). For production, point it at your own update server, or
  override at runtime with `UPDATE_FEED_URL`.
- Running `pnpm dist` generates `latest.yml` plus the installer and uploads them to that
  address; installed builds use it for differential updates.

> **Known environment limitation**: in restricted terminals (e.g. an IDE terminal with
> delete-protection sandboxing), electron-builder may error during final temp-file cleanup,
> **but the installer has already been produced at that point** — a harmless warning that does
> not occur in a normal terminal. If a stale `release/` directory cannot be cleaned, use
> `-c.directories.output=<new directory>` to switch the output path.
