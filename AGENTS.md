# Repository Guidelines

## Project Overview

`qwen-linux-port` is **not an application codebase — it is a reproducible build/repackaging pipeline** that turns the upstream macOS Qwen Electron app into Linux `AppImage`, `.deb`, and Arch Linux `.pkg.tar.zst` artifacts. It ingests the official macOS `.dmg`, extracts its ASAR, applies string-exact source patches for Linux compatibility, bundles pinned Bun + uv runtimes, and repacks via `electron-builder`.

The wrapped app (`asar-src/`) is an Electron 35 shell hosting a `<webview>` to `https://chat.qwen.ai`. Chat/AI logic lives on the web side; the shell adds MCP (Model Context Protocol) server management, native dialogs, theming, i18n (12 languages), auto-update, AES analytics, and the `qwen://` protocol.

> **Two version numbers, on purpose:** root `package.json` is the *pipeline* version (`1.0.2`); the wrapped upstream app (`asar-src/package.json`) is a *different* version (`1.0.5`). Don't conflate them.

## Architecture & Data Flow

Two distinct layers live here:

**1. The build pipeline (the code you author)** — `scripts/*.mjs`, `electron-builder.yml`, root `package.json`.
```
upstream .dmg  ──upstream:ingest──▶  asar-src/ + extract/   (gitignored, from macOS DMG)
                                          │
                              scripts/prepare-linux.mjs   (patch + stage + fetch runtimes + icons)
                                          │
                                     .stage/app  ──electron-builder──▶  dist/ (AppImage, deb, pkg.tar.zst)
```

**2. The wrapped app (bundled artifacts you PATCH, not author)** — `asar-src/out/`.
```
main (out/main/index.js, CJS, ~2395 lines, single file)
  ├─ BrowserWindow (sandbox:false, webviewTag:true, contextIsolation:true, nodeIntegration:false)
  │     └─▶ renderer React SPA ──▶ <webview> chat.qwen.ai (origin allowlist: chat.qwen.ai, pre-chat.qwen.ai)
  ├─ IPC: 34 ipcMain.handle + 4 ipcMain.on, most guarded by assertTrustedIpcSender (top-frame origin check)
  ├─ MCP (DUAL, see below), i18next (i18next-fs-backend, i18n/*.json, 12 locales: en-US/zh-CN/zh-TW/ja-JP/ko-KR/ru-RU/de-DE/fr-FR/es-ES/it-IT/pt-PT/ar-BH), electron-updater, AES analytics
preload (out/preload/index.js, CJS, ~98 lines) — contextBridge → window.electron + window.electronAPI (~40 methods)
renderer (out/renderer/assets/index-*.js) — bundled React 18.3, hashed filename; Alibaba Aplus/AES SDKs from CDN
```

**Dual MCP architecture** (both singletons coexist — patch carefully):
- **Legacy** `Proxy` class (singleton `mcpServer`), served by `mcp_client_*` IPC handlers, raw `@modelcontextprotocol/sdk` `Client`.
- **New** `McpService` → `ServerManager` → `ToolRegistry` (+ `McpCache`, `McpLogger`, `ServerLogBuffer`), singleton `mcpService`, served by `mcp:*` handlers, with lifecycle, TTL caching, zod validation, structured logging.
- **Known dead endpoints:** `mcp_client_connect` / `mcp_client_close` are exposed in preload but have **no** main handler.
- **Transport types:** stdio (via `StdioClientTransport`), SSE (`SSEClientTransport`), Streamable HTTP (`StreamableHTTPClientTransport`).
- **Command security:** `resolveCommand` rewrites `bun` → bundled Bun, `npx` → bundled Bun (prepends `x -y`), `uvx` → bundled uvx, and `system-npx` → system `npx` (prepends `-y`). `isAllowedMcpCommand` permits only `bun`, `npx`, `uvx`, `system-npx` (or their resolved binary paths); shells (`bash`, `sh`, `zsh`, `cmd`, `powershell`, `pwsh`, `osascript`, `cscript`, `wscript`) are blocked.
- **Error codes:** CONNECTION_FAILED, CONNECTION_TIMEOUT, INVALID_CONFIG, SERVER_NOT_FOUND, TOOL_NOT_FOUND, TOOL_CALL_FAILED, TOOL_TIMEOUT, TOOL_ABORTED, RESOURCE_NOT_FOUND, RESOURCE_ACCESS_DENIED, PROMPT_NOT_FOUND, INTERNAL_ERROR.

