---
"@agent-native/core": patch
---

Let an `MCP_SERVERS` entry carry two Codex-only settings. `startupTimeoutSec` sets the server's `startup_timeout_sec` (Codex's default is 30 s). `approveTools` allows pre-approving the server's tools, but `codexMcpConfigArgs` only adds `default_tools_approval_mode="approve"` for an invocation whose own `permissionMode` is `auto-edit` or `full-auto`, so a run that drops to read-only never keeps it. The startup timeout does not put a slow server's tools into Codex's first turn: Codex starts the turn without a non-required server that has not finished initializing, so the caller must have the server answering before it starts Codex.
