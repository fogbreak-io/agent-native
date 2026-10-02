# Fogbreak-owned desktop source implementation

## Status and exact basis

Implemented in an isolated Linux cloud checkout on host `24d6bf0c9abd`, from clean `fogbreak-io/agent-native` branch `fogbreak/desktop-native-273`, exact base `31d29c8eeaf663b042bf38829c8f2042bac4e09f`. Its upstream parent is official 0.1.273 commit `90d5aaa0c8eb4d4225ad69561b61b45d5dcbc4bd`. The preparation packet was preserved; the branch was not reset to the upstream parent. Only `packages/desktop-app/` source is changed. No remote publication, installed app change, production action, grant, paid provider session or target-machine acceptance was performed.

This is an actionable source patch and Linux build result. It is not a Mac app, signed/notarized installer, authenticated Fogbreak journey or World/Golf/Games hardware acceptance.

## Implemented contract

- Fogbreak distributable metadata (`io.fogbreak.desktop`), arm64 Mac targets, `fogbreak://` namespace, own profile/workspace defaults, no inherited signing identity or update publisher. Updater support fails closed even if a caller accidentally builds a release channel.
- Fresh profile defaults to desktop SSO off. `DesktopIdentityGate.tsx` is byte-for-byte unchanged. The whole hosted website is composed through the existing sandboxed `AppWebview`, without `CodeAgentsHub`, provider launch, synthetic identity, embedded/chat-first query flags or a duplicate website navigation rail.
- Root `https://fogbreak.io/`, real Content `https://fogbreak.io/content`, and hidden Dispatch `https://fogbreak.io/dispatch`. One explicit persistent Fogbreak partition is used for hosted views and the existing official feature-flag/workspace loader. Unavailable inventory is surfaced and stale inventory is cleared. Server rollout/permission normalization is unchanged.
- A narrow optional `syncAppChatSidebar` presentation prop prevents the desktop from forcing the hosted website's chat UI closed; theme synchronization is also disabled for the owned entry. Default behavior of the upstream component remains intact.
- File > Content / CmdOrCtrl+2 opens a genuinely registered Content view with its original preload and folder authorization. File > Fogbreak / CmdOrCtrl+1 returns to the preserved root view. Closing Content returns to root. Root navigation to `/content` does not acquire Content privileges.
- Native chooser, cancellation, revoke, matching active view/sender/origin, path traversal, symlink and 2 MB checks remain intact. Tests use synthetic temporary directories only.
- Hosted sessions do not receive the upstream dev-mode CSP relaxation. Node integration, context isolation, sandboxing and native deep-link denial for embedded pages are unchanged.
- The desktop-local Mac icon script requires an approved Fogbreak input; it never substitutes upstream artwork or invokes the repository-wide branding generator.

## Build repairs within the desktop package

The pinned source contained two packaging inconsistencies:

1. Main/preload externalized Core and MCP v2 packages although the archive excludes their node_modules. The desktop Vite configuration now bundles these direct dependencies (plus electron-log) and keeps Electron/node-pty external by design.
2. The runner copy hook looked for removed `@modelcontextprotocol/sdk/package.json`. It now copies the frozen AJV/AJV-formats dependency closure using installed package metadata. The dynamic SSRF `undici` import is included from the existing pinned Core dependency; no version or dependency was added.

`check:fogbreak:closure` inspects static require/dynamic import ASTs and checks seven copied runtime packages, including generated AJV require paths, without resolving through workspace-only dependencies. It also rejects an injected dangling `@agent-native/core/shared` dependency; the test restores the build artifact byte-for-byte afterward.

The one explicitly reported optional probe is `virtual:agents-bundle`, which upstream catches before its existing filesystem fallback in `loadAgentsBundle`. No virtual-module shim or Core replacement was introduced. Actual ASAR/native loader proof is still a macOS packaging step.

## Commands and evidence

Toolchain: Node 22.22.0 and pnpm 10.29.1, matching the official Node 22 release lane and pinned package manager. Root lockfile unchanged: SHA256 `2feaea843846ce8959a7b4bfea08b52556e43ad1e46a1346501b1e22b4506f9f`.

The root postinstall selects unrelated workspace packages. The first download was stopped before lifecycle scripts, then the scoped setup used:

