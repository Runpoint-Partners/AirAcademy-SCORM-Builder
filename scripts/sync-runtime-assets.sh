#!/usr/bin/env bash
# Refresh the vendored runtime player assets from a course-player checkout.
# These live canonically in course-player (Runpoint-Partners/AirAcademy); this script copies the
# current versions in so the builder stays self-contained. See runtime/PROVENANCE.md.
#
# Usage: scripts/sync-runtime-assets.sh <path-to-AirAcademy-repo>
#   e.g. scripts/sync-runtime-assets.sh /Users/cbot2/dev/Runpoint/AirAcademy
set -euo pipefail
SRC_REPO="${1:?usage: sync-runtime-assets.sh <path-to-AirAcademy-repo containing packages/course-player>}"
SRC="$SRC_REPO/packages/course-player/src"
DEST="$(cd "$(dirname "$0")/.." && pwd)/runtime"
[ -d "$SRC" ] || { echo "ERROR: $SRC not found"; exit 1; }
for a in player.css player.js scorm-client.js launcher-template.html; do
  cp "$SRC/$a" "$DEST/$a" && echo "synced $a"
done
echo "Done. Now: commit runtime/ and update the 'Synced from commit' line in runtime/PROVENANCE.md (use: git -C \"$SRC_REPO\" rev-parse --short HEAD)."
