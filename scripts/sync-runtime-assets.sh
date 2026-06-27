#!/usr/bin/env bash
# Refresh the vendored LAUNCHER TEMPLATE from a course-player checkout.
# The player itself is NO LONGER vendored — courses reference it from S3 via the deployed
# player-manifest.json (see runtime/PROVENANCE.md). Only launcher-template.html is vendored, because
# the launcher is baked per-course into the SCORM ZIP.
#
# Usage: scripts/sync-runtime-assets.sh <path-to-AirAcademy-repo>
#   e.g. scripts/sync-runtime-assets.sh /Users/cbot2/dev/Runpoint/AirAcademy
set -euo pipefail
SRC_REPO="${1:?usage: sync-runtime-assets.sh <path-to-AirAcademy-repo containing packages/course-player>}"
SRC="$SRC_REPO/packages/course-player/src"
DEST="$(cd "$(dirname "$0")/.." && pwd)/runtime"
[ -d "$SRC" ] || { echo "ERROR: $SRC not found"; exit 1; }
for a in launcher-template.html; do
  cp "$SRC/$a" "$DEST/$a" && echo "synced $a"
done
echo "Done. Now: commit runtime/ and update the 'Synced from commit' line in runtime/PROVENANCE.md (use: git -C \"$SRC_REPO\" rev-parse --short HEAD)."
