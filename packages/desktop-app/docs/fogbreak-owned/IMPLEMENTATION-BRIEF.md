# Fogbreak-owned desktop — bounded implementation brief

Status: continuing desktop integration; next bounded cloud allocation requested from Main. Brief completion is a phase boundary, not completion of the Fogbreak app. No Fogbreak desktop source branch, product build, signed installer, or authenticated Fogbreak desktop journey is claimed complete.

Desktop owner: `01a0fe9a-c404-71cb-9a5c-51dce1a3a0fd`. Integration owner: Main `01a0f98e-584b-7201-a8f7-eadb5ccbedf4`. Parent: `01a0f03d-30d4-7743-9e50-2d6b75743029`. Do not create another worker/task or take over website/public-Core seam ownership.

## Intended result

Deliver **Fogbreak.app**, with Fogbreak's existing branding and hosted website navigation, Fogbreak's own hosted authentication, workspace, actions, Resources and data. Start at `https://fogbreak.io/`. Preserve supported internal routes such as `/dispatch` and `/content`. Do not copy the deployment/database into the app. The native layer is a client of the existing website and supplies only Native-supported desktop capabilities.

World, Golf (the owner's “gold” typo interpreted as Golf), and Games are mandatory in-app desktop acceptance scope. All their features must run inside the owned Fogbreak app and perform well using the target machine's CPU/GPU, memory, audio and input. A page loading does not satisfy acceptance. Preserve the intended rendering engine for each existing feature; do not introduce a parallel renderer or broad privileged IPC.

The installed generic `Agent-Native.app` 0.1.273 is a verified upstream packaging reference, not this deliverable. Leave it and the retained 0.1.274 backup untouched. No further vendor login is requested or authorized. No account metadata found proves that an Agent Native vendor account is a Fogbreak account.

## Exact source and observed candidate

- Build basis: official BuilderIO/agent-native release 0.1.273, source commit `90d5aaa0c8eb4d4225ad69561b61b45d5dcbc4bd`. Keep its upstream lockfile and workspace dependencies; do not mix current main or 0.1.274 without a separately evidenced fix.
- Installed official 0.1.273 arm64 ZIP: SHA256 `a73d7b296306564f72dc4afa64475ad78ebb55e68c6d143b67c88dbf17c648bc`. Signed/notarized upstream app launched successfully to the vendor sign-in surface. This proves the baseline package opens, not Fogbreak functionality.
- Official 0.1.274 failed with `Cannot find module '@agent-native/core/shared'`. Its packaged main externalized Core while the archive excluded that dependency. No ASAR repair was attempted.
- Pinned source desktop package metadata is 0.1.150; release workflow injects the release version. Do not infer a different source tag from package.json alone.
- Website candidate inspected earlier: dirty, active checkout at `e934c6e3d196faa2958ed944474eaba3af39b8b5`; actual installed Core/Toolkit 0.198.8 and Dispatch 0.40.9. Main selects the integrated website revision for acceptance; desktop must not overwrite or upgrade it.
- Public GETs previously returned 200 for root and Dispatch overview. Unauthenticated root feature-flags/workspace-app actions returned 401. No authenticated data, actions, Resources or Shores journey has been established.

## Research consumed and configuration boundary

All source references below are pinned to the official commit above. URLs and a SHA256 manifest accompany this brief. This is a source-backed proposal, not a claim that Builder documents a white-label Fogbreak preset.

| Need | Official mechanism | Boundary / consequence |
| --- | --- | --- |
| Own distributable | desktop README, Building for distribution; electron-builder.yml; desktop-release.yml | Source build/package is documented. Own productName, appId, icon, scheme, publisher/signing identity are packaging customization. Never retain Builder's signing identity or update stream as Fogbreak's. |
| Register hosted app | README, Register a built-in app; shared/app-registry.ts and AppConfig.url/mode | Documented registry edit; hosted prod URL is supported. Keep desktop-local overrides in desktop package, not shared app definitions used by other clients. |
| Fogbreak sign-in only | AppSettings Shared app sign-in toggle; app-store.ts:494–527; main/index.ts:1475–1512; DesktopIdentityGate.tsx:82–89 | Source supports SSO off: identity status idle/availability false and existing gate hides itself. Default=false in a new distribution is a source edit, not a documented branding flag. Do not delete the gate, forge a parent identity, or relax server auth. |
| Match whole website | renderer/App.tsx:456–517 currently renders CodeAgentsHub | No documented full-website/white-label switch found. Reusing existing AppWebview for a dedicated hosted entry is bounded renderer composition/ejection. Report this gap before adopting the change. Do not invent another navigation/action shell. |
| Share Fogbreak cookies | AppWebview.tsx:623–632 supports explicit partitionKey | One owned persistent Fogbreak partition can be composed across its hosted views. No browser cookie import, copying vendor sessions, or renderer token exposure. |
| Workspace inventory | main/workspace-apps.ts fetches official feature-flags and list-workspace-apps actions; main/index.ts:12799–12819 binds vendor identity partition | Merely turning SSO off is insufficient. Binding inventory to the Fogbreak session and same origin requires a desktop main source edit. Keep the official loader/normalizer and server permission/rollout checks. An unavailable/401 response must remain visible, not be replaced by fabricated inventory. |
| Scoped local folders | content-files-webview-access.ts; main/index.ts:9859–9896, 9999–10034 | Existing bridge requires real active `content` app, active webview ID and trusted configured origin. Grant occurs through Native's folder chooser, cancellation/deny supported. Keep grant, revoke, path/symlink checks. Do not rename root Fogbreak as content to obtain access. |
| Local content/resources | main/index.ts:9153–9165, 9275 onward | Markdown/MDX, max 2MB, plus bounded recognized control resources and .agents/.agent skills beneath the chosen folder. This is not an arbitrary-file/all-Shore bridge. Folder selection can reveal control-resource text; no grant during this lane. No automatic upload of owner source, secrets or broad home directory. |
| Own update/deep-link namespace | electron-builder.yml; shared/release-channel.ts; main/index.ts:418–428; ipc/update-policy.ts | Builder scheme exists in both package metadata and source; both require own namespace. Upstream `AGENT_NATIVE_DESKTOP_BUILD_CHANNEL=dev` disables updater through supported policy for a local packaged candidate. Production update publisher remains an owned release prerequisite. |

The independent-identity route uses ordinary hosted Fogbreak authentication with desktop SSO disabled. It does **not** register Fogbreak with vendor Dispatch or change `IDENTITY_SSO_APP_REGISTRY_JSON`. Repointing a broker and claiming custom SSO compatibility without validating the existing backend contract is excluded.

## One isolated source allocation

Cloud source branch created and read back: `fogbreak-io/agent-native`, `fogbreak/desktop-native-273`, initially at pinned upstream `90d5aaa0c8eb4d4225ad69561b61b45d5dcbc4bd`. This is an isolated branch, not the dirty website candidate or the existing Native public-seam writer's branch. Only this desktop lane may publish its preparation packet here until Main binds the cloud executor. Main assigns existing cloud capacity at its next safe boundary; this lane retains desktop integration ownership. Use the final published packet commit in `SOURCE-RECEIPT.json`, not a moving branch name alone.

Allow edits only under `packages/desktop-app/`:

1. `package.json`, `electron-builder.yml`, `build/` owned Fogbreak assets: own product metadata, app identifier `io.fogbreak.desktop`, approved existing Fogbreak icon; retain upstream build scripts and package/dependency versions. First installer target Mac arm64; do not introduce extra product platforms into the first acceptance batch.
2. `shared/app-registry.ts`: own desktop default hosted entry `fogbreak` at `https://fogbreak.io/`, with SSO participation off. Keep the real Content entry at `https://fogbreak.io/content` if needed for its existing bridge, and hidden Dispatch definition at `https://fogbreak.io/dispatch` for official workspace discovery. Do not change upstream shared-app-config for unrelated consumers.
3. `src/main/app-store.ts`: only new distribution's default desktopSsoEnabled=false; own application profile/root defaults if a source default would otherwise share generic dev/workspace storage. Do not migrate or rewrite generic installed settings.
4. `src/renderer/App.tsx`: compose the existing AppWebview as the initial Fogbreak website surface. Retain upstream context bridge, controls and identity gate behavior. Use its existing explicit partitionKey for the Fogbreak session. No new action UI, duplicate website rail or provider agent session launched by this entry.
5. `src/main/index.ts`: use the same Fogbreak session for the existing workspace loader; preserve all active-view and Content trust checks. Deep-link accepted protocols must match Fogbreak packaging. No new endpoint, auth broker, token exchanger or filesystem API.
6. `shared/release-channel.ts`, `src/main/ipc/update-policy.ts` only if necessary for own scheme/profile namespace; prefer existing dev build channel for first package. Do not publish to or update from Builder's feed.
7. Narrow adjacent `.spec.ts` tests and a desktop ejection manifest documenting each gap above. No dependency additions, node_modules edits, installed archive patching or changes to upstream protected Core/Toolkit runtime.

The desktop lane owns packaging/embedding and desktop measurement, not World/Golf/Games feature code. Main coordinates with their existing feature owners if a journey exposes a product failure. Do not clone their engines or change renderer contracts to make a shell test pass.

Possible file-bridge limitation must be resolved honestly: an ordinary root Fogbreak webview remains app ID `fogbreak`, so navigation to `/content` inside it does not automatically become the Native `content` app. Use an existing supported desktop open/active-view mechanism for a genuine Content view before granting folders. If this cannot preserve the website journey without a website/public-seam change, return the exact gap to Main and the existing Native public-seam writer; do not silently broaden the bridge. Main owns all website routing/auth/action changes.

Do not copy the Clips Tauri recorder as a substitute. Its official README supports a configurable Clips server and first-party auth, but it is a recording tray client with different native capabilities, not a generic full Fogbreak workspace or existing Content bridge.

## Cloud-first execution and checks

Use the pinned monorepo's supplied setup/build scripts, frozen lockfile, and supported runner. Official Mac release workflow uses Node 22; desktop package declares pnpm 10.29.1. Do not use the Mini's default Node 26/pnpm 10.33.0 as an assumed release toolchain. No local heavy install/build in this phase. Existing Orca/Claude subscription capacity is for coding/test work through Main; no new paid API or worker.

Official commands, from the appropriate cloud checkout:

```sh
pnpm install --frozen-lockfile
pnpm --filter @agent-native/desktop-app typecheck
pnpm --filter @agent-native/desktop-app test
pnpm --filter @agent-native/desktop-app build
```

Run the existing source specs affected by the patch explicitly as well. The package test script excludes `*.test.ts`, so a PASS there is not coverage of all privacy tests. Retain relevant `test:computer-control` / app-store privacy tests if changing profile or trust behavior. Add targeted proof of:

- Fresh Fogbreak profile shows website entry and hosted Fogbreak auth; no vendor sign-in, provider launch, or synthetic session. Identity gate remains source-intact and SSO-off paths are used.
- Registry/entry URLs preserve same origin and supported paths; shared partition survives app views; logout follows website auth and clears the intended session.
- Official workspace loader uses Fogbreak session, honors disabled flag/401/unavailable, and never creates invented Shores.
- Root app, inactive Content, mismatched sender, untrusted origin and invalid URL all fail folder IPC; real Content can invoke native chooser; cancel/revoke work; symlink/traversal and 2MB limits remain tested. No files granted in CI from a real owner directory.
- Own app ID/scheme/profile/update policy are distinct; no Builder update feed or vendor signing identity remains in Fogbreak packaging. Keep Sentry unconfigured unless an existing owner route is explicitly supplied; existing resolver disables it without a DSN.
- Build + archive closure: every nonbuiltin main/preload dependency is bundled or packaged. Specifically assert no dangling `@agent-native/core/shared` require, covering the observed 0.1.274 failure. Upstream packaged code-runner/multi-frontier smokes only when safe and scoped; do not start paid/provider sessions to satisfy a check.

Mac packaging is a separate runner requirement: official `desktop-release.yml` uses `macos-latest`; `build:mac-assets` builds the Swift helper plus branding and Chrome extension. A Linux cloud build does not prove a Mac app exists. No verified existing macOS cloud runner has been allocated to this lane. Main chooses an already approved macOS runner or reports that final native packaging requires a bounded Mini build; do not trigger a paid new runner or heavy local build here.

For the first local packaged candidate, the official source supports `AGENT_NATIVE_DESKTOP_BUILD_CHANNEL=dev` so auto-update is unavailable. Packaging uses the pinned installed electron-builder and the same `build:mac-assets` + `build` + Mac packaging sequence as the official workflow, with own configuration and no `--publish always`. Signed distribution is held until the signer route is verified. An unsigned build is not a bypass recipe or a functioning distributed installer.

## Release prerequisites and concrete blockers

1. **Configuration-only product gap:** upstream has no documented own-brand/full-website switch. Source composition/ejection above is explicitly separated from supported settings. Gaps were reported to Parent and Main before adoption. If the binding requirement means documented configuration only, the requested complete Fogbreak shell is currently unsupported; do not claim otherwise.
2. **Own signing/notarization:** `security find-identity -v -p codesigning` returned `0 valid identities found` in this execution context. This is no visible local identity, not proof no owner developer account exists. Apple Developer ID certificate, own team and authorized notary credentials/runner must be verified through normal owner-approved controls. Builder's team W3PMF2T3MW is not Fogbreak's signer. No credential export, new enrollment or spending is authorized here.
3. **License notice consistency:** the official repository identifies MIT. MIT permits modification, rebranding and distribution with the required notices; absence of a white-label toggle is not a licensing block. Pinned root README says MIT, root package metadata says ISC, root LICENSE is absent, and desktop private package has no license field. Resolve the exact-release notice inconsistency and preserve applicable notices before redistribution; do not treat the VS Code extension-only license as an independently established desktop notice. Continue source implementation.
4. **Website runtime:** authenticated Fogbreak auth/actions/Resources/workspace and Content desktop bridge have not been observed. Desktop packaging cannot repair an unavailable server/backend. Main retains website integration and deployment acceptance.
5. **Native Mac build route:** unallocated existing Mac cloud runner and signer; cloud Linux typecheck/build is an earlier stage, not desktop delivery.

No change to production data, credentials, website authority, releases, held deployments or installed generic app is included.

## Required terminal reporting

At each meaningful change, blocker, or stop/completion, report to Main and Parent: exact command/result artifact, exact reason, next action and responsible owner. Forward existing workers' terminal receipts through the desktop owner; do not bury them in a helper thread or add idle pings/schedulers.

This phase's result artifact is this brief plus `SOURCE-RECEIPT.json` and `TARGET-MACHINE-ACCEPTANCE.md`. The desktop objective continues beyond this brief. Next action: **Main** assigns this single bounded packet to existing cloud capacity and coordinates the Native public-seam writer only for evidenced cross-boundary gaps; **desktop owner** pushes that handoff, integrates terminal source/build receipts and performs eventual authorized target-machine acceptance. No cloud source/runtime lease or signed distribution route is claimed yet. No new local heavy build until the packaging route is assigned. Signing/personal credentials remain with the human owner through supported controls.
