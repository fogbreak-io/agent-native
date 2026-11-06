---
"@agent-native/core": patch
---

Let an `MCP_SERVERS` entry give Codex a longer MCP startup timeout (`startupTimeoutSec`) and pre-approve that server's tools (`approveTools`), so a slow-starting local app and its tools work in a Codex run that cannot ask for approval.
