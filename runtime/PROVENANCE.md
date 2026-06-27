# Vendored runtime — provenance

Only ONE file is vendored here now: **`launcher-template.html`** — the per-course SCORM launcher shell
the builder bakes into each course's SCORM ZIP (`src/scorm/launcher.js` → `createScormPackage`).

- Source: `Runpoint-Partners/AirAcademy` → `packages/course-player/src/launcher-template.html`
- Synced from commit: **`3f410c8`** (2026-06-18)

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
