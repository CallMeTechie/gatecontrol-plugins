#!/bin/sh
# Rebuilds ui/vendor/noble.js (window.VaultNoble) from tools/noble-entry.mjs with the pinned versions below.
# Needs node + npm and network access to the npm registry; installs into a temporary folder, never into the repo.
#
#   sh plugins/gatecontrol-vault/tools/build-noble.sh
#
# Then run the plugin's tests (test/crypto.test.js checks every vector of test/fixtures/vault-vectors.json).
set -eu
HASHES=1.8.0
CIPHERS=1.3.0
CURVES=1.9.7
UQR=0.1.2
ESBUILD=0.25.10
here=$(cd "$(dirname "$0")" && pwd)
out="$here/../ui/vendor/noble.js"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cp "$here/noble-entry.mjs" "$work/entry.mjs"
cd "$work"
npm init -y >/dev/null
npm install --save-exact --no-audit --no-fund --silent \
  "@noble/hashes@$HASHES" "@noble/ciphers@$CIPHERS" "@noble/curves@$CURVES" "uqr@$UQR" "esbuild@$ESBUILD"
./node_modules/.bin/esbuild entry.mjs --bundle --minify --format=iife --global-name=VaultNoble --target=es2020 \
  --legal-comments=none --charset=ascii --outfile=bundle.js --log-level=warning
{
  cat <<BANNER
/*! ui/vendor/noble.js - built by tools/build-noble.sh (esbuild $ESBUILD, IIFE, window.VaultNoble).
 * @noble/hashes $HASHES, @noble/ciphers $CIPHERS, @noble/curves $CURVES - Copyright (c) 2022 Paul Miller (https://paulmillr.com)
 * uqr $UQR - Copyright (c) Project Nayuki, Copyright (c) 2023 Anthony Fu <https://github.com/antfu>
 *
 * The MIT License (MIT)
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
 * documentation files (the "Software"), to deal in the Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
 * to permit persons to whom the Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or substantial portions of
 * the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
 * THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
 * CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
 * IN THE SOFTWARE.
 */
BANNER
  cat bundle.js
} > "$out"
echo "wrote $out ($(wc -c < "$out") bytes)"
