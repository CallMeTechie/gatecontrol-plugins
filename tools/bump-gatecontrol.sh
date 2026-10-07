#!/usr/bin/env bash
# Pin a new GateControl commit for the packer/validator (CI checks it out):
#   tools/bump-gatecontrol.sh <40-char sha>
set -euo pipefail
sha="${1:-}"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "usage: $0 <40-character commit SHA>" >&2; exit 2; }
root="$(cd "$(dirname "$0")/.." && pwd)"
echo "$sha" > "$root/gatecontrol.ref"
echo "gatecontrol.ref → $sha"
echo "commit it, e.g.: git commit -am 'build: bump gatecontrol to ${sha:0:12}'"
