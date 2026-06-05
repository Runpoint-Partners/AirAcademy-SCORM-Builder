# AirAcademy SCORM Builder

The **single canonical** SCORM courseware renderer for the AirAcademy migration. It builds the player
HTML, resolves + uploads media, and packages the SCORM zip. Extracted from the AirAcademy monorepo
(`packages/course-builder`) on 2026-06-05 so there is exactly **one** version, version-controlled and
consumed as a pinned dependency.

## Consumed as a dependency (no env-var path lookup)

The migration repo (`AirAcademyMigrationV2`) depends on this package via a relative `file:` link, so it
must be a **sibling directory**:

```
<parent>/
  AirAcademyMigrationV2/        package.json → "@runpoint-partners/airacademy-scorm-builder": "file:../AirAcademy-SCORM-Builder"
  AirAcademy-SCORM-Builder/     (this repo)
```

A missing/misplaced sibling makes `npm install` **fail loud** — there is no fallback and no
`AA_MODULE5_LEGACY_AIRACADEMY_ROOT` env lookup anymore.

## Entry points (`exports`)

| Import | File |
|--------|------|
| `@runpoint-partners/airacademy-scorm-builder/build-player` | `src/player/build-player.js` — renders player HTML + resolves references |
| `@runpoint-partners/airacademy-scorm-builder/media-resolver` | `src/player/media-resolver.js` — media/reference fetch + S3 upload + shared-asset lock |
| `@runpoint-partners/airacademy-scorm-builder/scorm-package` | `src/scorm/package.js` — SCORM zip (manifest + launcher) |

## Host prerequisites (NOT npm deps)

The renderer shells out to system binaries via `child_process`:
- **Chromium** (headless render) and **ffmpeg** (video transcode) must be on the host (CBOT satisfies these).
- Node **>= 20**.

## Versioning / upgrade

Bump `version` (semver) on change. The eventual TypeScript rewrite ships as a **major** bump (compiled
`dist/*.js` + `*.d.ts`); consumers upgrade by bumping the pinned version. The pre-extraction history is
preserved in `Runpoint-Partners/AirAcademy` under the `archive/*-20260604` tags.
