# Runtime templates — provenance

Two declarative templates live here — the per-course artifacts the builder bakes into each SCORM ZIP
(`src/scorm/package.js` → `createScormPackage`). Both are `{{PLACEHOLDER}}` templates filled by thin
substitution functions; neither contains player code.

| File | Owner | Filled by |
|------|-------|-----------|
| `launcher-template.html` | **synced** from the player repo | `src/scorm/launcher.js` → `generateLauncher` |
| `manifest-template.xml` | **builder-owned** (authored here) | `src/scorm/manifest.js` → `generateManifest` |

### `launcher-template.html` (synced)
The SCORM launcher shell (iframe host + SCORM API bridge). Kept in sync with the player repo.

- Source: `Runpoint-Partners/AirAcademy` → `packages/course-player/src/launcher-template.html`
- Synced from commit: **`3f410c8`** (2026-06-18)

### `manifest-template.xml` (builder-owned — do NOT sync)
The `imsmanifest.xml` SCORM 2004 4th-Ed contract. It was extracted from a JS template literal that
lived inline in `manifest.js` (Tier-0 refactor, 2026-06-27) so the XML is a lintable declarative
artifact, symmetric with the launcher. It has **no upstream** — `sync-runtime-assets.sh` must not touch
it. Holes: `{{COURSE_ID}}`, `{{NETWORK_ID}}`, `{{TITLE}}` (the title is XML-escaped before substitution).
Byte-identity with the pre-refactor output is pinned by `src/scorm/__tests__/manifest-parity.test.js`
(golden fixtures captured from the old imperative function). Edit the XML here, re-bless the goldens
deliberately if the contract must change.

## The player is NO LONGER vendored
`player.js`, `player.css`, and `scorm-client.js` used to be vendored here and inlined into each course
(the old `generateIndexHtml` "inline mode"). **That is gone.** The builder now generates a thin
**shared-player** shell that references the player deployed centrally to S3 by the player repo
(`AirAcademyOWS`). The builder reads the player's base URL + canonical asset list from the
**`player-manifest.json`** the player deploy publishes next to the assets
(`src/player/build-player.js` → `loadPlayerManifest`). One source of truth, no copy to drift.

So a player change ships from `AirAcademyOWS` to S3 `player/v1/` and reaches every live course centrally
— the builder is never re-run for it. The builder is only re-run for **content** or **launcher** changes.

## Refresh the launcher template (one command)
```
scripts/sync-runtime-assets.sh /path/to/AirAcademy   # copies launcher-template.html from packages/course-player/src
```
Then commit `runtime/launcher-template.html` and update the "Synced from commit" line above.

## TODO — retire this last snapshot
The clean end-state vendors nothing. The launcher template should likewise come from a shared, versioned
source (or fold into the husk migration's hollow launcher). Tracked in the migration repo `TODO.md`.
