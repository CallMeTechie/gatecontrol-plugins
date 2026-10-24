#!/bin/sh
# Rebuilds ui/vendor/noble.js (window.VaultNoble) and ui/vendor/LICENSE-jsqr.txt (jsQR's Apache-2.0 licence, packed
# next to the bundle) of gatecontrol-vault. Lives under test/ so it is never packed into the .gcplugin (tools/stage.js
# leaves test/ out).
#
#   sh plugins/gatecontrol-vault/test/vendor-build/build.sh
#
# Reproducible: `npm ci` installs exactly package-lock.json (pinned versions + integrity hashes) into a temporary
# folder — never into the repository; esbuild bundles entry.mjs (build.mjs: one patch, Argon2id yields to the page).
# Building twice gives the same bytes. Then run the plugin's tests: test/crypto.test.js checks every vector of
# test/fixtures/vault-vectors.json.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
out="$here/../../ui/vendor/noble.js"
license="$here/../../ui/vendor/LICENSE-jsqr.txt"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cp "$here/package.json" "$here/package-lock.json" "$here/entry.mjs" "$here/build.mjs" "$work/"
cd "$work"
npm ci --no-audit --no-fund --silent
ver() { node -p "require('./node_modules/$1/package.json').version"; }
cat > banner.txt <<BANNER
/*! ui/vendor/noble.js - built by test/vendor-build/build.sh (esbuild $(ver esbuild), IIFE, window.VaultNoble).
 * @noble/hashes $(ver @noble/hashes), @noble/ciphers $(ver @noble/ciphers), @noble/curves $(ver @noble/curves) - Copyright (c) 2022 Paul Miller (https://paulmillr.com)
 * uqr $(ver uqr) - Copyright (c) Project Nayuki, Copyright (c) 2023 Anthony Fu <https://github.com/antfu>
 * jsQR $(ver jsqr) - Cosmo Wolfe, Jefff Nelson (https://github.com/cozmo/jsQR) - Licensed under the Apache License,
 *   Version 2.0 (the plugin package has the full text in ui/vendor/LICENSE-jsqr.txt, also at
 *   http://www.apache.org/licenses/LICENSE-2.0); distributed "AS IS", WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND.
 *   Unchanged, bundled as VaultNoble.qrDecode.
 * Patched: argon2idAsync yields with a macrotask (MessageChannel, every 5th time setTimeout) instead of a microtask,
 * so the page stays responsive (test/vendor-build/build.mjs).
 *
 * @noble/*, uqr: The MIT License (MIT)
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
node build.mjs "$out" banner.txt
cp node_modules/jsqr/LICENSE "$license"
