# Desktop sync with Agent Native 0.225.1: status

Branch `claude/desktop-sync-upstream-0225`, based on `fogbreak/desktop-current` (core 0.223.0, includes the AI SDK packaging change).

State: NOT STARTED, blocked on source access. This file is a placeholder so the branch and a draft PR exist; the merge itself has not been done.

- The fork `fogbreak-io/agent-native` holds no upstream history after core 0.198.7 on its `main` and has no `@agent-native/core@0.224.0`, `0.225.0` or `0.225.1` tag.
- This session can only read `fogbreak-io/agent-native`. Attaching `BuilderIO/agent-native` through the session's repo tool returned "MCP tool call requires approval"; it was not retried.
- npm's `@agent-native/core@0.225.1` has built code, not the monorepo source or history, so it cannot be merged.

Needed to continue (either): approval to read `BuilderIO/agent-native` in this session, or the fork's `main` and release tags synced from upstream so the `core@0.225.1` commit is in `fogbreak-io/agent-native`.

Plan once the commit is reachable: merge (not rebase) the `@agent-native/core@0.225.1` release commit, keep the Fogbreak branding, the desktop Claude panel (PR #2) and other fork-owned files, never hand-edit an `@agent-native/*` version, follow `packages/core/docs/content/package-lifecycle.mdx` and `syncing-template-changes.mdx`, run the desktop-app and core unit tests, and list every conflict with its resolution.
