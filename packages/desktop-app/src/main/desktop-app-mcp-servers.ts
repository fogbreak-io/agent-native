import {
  songStudioToolsUnavailableNotice,
  type SongStudioMcpEntry,
  type SongStudioReadyResult,
} from "./song-studio-local-session.js";

/** Longer than Codex's 30 s default, which a cold Song route can outlast. */
export const SONG_STUDIO_MCP_STARTUP_TIMEOUT_SEC = 90;

export interface DesktopAppMcpServer extends SongStudioMcpEntry {
  description: string;
  /** Codex-only; see `codexMcpConfigArgs`. */
  startupTimeoutSec?: number;
  /**
   * Codex-only. Says approval is allowed, not that it is given: Codex decides
   * per invocation from that invocation's permission mode.
   */
  approveTools?: boolean;
}

export interface DesktopMcpNotice {
  serverId: string;
  reason: string;
  message: string;
}

export type DesktopAppMcpResolution =
  | { state: "ready"; server: DesktopAppMcpServer }
  | { state: "omitted"; notice?: DesktopMcpNotice };

export interface DesktopAppMcpInput {
  app: { id: string; name: string };
  serverId: string;
  mcpUrl: string;
  /** The app the run was opened from, when it was opened from one. */
  boundAppId?: string | undefined;
  /** Browser cookies for `mcpUrl`; empty when the app has no login. */
  cookieHeader: string;
  songStudio: {
    /**
     * Signs in locally if needed, then mints Song's entry and warms its MCP
     * route inside one bounded wait.
     */
    prepare: () => Promise<SongStudioReadyResult>;
  };
}

export const SONG_STUDIO_APP_ID = "song-studio";

/** The app a chat run was opened from, as the renderer records it. */
export function boundAppIdFromRunMetadata(
  metadata: unknown,
): string | undefined {
  if (typeof metadata !== "object" || metadata === null) return undefined;
  const appId = (metadata as { appId?: unknown }).appId;
  return typeof appId === "string" && appId ? appId : undefined;
}

/**
 * Decides what MCP server, if any, one workspace app contributes to a run.
 * Song Studio's MCP rejects the browser cookie, so its entry is minted and the
 * route warmed before the CLI starts; only a run opened from Song waits for
 * that, and only such a run is told when Song was left out. When the entry
 * cannot be made ready in time the server is omitted: a cookie entry would
 * only fail with a 401 inside the CLI.
 */
export async function resolveDesktopAppMcpServer(
  input: DesktopAppMcpInput,
): Promise<DesktopAppMcpResolution> {
  const description = `${input.app.name} workspace app tools`;
  if (input.app.id === SONG_STUDIO_APP_ID) {
    if (input.boundAppId !== SONG_STUDIO_APP_ID) return { state: "omitted" };
    const ready = await input.songStudio.prepare();
    if (ready.state === "ready") {
      return {
        state: "ready",
        server: {
          ...ready.entry,
          description,
          startupTimeoutSec: SONG_STUDIO_MCP_STARTUP_TIMEOUT_SEC,
          approveTools: true,
        },
      };
    }
    return {
      state: "omitted",
      notice: {
        serverId: input.serverId,
        reason: ready.reason,
        message: songStudioToolsUnavailableNotice(ready),
      },
    };
  }
  // A hosted fogbreak.io app with no login has no tools to offer.
  if (!input.cookieHeader) return { state: "omitted" };
  return {
    state: "ready",
    server: {
      type: "http",
      url: input.mcpUrl,
      headers: { Cookie: input.cookieHeader },
      description,
    },
  };
}
