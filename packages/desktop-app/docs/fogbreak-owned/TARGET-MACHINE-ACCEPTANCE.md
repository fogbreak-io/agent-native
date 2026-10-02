# Required Fogbreak desktop acceptance — World, Golf, Games

Status: acceptance specification, **not executed**. Desktop owner `01a0fe9a-c404-71cb-9a5c-51dce1a3a0fd`; Main `01a0f98e-584b-7201-a8f7-eadb5ccbedf4` owns website/feature integration. No new worker and no heavy local build until Main assigns packaging route.

## Evidence boundary

Use the owned Fogbreak desktop candidate, not the generic Agent Native client, an external browser tab, a mocked page, or a separate game launcher. Record package/source SHA, embedded website/deployment SHA where observable, OS/model/CPU/GPU/RAM, display resolution/refresh rate and actual Electron/Chromium version. Acceptance runs on the intended Mac mini; source/unit checks are earlier evidence only.

Reuse Native's existing sandboxed AppWebview and supported native measurement/tooling. Keep nodeIntegration=false, contextIsolation=true and sandbox=true. Retain the existing feature's intended renderer. Do not expose generic filesystem, process, GPU, shell or unrestricted IPC to website code for diagnostics. Do not disable web security or create a second renderer to hide a failed native embedding.

## Feature inventory and journeys

Before execution, Main/each existing feature owner supplies the exact integrated World, Golf and Games feature inventory and intended renderer contracts. Bind acceptance rows to that revision. Every feature needs its meaningful journey; a representative game or a root-page load cannot stand in for all features.

For each row record entry from Fogbreak workspace, feature initialization, actual interaction, completion/state change, save, close/reopen, restored state and clean return to workspace. Exercise relevant keyboard/mouse/controller/touchpad input, focus transitions and audio start/stop/volume behavior. Grant real device permissions only at an authorized action-time prompt. Persist through the existing action/data contract; no invented local save authority or server mutation to manufacture success.

## Hardware and performance evidence

- Confirm actual renderer identity and hardware acceleration through Electron's official app.getGPUFeatureStatus()/app.getGPUInfo() from the trusted native diagnostics context, plus the feature's real graphics backend/context. Record software fallback, disabled acceleration, context loss or unsupported capability as observed failures; do not simply infer acceleration from configuration.
- Capture frame times and visible responsiveness during real interaction at the target resolution. Report median and p95/p99 frame time, dropped/stalled frames, load/transition time and input response, with run length and workload. Compare to feature-owner acceptance targets and a same-machine web reference where meaningful. Targets must be documented before PASS; do not invent thresholds after observing a slow run.
- Record actual CPU and GPU activity and memory/renderer process totals with the supported OS/Electron diagnostics. Run repeated enter/play/save/exit/reopen cycles and a sustained feature workload; record peak/steady memory, growth, crashes, hangs and leaked activity after returning to workspace. A single snapshot is not stability evidence.
- Verify audio and input work while embedded; returning to workspace must restore correct focus, end unintended sound and expensive background work, preserve legitimate saves, and keep workspace navigation/auth/actions usable. Reopen must restore the actual feature state through the existing save contract.
- Include screenshots/short captured evidence where permitted and artifact paths for measurements. Do not use synthetic capture or mocked metrics as target-machine evidence.

Official Electron primary references to check at measurement implementation: https://www.electronjs.org/docs/latest/api/app (getGPUFeatureStatus, getGPUInfo, getAppMetrics); https://www.electronjs.org/docs/latest/api/content-tracing . Use APIs appropriate to the pinned Electron version and existing trusted diagnostics context, not a new unsafe web bridge.

## Result table required from executor

| Feature/revision | Intended + observed renderer | GPU acceleration | Frame/input measurements | CPU/GPU + memory/stability | Audio/input | Save/reopen | Return to workspace | Result/artifact |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| World — all supplied feature rows | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Not run |
| Golf — all supplied feature rows | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Not run |
| Games — all supplied feature rows | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Not run |

Failures go to Main and the existing feature owner with exact command/run, candidate and result artifact. Desktop owner retains embedding/measurement repairs; feature owners retain game/World implementation. Stop/completion reports name artifact, reason, next action and responsible owner. Overall desktop acceptance remains open until all rows pass or the human owner explicitly changes scope.