Data flow (MCP tool call): renderer/webview `window.electronAPI.*` → preload `ipcRenderer.invoke` → main `ipcMain.handle` (trust-checked) → MCP service spawns bundled `bun`/`uvx` (paths via `getBunPath()`/`getUvxPath()`, `adaptConfig` rewrites commands) → `success()`/`error()` factory. Main→renderer events go over `webContents.send('event_from_main')`, bridged by a custom `EventEmitter` in preload.

## Key Directories

| Path | Purpose |
|------|---------|
| `scripts/` | **The real source.** 11 pipeline `.mjs` + 2 MCP fixtures + `lib/`. |
| `scripts/lib/linux-package.mjs` | Shared helpers: `resolveRendererBundle()`, `assertCanonicalVersion()`, `PUBLIC_UPDATE_URL`, `RENDERER_PREIMAGE`. |
| `scripts/lib/http.mjs` | Shared network layer: `fetchRetry()` (bounded retry/backoff for transient HTTP), `githubHeaders()`. |
| `scripts/lib/release-assets.mjs` | `reconcilePublishedAssets()` — the guard that keeps an already published release immutable. |
| `scripts/mcp/` | MCP test fixtures: `bun-fixture.ts` (Bun stdio echo), `http-fixture.cjs` (SSE + Streamable HTTP). |
| `asar-src/` | Ingested upstream app (gitignored). Patched, never authored. `out/main`, `out/preload`, `out/renderer`, `i18n/`. |
| `extract/` | Ingested upstream resources (gitignored). |
| `build/icons/` | 8 PNGs (16…1024) generated from upstream `.icns`; gitignored but present. |
| `.stage/` | `prepare:linux` output (gitignored). `.stage/app` (electron-builder source), `.stage/runtime/{bun,python}/linux-x64`, `.stage/upstream/`, `.stage/{appimage,deb,pacman}-root/`, `.stage/release-assets/`. |
| `dist/` | Final `AppImage` / `.deb` / `.pkg.tar.zst` (gitignored). |
| `.github/workflows/release-upstream.yml` | The automated pipeline (sole workflow). |
| `openspec/` | OpenSpec project config: TDD workflow rules, test commands, quality gates. |

## Development Commands

Package manager is **npm 12.0.1** (`packageManager` field). All commands from repo root.

```bash
npm run upstream:detect     # check download.qwen.ai for a new upstream version
                            # FORCE_RECHECK=true rebuilds an identity that is already published
                            # (workflow_dispatch input force_recheck); repack/rollback guards still apply
npm run upstream:ingest     # (macOS ONLY) download DMG, validate codesign/notarize, extract → asar-src/
npm run prepare:linux       # fetch Bun/uv, patch (17 replacements), convert icons, stage into .stage/app
npm run package:dir         # prepare + electron-builder --linux dir (unpacked, fast iteration)
npm run package:linux       # prepare + electron-builder --linux AppImage deb pacman --x64
npm run verify:package      # assert ~22 patch markers + ELF runtime versions + desktop entry (needs a build)
npm run verify:mcp          # exercise MCP stdio/SSE/HTTP transports against the packaged app
npm run test:upstream       # node:test unit tests for the manifest parser
npm test                    # test:upstream + verify:package + verify:mcp  (needs a prior build)
```

Manual-only (NOT part of `npm test`): `node scripts/smoke-linux.mjs --version <v>` (CDP-drives the built binary) and `node scripts/smoke-updater-mode.mjs` (verifies updater fires only in AppImage mode). CI runs these under `xvfb`.

There is **no lint/format command and no TypeScript build** — no ESLint, Prettier, or tsconfig exist.

## Code Conventions & Common Patterns

- **Pipeline scripts (`scripts/`) are ESM `.mjs`, Node built-ins only** (`node:fs`, `node:test`, `node:assert/strict`). `scripts/mcp/bun-fixture.ts` is Bun-run; `http-fixture.cjs` is Node CJS.
- **Patching is string-exact.** `prepare-linux.mjs` applies **17 literal string replacements** across main/preload/renderer (Linux platform dir, Bun/uvx paths, AppImage-only updater guard, MCP config sanitization, desktop-entry repair, `qwen://` handler, i18n/icon paths, filesystem-MCP normalization, renderer MCP permission auto-grant). Its inline `verifyStage()` re-checks 22+ markers + ELF + icon sizes. **`verify-linux-package.mjs` asserts the same markers on the built package — if you change a patch, update its marker(s) in both, or the build fails.**
- **Pinned, triple-verified runtimes.** Bun `1.2.10` and uv/uvx `0.7.14` are downloaded by sha256, then re-checked by ELF header + file mode + `--version` string. Never bump a version without updating its hash and marker.
- **The wrapped app is CommonJS** (`asar-src/package.json` has no `type` field). It uses zod for IPC validation, `success()`/`error()` response factories, a `handleAsync()` wrapper, and `assertTrustedIpcSender` on nearly every handler — preserve these when patching.
- **No state-management library.** Renderer uses React hooks only (incl. `useSyncExternalStore`). Main state is in-memory singletons (`mcpServer`, `mcpService`) + `electron-settings`.
- **Styling** is vanilla CSS with custom properties (`--bg-color`, `.dark-theme`); no Tailwind/CSS Modules/styled-components.

