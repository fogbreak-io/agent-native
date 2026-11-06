import {
  songStudioToolsUnavailableNotice,
  type SongStudioMcpEntry,
  type SongStudioMcpMintResult,
} from "./song-studio-local-session.js";

/** Longer than Codex's 30 s default, which a cold Song route can outlast. */
export const SONG_STUDIO_MCP_STARTUP_TIMEOUT_SEC = 90;

export interface DesktopAppMcpServer extends SongStudioMcpEntry {
  description: string;
  /** Codex-only; see `codexMcpConfigArgs`. */
  startupTimeoutSec?: number;
  /** Codex-only; lets a write-capable run call this server's tools. */
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
  /** Browser cookies for `mcpUrl`; empty when the app has no login. */
  cookieHeader: string;
  permissionMode: string;
  songStudio: {
    baseUrl: string;
    /** Signs in locally if needed and returns the Song cookie header. */
    readSessionCookies: () => Promise<string>;
    mint: (
      cookieHeader: string,
      baseUrl: string,
    ) => Promise<SongStudioMcpMintResult>;
  };
}

// Same split Claude's driver/watchdog uses: only a write-capable run may call
// Song tools without asking, and a Codex run cannot ask.
function isWriteCapablePermissionMode(mode: string): boolean {
  return mode === "auto-edit" || mode === "full-auto";
}

/**
 * Decides what MCP server, if any, one workspace app contributes to a run.
 * Song Studio's MCP rejects the browser cookie, so when its connection entry
 * cannot be minted the server is left out and the run says why. A cookie entry
 * would only fail with a 401 inside the CLI.
 */
export async function resolveDesktopAppMcpServer(
  input: DesktopAppMcpInput,
): Promise<DesktopAppMcpResolution> {
  const description = `${input.app.name} workspace app tools`;
  if (input.app.id === "song-studio") {
    const cookies = await input.songStudio.readSessionCookies();
    const minted = await input.songStudio.mint(
      cookies,
      input.songStudio.baseUrl,
    );
    if (minted.state === "minted") {
      return {
        state: "ready",
        server: {
          ...minted.entry,
          description,
          startupTimeoutSec: SONG_STUDIO_MCP_STARTUP_TIMEOUT_SEC,
          ...(isWriteCapablePermissionMode(input.permissionMode)
            ? { approveTools: true }
            : {}),
        },
      };
    }
    return {
      state: "omitted",
      notice: {
        serverId: input.serverId,
        reason: minted.reason,
        message: songStudioToolsUnavailableNotice(minted),
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
