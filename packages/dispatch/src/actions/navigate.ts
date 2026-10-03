import { defineAction } from "@agent-native/core/action";
import { writeAppStateForCurrentTab } from "@agent-native/core/application-state";
import { z } from "zod";

export default defineAction({
  description:
    "Navigate the UI to a specific view or path. Use threadId to open a specific chat thread on the chat route. Writes a navigate command to application state which the UI reads and auto-deletes.",
  schema: z.object({
    view: z
      .string()
      .optional()
      .describe(
        "Named dispatch view to navigate to. Built-in views include chat, overview, apps, operations (or monitoring, observability, database), metrics, new-app, vault, integrations, messaging, workspace, agents, connected-agents, destinations, identities, approvals, automations, audit, thread-debug, dreams, team, workspace-app (with workspaceAppId), and workspace-app-chat (an app's own chat in full view, with workspaceAppId and optional appChatThreadId and workspaceAppPath). Generated Dispatch extension tabs can also use their nav item id.",
      ),
    path: z.string().optional().describe("URL path to navigate to"),
    threadId: z
      .string()
      .optional()
      .describe("Dispatch chat thread ID to open on the chat route"),
    workspaceAppId: z
      .string()
      .optional()
      .describe(
        "Workspace app id for the workspace-app and workspace-app-chat views",
      ),
    appChatThreadId: z
      .string()
      .optional()
      .describe(
        "A thread of the app's own agent to open in workspace-app-chat. Not a Dispatch thread id.",
      ),
    workspaceAppPath: z
      .string()
      .optional()
      .describe(
        "App-local route (for example /inbox?filter=unread) that workspace-app-chat returns to",
      ),
  }),
  http: false,
  run: async (args) => {
    const threadId = args.threadId?.trim();
    if (!args.view && !args.path && !threadId) {
      return "Error: At least --view, --path, or --threadId is required.";
    }
    const nav: Record<string, string> = {};
    if (args.view) nav.view = args.view;
    else if (threadId) nav.view = "chat";
    if (args.path) nav.path = args.path;
    if (threadId) nav.threadId = threadId;
    if (args.workspaceAppId?.trim()) {
      nav.workspaceAppId = args.workspaceAppId.trim();
    }
    if (args.appChatThreadId?.trim()) {
      nav.appChatThreadId = args.appChatThreadId.trim();
    }
    if (args.workspaceAppPath?.trim()) {
      nav.workspaceAppPath = args.workspaceAppPath.trim();
    }
    await writeAppStateForCurrentTab("navigate", nav);
    return `Navigating to ${args.view || args.path || `chat thread ${threadId}`}`;
  },
});
