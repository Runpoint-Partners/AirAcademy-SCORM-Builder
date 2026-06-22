# CLAUDE.md — AirAcademy-SCORM-Builder

Claude Code working guide. See AGENTS.md for the full tool-agnostic reference.

---

## Orientation

This is `@runpoint-partners/airacademy-scorm-builder` — a Node.js CommonJS library that builds
per-course SCORM packages for the AirAcademy migration. It is **not a pipeline or app**; it is the
build tooling that `AirAcademy-Migrator-Courses` and `AirAcademyEditor` import.

Start with AGENTS.md for layout, exports, env vars, and design decisions. This file adds
Claude Code-specific context.

---

## Quick orientation commands

```powershell
# Run tests (the only npm script)
npm test

# Check what files changed recently
git log --oneline -10

# Verify current runtime provenance
type runtime\PROVENANCE.md
```

---

## The three-file rule before touching anything

Before editing any source file, read:
1. The file itself (understand what it exports and what invariants it encodes)
2. `AGENTS.md` (design decisions that must not be broken)
3. `runtime/PROVENANCE.md` (if touching `runtime/`)

The media resolver (`src/player/media-resolver.js`) is 2000+ lines with carefully layered
fallback strategies. Read the section headers before editing; each strategy (A/B/C/D for Vimeo,
multi-host for hash files) is there for a documented reason.

---

## Running tests

```powershell
npm test    # node --test "src/**/*.test.js"
```

Tests are hermetic (no network, no S3). If you add new resolution logic to `media-resolver.js`,
add a corresponding test that injects fake I/O ports. The OP-599 defect contract (no silent
root-relative `/files/` refs on failure) must be preserved.

---

## Workspace conventions

This repo follows the AirAcademy workspace conventions from the parent `CLAUDE.md` files:
- Work on `main` directly (no feature branches by default).
- Do not push without explicit instruction.
- Secrets by name only — never write a credential value into any file.
- Master `.env` is at `client-repos/AirAcademyOWS/.env` (1Password). Do not commit it.

---

## Refreshing the runtime assets

When `AirAcademyOWS` player changes need to flow into SCORM packages:

```bash
# From a bash shell (Git Bash / WSL on Windows):
scripts/sync-runtime-assets.sh /path/to/AirAcademyOWS
```

Then update the commit hash in `runtime/PROVENANCE.md` and commit `runtime/`. The hash comes from:
```bash
git -C /path/to/AirAcademyOWS rev-parse --short HEAD
```

Do not hand-edit files in `runtime/`. The sync script is the only safe update path.

---

## Surface 2 blast radius reminder

This library is the **build side** of Production Surface 2 (per-course SCORM packages). Changes
here only affect courses that are **rebuilt and redeployed** via `AirAcademy-Migrator-Courses`.
Unlike Surface 1 (the shared player), a change here does NOT automatically propagate to live
courses. Rebuilding all ~1407 courses is a large batch operation.

When making a change that affects rendered HTML (e.g. `generateIndexHtml`, media resolution):
- Test with `npm test`.
- Note which courses need a rebuild in your commit message or the Jira ticket.
- Rebuilds are driven from `AirAcademy-Migrator-Courses` — route the downstream work there.

---

## Key files at a glance

| File | What to know |
|---|---|
| `src/player/build-player.js` | Main export: `buildPlayer`, `loadCourseData`, `generateIndexHtml`. The `loadCourseData` function recursively collects nested sub-folder pages (OP-580 fix — do not revert to a flat loop). |
| `src/player/media-resolver.js` | Three resolution categories + reference attachments + shared asset locking. The `HASH_FILE_HOSTS` array at the top governs multi-host fallback order. |
| `src/scorm/launcher.js` | Reads `runtime/launcher-template.html` and substitutes six `{{PLACEHOLDER}}` tokens. |
| `src/scorm/manifest.js` | Pure function — generates SCORM 2004 4th Ed. `imsmanifest.xml`. |
| `src/scorm/package.js` | Composes manifest + launcher into a ZIP buffer via `archiver`. |
| `runtime/PROVENANCE.md` | Must be kept accurate — it is the audit trail for which player version is embedded in built courses. |

---

## Jira + mail

Use mailman (`AirAcademy/repos/mailman/`) for any Jira reads or updates — never raw curl/REST.
Relevant Jira board: **OP** (AirAcademy migration issues). Reference issue numbers (OP-580,
OP-599) in commit messages when fixing bugs they document.
