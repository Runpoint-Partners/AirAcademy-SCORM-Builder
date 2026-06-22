# AGENTS.md — AirAcademy-SCORM-Builder

Working guide for any coding agent. Self-contained; no Claude-specific assumptions.

---

## What this repo is

`@runpoint-partners/airacademy-scorm-builder` — a Node.js library (CommonJS, v0.1.0) that builds
per-course SCORM 2004 packages for the AirAcademy migration. It:

1. Parses Ascent module JSON + page files into a structured `courseData` object.
2. Resolves all media (images, videos, reference PDFs) from Ascent to S3 `aaa-courses`.
3. Renders the course `index.html` (with runtime assets inlined or linked to S3).
4. Generates the SCORM `imsmanifest.xml` and `launcher.html` from a template.
5. Packages them into a deployable ZIP buffer.

It is **a library, not a CLI pipeline**. All build work is driven by the consumers
(`AirAcademy-Migrator-Courses`, `AirAcademyEditor`) that import and call its exports. This repo
does not deploy anything; it is the build tooling for Production Surface 2 (per-course SCORM
packages).

---

## Repo layout

```
AirAcademy-SCORM-Builder/
  src/
    player/
      build-player.js         # Main entry: loadCourseData, buildPlayer, generateIndexHtml
      media-resolver.js       # Ascent media→S3 resolver (all three categories + references)
      __tests__/
        media-resolver.test.js  # Hermetic unit tests (no network/S3)
    scorm/
      package.js              # createScormPackage → ZIP buffer
      manifest.js             # generateManifest → imsmanifest.xml string
      launcher.js             # generateLauncher → launcher.html string (reads runtime/launcher-template.html)
  runtime/
    player.js                 # Vendored from AirAcademyOWS packages/course-player/src/
    player.css
    scorm-client.js
    launcher-template.html
    PROVENANCE.md             # Sync history + refresh instructions
  scripts/
    sync-runtime-assets.sh    # One-command runtime refresh from AirAcademyOWS
  package.json
  README.md
```

---

## Package exports

```
@runpoint-partners/airacademy-scorm-builder             → src/player/build-player.js
@runpoint-partners/airacademy-scorm-builder/build-player → src/player/build-player.js
@runpoint-partners/airacademy-scorm-builder/media-resolver → src/player/media-resolver.js
@runpoint-partners/airacademy-scorm-builder/scorm-package  → src/scorm/package.js
```

---

## Commands

```bash
npm install       # install dependencies (aws-sdk, archiver, dotenv)
npm test          # node --test "src/**/*.test.js"  — runs hermetic unit tests
```

No build step. No additional scripts.

---

## Dependency relationship — CRITICAL

Both consumers depend on this via a **relative `file:` path** in their `package.json`:
```
"@runpoint-partners/airacademy-scorm-builder": "file:../AirAcademy-SCORM-Builder"
```

This directory **must be a sibling** of `AirAcademy-Migrator-Courses` and `AirAcademyEditor` on
disk. A missing sibling causes `npm install` to fail loudly in those repos.

---

## Runtime assets — vendored snapshot

`runtime/` holds a **snapshot** of the player runtime from `AirAcademyOWS`
(`packages/course-player/src/`). These are the assets that get embedded into per-course `index.html`
or referenced by the SCORM launcher.

Current sync: commit `3f410c8` (2026-06-18). See `runtime/PROVENANCE.md`.

**To refresh after a player update:**
```bash
scripts/sync-runtime-assets.sh /path/to/AirAcademy
# Then: commit runtime/ and update "Synced from commit" in runtime/PROVENANCE.md
```

Always commit `runtime/` changes and update the provenance note — do not leave a stale snapshot
without noting it.

---

## Key design decisions

### Two build modes for `index.html`

`generateIndexHtml(courseData, { sharedPlayer })` produces two HTML shapes:

- **`sharedPlayer: false` (default, inline)** — all runtime assets (`player.css`, `scorm-client.js`,
  `player.js`) are inlined. The HTML is self-contained; no external dependencies at runtime.
- **`sharedPlayer: true` (shared-player mode)** — CSS + JS are loaded from
  `https://aaa-courses.s3.us-east-2.amazonaws.com/player/v1/`. Only course data is embedded inline.
  Updating the shared player (Surface 1) updates all courses built in this mode without rebuilding.

`buildPlayer()` currently produces shared-player mode (`sharedPlayer: true`). Changing this affects
Surface 2 blast radius.

