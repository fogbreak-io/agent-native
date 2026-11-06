CHECKOUT 2026-11-06T06:59Z | remote origin https://github.com/fogbreak-io/agent-native | branch claude/orch8-desktop-lead (cut from claude/task-u11k2e) | HEAD 1910aa683a8d8ece729843566c4fa4ddd0b8ceda (= base fogbreak/desktop-current)

SKILL fogbreak:runtime-aware-agent-work READ whole; fogbreak:fogbreak-build READ whole (both via plugin SKILL.md path). Repo CLAUDE.md + AGENTS.md read. OWNER-RULES.md: not present in repo.

## Cloudflare evidence (asks 15,53,83,93,94,95,97,107)
- ListConnectors(cloudflare) in this dev cloud session: "Cloudflare Developer Platform" installedServerId 29eade97-..., installState=needs_reconnect, connected=false, enabledInChat=false.
- ToolSearch "cloudflare": no tools loaded. So the dev-cloud route cannot see the Cloudflare MCP; the Mac Desktop route is where it is reported connected. This is a route/profile difference, not a new ask for Kean.

## Asks
| id | state |
|---|---|
| 15,53,83,93,94,95,97,107 Cloudflare | IN PROGRESS (route diagnosis above) |
| 20,22,25,26,108 Control Room live in Chrome | OPEN |
| 46 Claude panel/orchestrator inside Fogbreak.app | OPEN |
