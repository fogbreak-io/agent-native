import { describe, expect, it, vi } from "vitest";

import {
  SONG_STUDIO_MCP_STARTUP_TIMEOUT_SEC,
  resolveDesktopAppMcpServer,
  type DesktopAppMcpInput,
} from "./desktop-app-mcp-servers.js";
import type { SongStudioMcpMintResult } from "./song-studio-local-session.js";

const TOKEN = "tok-secret-123";
const SONG_COOKIE = "an_session=song-cookie";

const minted: SongStudioMcpMintResult = {
  state: "minted",
  entry: {
    type: "http",
    url: "http://127.0.0.1:8100/song-studio/mcp",
    headers: { Authorization: `Bearer ${TOKEN}` },
  },
};

function song(
  mint: SongStudioMcpMintResult,
  overrides: Partial<DesktopAppMcpInput> = {},
) {
  const mintFn = vi.fn(async () => mint);
  const input: DesktopAppMcpInput = {
    app: { id: "song-studio", name: "Song Studio" },
    serverId: "desktop_app_song_studio",
    mcpUrl: "http://127.0.0.1:8100/song-studio/mcp",
    cookieHeader: SONG_COOKIE,
    permissionMode: "full-auto",
    songStudio: {
      baseUrl: "http://127.0.0.1:8100/song-studio",
      readSessionCookies: async () => SONG_COOKIE,
      mint: mintFn,
    },
    ...overrides,
  };
  return { input, mintFn };
}

describe("desktop app MCP servers", () => {
  it("gives Song its minted bearer entry, a 90 s startup budget and tool approval", async () => {
    const { input } = song(minted);
    expect(await resolveDesktopAppMcpServer(input)).toEqual({
      state: "ready",
      server: {
        type: "http",
        url: "http://127.0.0.1:8100/song-studio/mcp",
        headers: { Authorization: `Bearer ${TOKEN}` },
        description: "Song Studio workspace app tools",
        startupTimeoutSec: 90,
        approveTools: true,
      },
    });
    expect(SONG_STUDIO_MCP_STARTUP_TIMEOUT_SEC).toBe(90);
  });

  it("does not pre-approve Song's tools for a read-only run", async () => {
    for (const permissionMode of ["read-only", "ask-before-edit", ""]) {
      const resolution = await resolveDesktopAppMcpServer(
        song(minted, { permissionMode }).input,
      );
      expect(resolution.state).toBe("ready");
      if (resolution.state === "ready") {
        expect(resolution.server.approveTools).toBeUndefined();
      }
    }
  });

  it("leaves Song out with a plain status line instead of a cookie entry that gets a 401", async () => {
    const resolution = await resolveDesktopAppMcpServer(
      song({ state: "unavailable", reason: "timed-out", attempts: 2 }).input,
    );
    expect(resolution).toEqual({
      state: "omitted",
      notice: {
        serverId: "desktop_app_song_studio",
        reason: "timed-out",
        message: "Song tools unavailable: Song Studio is still starting",
      },
    });
    expect(JSON.stringify(resolution)).not.toContain("Cookie");
    expect(JSON.stringify(resolution)).not.toContain(SONG_COOKIE);
  });

  it("never falls back to the cookie for Song, whatever the reason", async () => {
    for (const reason of [
      "timed-out",
      "unreachable",
      "rejected",
      "malformed",
      "no-session",
      "not-local",
    ] as const) {
      const resolution = await resolveDesktopAppMcpServer(
        song({ state: "unavailable", reason, attempts: 1, status: 401 }).input,
      );
      expect(resolution.state).toBe("omitted");
    }
  });

  it("says a refusal was a refusal, not a slow start", async () => {
    const resolution = await resolveDesktopAppMcpServer(
      song({
        state: "unavailable",
        reason: "rejected",
        status: 401,
        attempts: 1,
      }).input,
    );
    expect(
      resolution.state === "omitted" && resolution.notice?.message,
    ).toContain("HTTP 401");
  });

  it("adds no generic status line when everything is healthy", async () => {
    const resolutions = [
      await resolveDesktopAppMcpServer(song(minted).input),
      await resolveDesktopAppMcpServer({
        ...song(minted).input,
        app: { id: "mail", name: "Mail" },
        serverId: "desktop_app_mail",
        mcpUrl: "https://mail.fogbreak.io/mcp",
        cookieHeader: "sid=abc",
      }),
    ];
    for (const resolution of resolutions) {
      expect(resolution.state).toBe("ready");
      expect(JSON.stringify(resolution)).not.toContain(
        "Connected MCP settings",
      );
      expect("notice" in resolution).toBe(false);
    }
  });

  it("keeps the cookie entry for a hosted app that has a login, and skips one that has none", async () => {
    const hosted = {
      ...song(minted).input,
      app: { id: "mail", name: "Mail" },
      serverId: "desktop_app_mail",
      mcpUrl: "https://mail.fogbreak.io/mcp",
    };
    expect(
      await resolveDesktopAppMcpServer({ ...hosted, cookieHeader: "sid=abc" }),
    ).toEqual({
      state: "ready",
      server: {
        type: "http",
        url: "https://mail.fogbreak.io/mcp",
        headers: { Cookie: "sid=abc" },
        description: "Mail workspace app tools",
      },
    });
    expect(
      await resolveDesktopAppMcpServer({ ...hosted, cookieHeader: "" }),
    ).toEqual({
      state: "omitted",
    });
  });
});
