# gatecontrol-plugins

First-party plugins for [GateControl](https://github.com/CallMeTechie/gatecontrol)
— sources, tests and the build / sign / release pipeline. The plugin format,
`plugin.json` schema and host API are documented in GateControl's
[`docs/plugins.md`](https://github.com/CallMeTechie/gatecontrol/blob/master/docs/plugins.md).

*Deutsch: siehe [unten](#deutsch).*

## Layout

```
plugins/<id>/               one folder per plugin (folder name = plugin.json id)
  plugin.json               manifest
  server/                   entry (plugin.json "entry", e.g. server/index.js)
  ui/                       templates/assets the plugin renders itself
  migrations/NNN_name.sql   SQL migrations of the plugin's own database
  CHANGELOG.md              one "## <version>" section per release
  test/*.test.js            node:test tests against the mock host (not packed)
tools/                      validate, test, pack, verify, release metadata, catalog
tools/testing/mock-host.js  mock of the host API (gc.*) for plugin tests
plugins.config.json         repo-level flags per plugin (release: false = never released)
gatecontrol.ref             GateControl commit whose packer/validator is used (40-char SHA)
.github/                    CI (ci.yml), release (release.yml), catalogue (catalog.yml)
```

`plugins/gatecontrol-hello` is an **example** (port of GateControl's test
fixture). It is built and tested in CI but never released
(`plugins.config.json`: `"release": false`).

| Plugin | | GateControl |
|---|---|---|
| `gatecontrol-smarthome` | Smart Home (Phoscon/deCONZ) — formerly built into GateControl; imports the built-in data | ≥ 1.149.0 |

## Tooling

The packer is **not** copied into this repository. CI checks out
`CallMeTechie/gatecontrol` at the commit in `gatecontrol.ref` and uses its
`scripts/plugin-pack.js`, `manifest.js` (plugin.json rules), `package.js` and
`signature.js`. Pin a newer GateControl with `tools/bump-gatecontrol.sh <sha>`
and commit the change.

```sh
npm ci                        # dev deps (ipaddr.js, needed by GateControl's validator)
npm run gatecontrol           # checks out the pinned GateControl into ./.gatecontrol
                              # (or set GATECONTROL_DIR, or keep a clone in ../gatecontrol)
npm run validate              # all plugin.json files + repo rules
npm test                      # all plugin tests (or: npm test -- <id>)
npm run pack <id>             # UNSIGNED dev build → dist/<id>-<version>.gcplugin
npm run pack <id> -- --no-license
                              # UNSIGNED dev build with license.required = false
                              # → dist/<id>-<version>-dev.gcplugin (see below)
```

An unsigned package counts as third party, and a third-party plugin that
needs a licence must name its own licence server — so the plain dev build of
a licensed first-party plugin (e.g. `gatecontrol-smarthome`) cannot be
installed. `--no-license` builds one that can (test servers only, never
released or signed). The mock host (`tools/testing/mock-host.js`) also offers
`gc.settings.setSecret`, `host.legacyImport(snapshot)` and
`host.portalVisible(user)`.

Dev builds are always unsigned (`tools/pack.js` drops `GC_PLUGIN_SIGNING_KEY`
unless `--sign` is passed). Install them on a test server with
*Unsignierte Plugins erlauben*. **Signing happens only in the release
workflow** — the private key never leaves the `plugin-release` environment.

## Adding a plugin

1. Create `plugins/<id>/` (`id`: `[a-z0-9]+(-[a-z0-9]+)*`, 2–64 chars; for
   first-party plugins it is the licence server's entitlement slug).
2. Add `plugin.json`, the entry under `server/`, `migrations/`, `ui/`,
   `CHANGELOG.md` with a `## <version>` section, and `test/*.test.js` using
   `tools/testing/mock-host.js` (see the example plugin).
3. `npm run validate && npm test && npm run pack <id>`; open a PR.

## Versioning

Semantic versioning per plugin, independent of other plugins. `plugin.json`
`version` is the single source; every released version needs a CHANGELOG
section. `gatecontrol` declares the compatible server range. Pre-releases
(`1.2.0-rc.1`) are published as GitHub pre-releases and never become a
catalogue `latest` while a stable version exists.

## Release

1. On `main`: bump `version` in `plugins/<id>/plugin.json`, add the
   `## <version>` section to its `CHANGELOG.md`, merge.
2. Tag that commit and push the tag:
   `git tag gatecontrol-smarthome-v1.2.0 && git push origin gatecontrol-smarthome-v1.2.0`
3. `release.yml` (environment `plugin-release`, waits for a reviewer if one is
   configured) checks that the tag is on `main`, tag = `plugin.json` version,
   CHANGELOG entry exists, the plugin is releasable; validates, tests, builds,
   **signs**, verifies the signature against `signing-key.pub` and creates
   the GitHub Release `<id>-v<version>` with
   `<id>-<version>.gcplugin`, `<id>-<version>.gcplugin.sha256` and
   `<id>-<version>.index.json`. It fails, and publishes nothing, when a key
   is missing or the signature does not match.
4. `catalog.yml` then rebuilds the catalogue (below).

### Catalogue

`catalog.json` is an asset of the rolling release **`catalog`**:
`https://github.com/CallMeTechie/gatecontrol-plugins/releases/download/catalog/catalog.json`.
It is rebuilt from the `*.index.json` assets of all published releases (the
releases are the source of truth; deleting a release and re-running the
*Catalog* workflow removes it). No branch, no commits, no merge conflicts.

```jsonc
{ "schema": 1, "generated_at": "…", "repository": "CallMeTechie/gatecontrol-plugins",
  "plugins": { "<id>": { "id", "name", "description", "publisher",
                         "latest": { /* index entry */ }, "versions": [ /* newest first */ ] } } }
// index entry:
{ "schema": 1, "id", "name", "description", "publisher", "version", "prerelease",
  "gatecontrol": ">=1.146.0", "license_required", "file", "size", "sha256", "url",
  "signature": { "alg": "Ed25519", "key_id", "public_key" }, "tag", "release_url", "published_at" }
```

### One-time setup (repository owner)

| Kind | Name | Value |
|---|---|---|
| Environment | `plugin-release` | *deployment branches and tags* → selected, tag rule `*-v*` (a required reviewer is optional) |
| Environment secret | `GC_PLUGIN_SIGNING_KEY` | private seed from `node scripts/plugin-keygen.js` (GateControl repo; run it on your own machine) |
| File in this repo | `signing-key.pub` | the matching public key (base64, 32 bytes); also in GateControl's `BUILTIN_PUBLIC_KEYS` |
| Tag ruleset (recommended) | `*-v*` | restrict creation/update/deletion to maintainers |

No other secrets are used. `pull_request` runs (`ci.yml`) never see the
signing key; nothing uses `pull_request_target`.

---

## Deutsch

Erstanbieter-Plugins für GateControl mit Build-, Signatur- und Release-Pipeline.

* **Aufbau:** ein Ordner pro Plugin unter `plugins/<id>/` (plugin.json, `server/`,
  `ui/`, `migrations/`, `CHANGELOG.md`, `test/`); gemeinsame Werkzeuge in `tools/`.
  `gatecontrol-hello` ist nur ein Beispiel und wird nie veröffentlicht.
* **Werkzeuge:** Der Packer stammt aus GateControl (Commit in `gatecontrol.ref`,
  ändern mit `tools/bump-gatecontrol.sh <sha>`). Lokal: `npm ci`,
  `npm run gatecontrol`, `npm run validate`, `npm test`, `npm run pack <id>`
  (immer **unsigniert**; `-- --no-license` für einen installierbaren
  Testbau eines lizenzpflichtigen Erstanbieter-Plugins).
* **Neues Plugin:** Ordner anlegen, plugin.json + Code + CHANGELOG + Tests mit
  `tools/testing/mock-host.js`, prüfen, PR öffnen.
* **Versionierung:** SemVer pro Plugin; jede Version braucht einen
  `## <version>`-Abschnitt im CHANGELOG.
* **Release:** Version und CHANGELOG auf `main` bringen, dann Tag
  `<id>-v<version>` pushen. Die Release-Pipeline prüft, testet, baut,
  **signiert (nur in CI, Umgebung `plugin-release`)**, prüft die Signatur und
  veröffentlicht Paket, `.sha256` und Katalogeintrag; danach wird
  `catalog.json` im Release `catalog` neu erzeugt („Nach Updates suchen“
  liest diese Datei).
* **Einrichtung:** siehe Tabelle *One-time setup* oben.
