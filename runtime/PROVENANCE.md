# Vendored runtime player assets — provenance

These are the AirAcademy **runtime player** assets the SCORM builder embeds into each course's
content (and/or deploys to S3 `player/v1/`). A SCORM package must ship/reference a runtime that
renders the course and talks to the LMS, so the builder needs these as a build input.

They are **sourced from `course-player`** (the runtime player's home, in `Runpoint-Partners/AirAcademy`)
and vendored here so the builder is **self-contained** (no filesystem reach into a sibling repo).

- Source: `Runpoint-Partners/AirAcademy` → `packages/course-player/src/`
- Synced from commit: **`96294dc`** (2026-06-05)
- Files: `player.css`, `player.js`, `scorm-client.js`, `launcher-template.html`

## Refresh (one command)
Re-vendor when the runtime player changes:
```
scripts/sync-runtime-assets.sh /path/to/AirAcademy   # copies the 4 files from packages/course-player/src
```
Then commit `runtime/` and update the "Synced from commit" line above.

## TODO — retire this snapshot (the remaining debt)
This is a **documented snapshot**, not the long-term home. The clean end-state is a SINGLE source for
the runtime player. Once the `course-player` TypeScript rewrite settles, do ONE of:
- publish a versioned `@runpoint-partners/airacademy-player-runtime` package consumed by BOTH the
  builder and `course-player`, or
- switch the builder to **shared-player mode** (courses load the player from S3 `player/v1/`).

Tracked in the migration repo `TODO.md`.
