# AirAcademy SCORM Builder

`@runpoint-partners/airacademy-scorm-builder` v0.1.0

The **single canonical** SCORM courseware renderer for the AirAcademy migration. It builds the
per-course player HTML (resolving and re-hosting all media from Ascent to S3), generates the SCORM
2004 manifest, generates the launcher shell, and packages the whole thing into a deployable ZIP.

Extracted from `Runpoint-Partners/AirAcademy` (`packages/course-builder`) on 2026-06-05 so there
is exactly **one** version, tracked as a pinned dependency. This is the build side of Production
**Surface 2** (the per-course launchers); the shared player (Surface 1) is owned by
`AirAcademyOWS`.

---

## Who uses this

| Consumer | How it imports |
|---|---|
| **AirAcademy-Migrator-Courses** | `file:../AirAcademy-SCORM-Builder` (relative sibling path in that repo's `package.json`) |
| **AirAcademyEditor** | Same pattern — sibling directory |

Both repos depend on this via a **relative `file:` link**, so this directory must be a **sibling**
of those repos on every machine:

```
<parent>/
  AirAcademy-SCORM-Builder/    ← this repo
  AirAcademy-Migrator-Courses/ ← package.json references "file:../AirAcademy-SCORM-Builder"
  AirAcademyEditor/            ← same
```

A missing or misplaced sibling causes `npm install` to fail loudly — there is no fallback.

---

## Public API (exports)

```js
// All three entry points are CommonJS modules.
const { buildPlayer, loadCourseData, generateIndexHtml } =
  require('@runpoint-partners/airacademy-scorm-builder/build-player');

const { resolveMedia, loginToAscent, downloadHashFile, uploadMediaToS3, /* … */ } =
  require('@runpoint-partners/airacademy-scorm-builder/media-resolver');

const { createScormPackage } =
  require('@runpoint-partners/airacademy-scorm-builder/scorm-package');
```

### `build-player` — `src/player/build-player.js`

| Export | Signature | What it does |
|---|---|---|
| `buildPlayer(options?)` | `async (opts) => { outputPath, courseData, mediaReport }` | Full pipeline: loads module JSON from disk, logs into Ascent, resolves all media to S3, writes `index.html` + `media-report.json` to `outputDir`. |
| `loadCourseData(moduleDir)` | `(string) => Object` | Parses `module_<id>.json` + per-page JSON files into a structured `courseData` object (pages, sections, quiz, timer). Handles nested sub-folder sections (OP-580 fix). |
| `generateIndexHtml(courseData, manifest)` | `(obj, {base, assets[]}) => string` | Renders the final `index.html` — a thin shell that references the shared player **named by the deployed manifest** (`{base, assets}`). Inline mode was removed; pass `loadPlayerManifest()` output (or let `buildPlayer` do it). |
| `loadPlayerManifest(implementation?)` | `async (string) => {base, assets[], ...}` | Fetches `player-manifest.json` the player repo publishes to S3. `'javascript'` (default) → `player/v1`; `'vue'` → `player/v2`. `AAA_PLAYER_MANIFEST_URL` env overrides. Throws loud if absent (no vendored fallback). |
| `formatIso8601Duration(ms)` | `(number) => string` | Utility: converts milliseconds to ISO 8601 duration string. |

`buildPlayer` options:
- `moduleDir` — path to the module data directory (default: `../../data/module_100007`)
- `outputDir` — where to write `index.html` and `media-report.json` (default: `../../build/player`)
- `ascentCookies` — optional pre-authenticated Ascent cookie string (pipeline passes this to avoid per-course login)
- `playerImpl` — `'javascript'` (default, `player/v1`) or `'vue'` (`player/v2`). Selects which deployed player the shell references (reads its manifest). Default output is byte-for-byte the live JS player.

### `media-resolver` — `src/player/media-resolver.js`

Resolves all three media categories found in Ascent course HTML, uploads them to the `aaa-courses`
S3 bucket, and rewrites the HTML to point at S3:

| Category | Pattern | Resolution strategy |
|---|---|---|
| Public Ascent media | Relative `/files/media_library/`, `/content/`, `/media/` paths; absolute `ascent.aerostudies.com` URLs | Download (no auth needed), upload to S3 `courses/{net}/{course}/v{ver}/media/ascent/…` |
| Hash-based file URLs | `/files/{networkId}-{hexhash}` (auth-gated) | Authenticate to Ascent, try post-migration host first then legacy host, upload to S3 |
| Vzaar/Vimeo iframes | `<iframe class="vzaar-video-player" src="/content/showVideo/{id}">` | Strategy A: use fallback `<video>` sibling; B: check S3 cache; C: browser → HLS → yt-dlp; D: placeholder |

Key exports:

| Export | Description |
|---|---|
| `resolveMedia({ html, networkId, courseId, version, ascentCookies })` | Top-level resolver — runs all three passes and returns `{ html, report: { resolved, failed } }` |
| `loginToAscent(username?, password?)` | Authenticates to Ascent; uses `ASCENT_USERNAME` / `ASCENT_PASSWORD` from env if not passed |
| `downloadHashFile(url, cookies)` | Downloads an auth-gated hash file; tries multiple Ascent hosts |
| `cachedDownloadHashFile(url, cookies)` | Same but checks `_referenceDownloadCache` first |
| `uploadMediaToS3({ buffer, key, contentType })` | Idempotent S3 upload (HeadObject check); returns direct public S3 URL |
| `uploadReferenceToS3({ buffer, key, contentType })` | Force-upload (no idempotency skip) for reference attachments |
| `withSharedAssetLock(key, fn)` | In-process exclusive lock for shared reference assets |
| `findReusableReferenceSource(refPath)` | Finds a previously uploaded reference at the shared prefix |
| `findSharedReferenceSource(refPath)` | Checks the shared S3 reference cache |
| `uploadSharedReferenceToS3(opts)` | Uploads to the shared reference cache prefix |
| `copyReferenceFromS3({ sourceKey, key })` | S3-to-S3 copy for reference reuse |
| `deleteStaleRefFiles(prefix, safeName, ext)` | Removes stale same-name files with wrong extension |
| `hashFileCandidateUrls(url, hosts?)` | Pure helper: builds ordered list of absolute URLs to try (unit-tested) |
| `findHashFileUrls(html)` | Scans HTML for hash-based file URL patterns |
| `resolveHashFiles(html, opts)` | Resolves hash files (I/O ports injectable for testing) |
| `summarizeUnresolved(entries)` | Summarizes failed resolution entries |

Env vars read by the resolver (from `.env` at workspace root or process env):

| Variable | Default | Purpose |
|---|---|---|
| `S3_BUCKET` | `aaa-courses` | S3 bucket name |
| `AWS_REGION` | `us-east-2` | S3 region |
| `S3_CONTENT_PREFIX` | `courses` | S3 key prefix for course content |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | — | S3 credentials |
| `ASCENT_USERNAME` / `ASCENT_PASSWORD` | — | Ascent login |
| `ASCENT_URL` | — | Alternate Ascent host (added to candidate list) |
| `MEDIA_CACHE_DIR` | — | Optional local FS cache directory (read-only; pre-populated externally) |
| `MEDIA_RESOLVER_CONCURRENCY` | `15` | Max parallel downloads/uploads |
| `MEDIA_RESOLVER_HTTP_TIMEOUT_MS` | `30000` | HTTP request timeout |
| `MEDIA_RESOLVER_S3_TIMEOUT_MS` | `120000` | S3 request timeout (large videos need longer) |
| `MEDIA_RESOLVER_RETRY_ATTEMPTS` | `3` | Retry budget for transient failures |
| `PLAYER_PAGE_RESOLUTION_CONCURRENCY` | `4` | Page-level concurrency in `buildPlayer` |
| `SKIP_VIMEO_BROWSER_RESOLUTION` | — | Set to `1` to skip browser-based Vimeo resolution |

### `scorm-package` — `src/scorm/package.js`

| Export | Signature | What it does |
|---|---|---|
| `createScormPackage(opts)` | `async (opts) => Buffer` | Returns a ZIP buffer containing `imsmanifest.xml` (SCORM 2004 4th Ed.) + `launcher.html` |

Options: `courseId`, `networkId`, `courseName`, `contentVersion`, `contentBaseUrl?`, `contentUrl?`

The launcher (`src/scorm/launcher.js`) reads `runtime/launcher-template.html` (vendored from the
player repo) and substitutes six placeholders: `{{CONTENT_BASE_URL}}`, `{{COURSE_ID}}`,
`{{NETWORK_ID}}`, `{{CONTENT_VERSION}}`, `{{ALLOWED_ORIGIN}}`, `{{CONTENT_URL}}`.

---

## Runtime assets (`runtime/`)

Only **one** file is vendored: `launcher-template.html` — the per-course SCORM launcher baked into each
ZIP by `src/scorm/launcher.js`.

| File | Role |
|---|---|
| `launcher-template.html` | Template for the per-course SCORM launcher |

**Current sync:** commit `3f410c8` (2026-06-18). See `runtime/PROVENANCE.md`.

**To refresh after a launcher change:**
```bash
scripts/sync-runtime-assets.sh /path/to/AirAcademy   # copies launcher-template.html only
```

### The player is NOT vendored (shared-player only)
`player.js` / `player.css` / `scorm-client.js` are **no longer here**. A built course is a thin shell
that references the player deployed centrally to S3 by `AirAcademyOWS` (`player/v1/`). The builder reads
the base URL + asset list from the **`player-manifest.json`** that the player deploy publishes
(`build-player.js` → `loadPlayerManifest`) — a single source of truth, no vendored copy to drift. A player
change reaches every live course centrally; the builder is re-run only for **content** or **launcher**
changes, never for a player update.

---

## Install / version / tag flow

This package is **not published to a registry**. Consumers install it as a relative `file:` sibling
path (see above). Versioning:

1. Make changes and test (`npm test`).
2. Bump `version` in `package.json` (semver).
3. Commit and push to GitHub (`Runpoint-Partners/AirAcademy-SCORM-Builder`).
4. Consumers update their lock file by running `npm install` in their repo.

The TS rewrite will ship as a **major version bump** with compiled `dist/*.js` + `*.d.ts`.
Pre-extraction history is preserved in `Runpoint-Partners/AirAcademy` under the `archive/*-20260604`
tags.

---

## Build / test

```bash
npm install       # installs aws-sdk, archiver, dotenv
npm test          # node --test "src/**/*.test.js"
```

There is **one test file**: `src/player/__tests__/media-resolver.test.js`. It is hermetic (no
network, no S3 — I/O ports are injected). It encodes the OP-599 defect contract: failed hash-file
downloads must never silently leave a bare root-relative `/files/` ref in the HTML.

Node >= 20 required.

---

## Host prerequisites (not in npm deps)

The resolver shells out to system binaries for legacy video handling:
- **`ffmpeg`** — transcodes `.wmv`/`.mov`/`.avi` sources to `.mp4` for browser compatibility
- **`yt-dlp`** — downloads Vimeo HLS streams when Strategy A/B fail

These must be on the host PATH. The CBOT build host satisfies both. A missing binary causes that
video resolution path to fail (the build still completes; broken assets are logged to
`media-report.json`).

---

## Surface 2 — what this builds

This repo produces the **build inputs** for Production Surface 2 (per-course SCORM packages). The
actual build + publish flow — SCORM ZIP creation, S3 upload, Docebo course registration — runs from
**`AirAcademy-Migrator-Courses`** (and optionally `AirAcademyEditor`), which call this package's
exports. Changing the player embed or media logic in this repo requires re-running the migrator to
rebuild affected courses; it does NOT auto-update live courses (unlike the shared player on Surface
1).