## Important Files

- `package.json` — pipeline scripts + devDeps (`@electron/asar`, `electron`, `electron-builder`, `yaml`); `allowScripts` limited to `electron@35.1.4`.
- `electron-builder.yml` — `appId: com.qwen.chat`, source `.stage/app`, ASAR on, `extraResources` for `bun`/`python` runtimes, Linux `AppImage`+`deb`+`pacman` (x64), `qwen://` protocol, generic publish provider → `qwen-studio-linux-releases`.
- Three **electron-builder hook files** (referenced by the yml) exist to strip the upstream macOS `app-update.yml` that leaks into Linux layouts (so only AppImage keeps auto-update): `scripts/after-pack.mjs` (from unpacked resources), `scripts/after-all-artifact-build.mjs` (from final linux-unpacked), `scripts/artifact-build-completed.mjs` (repacks `.deb` via `dpkg-deb` and `.pacman` via `fakeroot`/`bsdtar`/`zstd` with rebuilt `.MTREE`).
- `scripts/prepare-linux.mjs` — core staging + patching (~315 lines).
- `scripts/upstream-release.mjs` — `detect` (parse `latest-mac.yml`) / `ingest` (macOS-only DMG validation + extract); `parseManifest()` is unit-tested.
- `scripts/publish-release.mjs`, `scripts/manage-release-issue.mjs` — CI release publish + failure-issue management.
- `scripts/verify-linux-package.mjs`, `scripts/verify-mcp.mjs`, `scripts/smoke-linux.mjs`, `scripts/smoke-updater-mode.mjs` — QA harness.
- `.github/workflows/release-upstream.yml` — cron (twice daily) + manual dispatch; 5-job DAG `detect` (ubuntu) → `ingest` (macos-15-intel) → `build` (ubuntu) → `release` → `issue`. Concurrency group prevents overlap.
- `skills-lock.json` — 4 local skills from `/home/diogo/dev/skills`; not npm deps.
- **`AGENTS.md` is the only documentation.** No README, LICENSE, CHANGELOG, or `docs/`.

## Runtime/Tooling Preferences

- **Node** runs the pipeline scripts (`node --test`, `node scripts/...`); **npm 12.0.1** is the package manager.
- **Bun** and **uv/uvx** are bundled *into the app* as MCP execution runtimes — shipped artifacts, not dev tooling (Bun also runs `scripts/mcp/bun-fixture.ts`).
- Linux build requires **ImageMagick** (`.icns`→PNG), plus `fakeroot`/`dpkg`/`xvfb` and standard `electron-builder` Linux deps (CI installs these).
- `upstream:ingest` is **macOS-only** (codesign/notarization/TeamID validation of the DMG); everything else runs on Linux/CI Ubuntu.

## Testing & QA

- **Unit:** `node:test` + `node:assert/strict` — `scripts/upstream-release.test.mjs` (`parseManifest` + `publishedState`/`isForceRecheck` against a stubbed `fetch`), `scripts/lib/http.test.mjs` (`fetchRetry`, against a loopback `node:http` server), `scripts/lib/release-assets.test.mjs` (published-release reconciliation). Run one file: `node --test scripts/upstream-release.test.mjs`.
- **Verification (post-build):** `verify:package` (ELF, ASAR entries, ~22 patch markers, runtime versions, desktop entry, update-metadata shape; `--layout=unpacked|appimage|deb|pacman`) and `verify:mcp` (Bun stdio, uvx stdio, SSE, Streamable HTTP; asserts `adaptConfig` rewrites to bundled runtimes).
- **Smoke (manual-only):** `smoke-linux.mjs` (CDP: webview loads `chat.qwen.ai`, platform IPC = `linux/x64`, version match) and `smoke-updater-mode.mjs` (updater fires only in AppImage mode). Not in `npm test`; CI runs them under `xvfb`.
- No coverage tooling. **QA = build the package, then run the verify/smoke scripts against it** — not a broad JS unit suite. `verify:*` and `npm test` require a prior `package:*` build. Always run `npm test` after touching a patch or build step.
