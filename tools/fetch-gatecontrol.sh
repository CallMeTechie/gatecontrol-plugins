#!/usr/bin/env bash
# Check out GateControl at the pinned commit (gatecontrol.ref) into ./.gatecontrol
# for local builds and validation — the same tree CI uses.
#   tools/fetch-gatecontrol.sh
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
ref="$(tr -d '[:space:]' < "$root/gatecontrol.ref")"
[[ "$ref" =~ ^[0-9a-f]{40}$ ]] || { echo "gatecontrol.ref is not a 40-character SHA" >&2; exit 1; }
dir="$root/.gatecontrol"
if [ ! -d "$dir/.git" ]; then
  git init -q "$dir"
  git -C "$dir" remote add origin https://github.com/CallMeTechie/gatecontrol.git
fi
git -C "$dir" fetch -q --depth 1 origin "$ref"
git -C "$dir" checkout -q --detach FETCH_HEAD
echo "GateControl $ref → .gatecontrol"