```sh
pnpm --filter @agent-native/desktop-app... install --frozen-lockfile --ignore-scripts
pnpm --filter '@agent-native/desktop-app^...' run build
pnpm --filter @agent-native/desktop-app typecheck
pnpm --filter @agent-native/desktop-app test
pnpm --filter @agent-native/desktop-app build:fogbreak
pnpm --filter @agent-native/desktop-app check:fogbreak:closure
```

Results:

- Frozen filtered install: PASS, 7 workspace projects selected. Six dependency projects built using their official scripts; no full-repository build.
- Desktop typecheck: PASS.
- Desktop package suite: PASS, 72 files / 666 tests. Includes owned registry, real AppWebview composition, Content authorization and filesystem boundary tests. Upstream generic/SSO component behavior remains tested with its original registry fixture; no vendor-mode security test was removed.
- Owned composition final focused run: PASS, 5 tests (fresh exact hosted root, no vendor auth calls, genuine Content/shared partition, repeated open/return, unsafe path rejection, inventory unavailability and settings interruption).
- Desktop build: PASS for main, all preloads, renderer, code runner and packaged multi-frontier smoke entry. This does not execute a provider.
- Final closure: PASS, 6 static nonbuiltin references / 7 runtime packages; optional upstream probe reported separately.
- Negative closure check: PASS, dangling Core/shared require rejected and artifact restored byte-for-byte.
- Packaging and app-store privacy focused checks: PASS; see source receipt for count.
- `git diff --check`: PASS.
- Mac assets: intentionally BLOCKED by the missing approved icon before any Swift or Mac packaging command runs.

The package's ordinary `test` script excludes `*.test.ts`. The separate `test:computer-control` run returned 67 passes / 6 failures. Five failures are already present in the exact base source: four stale source-comment boundary markers and one model-picker assertion that expects an unconditional prop while the unchanged source uses `showModelSelector ? availableModels : undefined`. Read-only baseline/candidate evidence is in the receipt bundle. The sixth expected the vendor protocol; that single intended namespace assertion was updated and its focused rerun passes. Do not report the full privacy suite as green.

The two required i18n aggregate guards could not initialize because the scoped install intentionally excludes the Docs package's `remark-mdx` dependency. They were not silently passed, skipped by a baseline edit or used to justify a full-repository install.

Build retains existing upstream warnings about CJS import.meta and ineffective dynamic chunk imports; target runtime packaging must exercise those paths. No macOS archive, signing, notarization or hardware smoke was run.

## Required integration decisions and next owners

1. **Desktop/design owner:** supply the approved existing Fogbreak icon and exact source/hash. `apps/dispatch/public/favicon.svg` and inherited icon512 were reported as Agent-Native artwork and must not be relabeled as Fogbreak. Package asset generation is held.
2. **Main + existing Native public-seam owner:** bind the website's Content transition if folder access must be reachable through its own navigation. The root view remains `fogbreak`; existing main-process security deliberately denies privileged `fogbreak://` requests from embedded pages. Do not broaden trust or rename root as Content. The trusted native File menu is currently the explicit supported activation path.
3. **Main/website owner:** verify own hosted authentication, OAuth callback/deep-link compatibility, session/logout, workspace/actions/Resources and all integrated feature inventories. No server/backend authority was changed here.
4. **Desktop integration owner:** apply/review the patch at exact base, retain this ejection manifest, resolve the upstream notice inconsistency, and use an approved Mac runner for own icon/Swift/Chrome-extension/ASAR packaging. Preserve `AGENT_NATIVE_DESKTOP_BUILD_CHANNEL=dev` for the first candidate. The generic upstream release workflow/build:mac path is not the owned publishing route and must not be dispatched as one.
5. **Human signer / approved release route:** supply authorized Developer ID/notary controls. `forceCodeSigning: true`, notarization and absent publisher prevent this source packet from silently becoming a vendor-signed or vendor-updating distribution.
6. **Desktop + existing World/Golf/Games feature owners:** execute the existing TARGET-MACHINE-ACCEPTANCE contract on the intended Mac mini for every supplied feature, including actual GPU/CPU/memory, frame/input measurements, audio/input, save/close/reopen/state restore and clean workspace return. Linux tests and a loaded page are not substitutes.