### Media resolution: build-time, not runtime

All Ascent media URLs are resolved to S3 at build time. The rendered course only references
S3 URLs. This is intentional: Ascent is a legacy LMS being decommissioned; courses must not
depend on it at learner runtime.

### Idempotency

`uploadMediaToS3` does a `HeadObject` check and skips the upload if the key already exists. This
makes re-runs safe — the same media file is not re-uploaded on a course rebuild. Exception:
`uploadReferenceToS3` force-uploads (no skip) to overwrite any stale login-page HTML that a
previous failed run may have deposited.

### Failed assets: loud, not silent

When media resolution fails, the build still completes. The resolver:
1. Rewrites bare root-relative `/files/` references to absolute Ascent URLs (never silent 403).
2. Writes `media-report.json` alongside `index.html` with all failures catalogued.

Consumers (the migrator) read `media-report.json` as the deploy gate signal.

### Ascent multi-host fallback

Hash-based files (`/files/{networkId}-{hexhash}`) are tried against multiple Ascent hosts in order:
`aircrewacademy.aerostudies.com` (post-migration, 2026-05-28) first, then `ascent.aerostudies.com`
(legacy). Adding a new host = one entry in `HASH_FILE_HOSTS` at the top of `media-resolver.js`.

### Vimeo video resolution (4 strategies)

A: Use sibling `<video>` fallback (fast, no external call).
B: Check if already on S3 from a prior run (idempotent).
C: Browser → Vimeo playerConfig → HLS URL → yt-dlp download + S3 upload (requires yt-dlp on host).
D: Replace with a visible `"Video unavailable"` placeholder (never silent).

---

## Environment variables

Loaded via `dotenv` from the workspace root `.env` (four levels up from `src/player/`). See
README.md for the full table. Key ones for the build path:

- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `S3_BUCKET`
- `ASCENT_USERNAME`, `ASCENT_PASSWORD`, `ASCENT_URL`
- `MEDIA_CACHE_DIR` (optional local cache; read-only)
- `SKIP_VIMEO_BROWSER_RESOLUTION=1` to skip Strategy C (useful in CI without a browser)

Credentials live in 1Password (master `.env` at `client-repos/AirAcademyOWS/.env`). Never commit
secret values.

---

## Testing

```bash
npm test
```

One test file: `src/player/__tests__/media-resolver.test.js`. Fully hermetic — I/O ports
(`downloadHashFile`, `uploadMedia`) are injected, so no network calls and no S3. The tests encode
the OP-599 defect contract (multi-host hash-file fetching + no silent broken refs).

To add tests: use Node's built-in `node:test` + `node:assert/strict`. Keep them hermetic by
injecting I/O ports via the `opts` parameter on `resolveHashFiles`.

---

## Do's and don'ts

**Do:**
- Run `npm test` before committing changes to `media-resolver.js`.
- Update `runtime/PROVENANCE.md` (sync commit hash + date) whenever you refresh `runtime/`.
- Keep `media-report.json` output intact — it is the consumer's deploy-gate signal.
- Preserve the idempotency invariant in `uploadMediaToS3` (HeadObject check before PutObject).

**Don't:**
- Don't run this repo's code directly against production S3 outside of the migration pipeline.
  The migrator controls the build + deploy sequence; triggering a build here in isolation
  can produce inconsistent artifacts.
- Don't silently swallow media resolution failures. The "loud failure" pattern (absolute Ascent
  URL fallback + `media-report.json` entry) is intentional and must not be removed.
- Don't modify `runtime/` by hand. Always use `scripts/sync-runtime-assets.sh`.
- Don't treat the vendored `runtime/player.js` as the source of truth for player logic.
  The canonical source is `AirAcademyOWS/packages/course-player/src/player.js`.
- Don't publish this package to a registry. It is distributed via the `file:` sibling path.

---

## Sibling repos (do not re-document here)

| Repo | Relationship |
|---|---|
| **AirAcademyOWS** (`AirAcademy-Course-Player`) | Canonical source of `runtime/` assets; owns Surface 1 |
| **AirAcademy-Migrator-Courses** | Primary consumer; drives the build + S3 + Docebo pipeline |
| **AirAcademyEditor** | Secondary consumer; uses this to rebuild courses from the editor |
| **AirAcademy-Adapter-S3** | Not imported here; S3 ops use `@aws-sdk/client-s3` directly |
