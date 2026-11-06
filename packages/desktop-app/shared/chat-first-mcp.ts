import type {
  McpServer,
  McpServersList,
  TestMcpUrlResult,
} from "@agent-native/core/client/resources";

// oracle-change(packages/desktop-app/shared/chat-first-mcp.spec.ts): its only subject, the always-unavailable remote MCP state, was removed with its last caller.
export const CHAT_FIRST_MCP_IPC = {
  LIST: "chat-first:mcp:list",
  CREATE: "chat-first:mcp:create",
  DELETE: "chat-first:mcp:delete",
  RECONNECT: "chat-first:mcp:reconnect",
  TEST: "chat-first:mcp:test",
  TEST_EXISTING: "chat-first:mcp:test-existing",
  START_OAUTH: "chat-first:mcp:start-oauth",
  IMPORT_PLUGIN: "chat-first:mcp:import-plugin",
} as const;

export type ChatFirstMcpServer = McpServer;
export type ChatFirstMcpServersList = McpServersList;
export type ChatFirstMcpTestResult = TestMcpUrlResult;

export interface ChatFirstMcpOAuthRequest {
  url: string;
  webContentsId: number;
}

export interface ChatFirstMcpPluginImportResult {
  ok: boolean;
  plugin?: {
    name: string;
    version?: string;
  };
  skills?: number;
  mcpServers?: number;
  skipped?: Array<{
    component: "skill" | "mcp";
    name?: string;
    reason: string;
  }>;
  warnings?: string[];
  targetDir?: string;
  error?: string;
}
