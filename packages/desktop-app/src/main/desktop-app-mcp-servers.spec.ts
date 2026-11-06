import { describe, expect, it, vi } from "vitest";

import {
  SONG_STUDIO_MCP_STARTUP_TIMEOUT_SEC,
  boundAppIdFromRunMetadata,
  resolveDesktopAppMcpServer,
  type DesktopAppMcpInput,
} from "./desktop-app-mcp-servers.js";
import type { SongStudioReadyResult } from "./song-studio-local-session.js";

const TOKEN = "tok-secret-123";
const SONG_COOKIE = "an_session=song-cookie";

const ready: SongStudioReadyResult = {
  state: "ready",
  entry: {
    type: "http",
    url: "http://127.0.0.1:8100/song-studio/mcp",
    headers: { Authorization: `Bearer ${TOKEN}` },
  },
};

function song(
  outcome: SongStudioReadyResult,
  overrides: Partial<DesktopAppMcpInput> = {},
) {
  const prepare = vi.fn(async () => outcome);
  const input: DesktopAppMcpInput = {
    app: { id: "song-studio", name: "Song Studio" },
    serverId: "desktop_app_song_studio",
    mcpUrl: "http://127.0.0.1:8100/song-studio/mcp",
    boundAppId: "song-studio",
    cookieHeader: SONG_COOKIE,
    songStudio: { prepare },
    ...overrides,
  };
  return { input, prepare };
}

describe("desktop app MCP servers", () => {
  it("gives Song its prepared bearer entry, a 90 s startup budget and the approval intent", async () => {
    const { input } = song(ready);
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

  it("leaves Song out with a plain status line instead of a cookie entry that gets a 401", async () => {
    const resolution = await resolveDesktopAppMcpServer(
      song({
        state: "unavailable",
        stage: "mint",
        reason: "timed-out",
      }).input,
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

  it("never falls back to the cookie for Song, whatever the reason or stage", async () => {
    for (const stage of ["mint", "initialize"] as const) {
      for (const reason of [
        "timed-out",
        "unreachable",
        "rejected",
        "malformed",
        "no-session",
        "not-local",
      ] as const) {
        const resolution = await resolveDesktopAppMcpServer(
          song({ state: "unavailable", stage, reason, status: 401 }).input,
        );
        expect(resolution.state).toBe("omitted");
      }
    }
  });

  it("says a refusal was a refusal, not a slow start", async () => {
    const resolution = await resolveDesktopAppMcpServer(
      song({
        state: "unavailable",
        stage: "initialize",
        reason: "rejected",
        status: 401,
      }).input,
    );
    expect(
      resolution.state === "omitted" && resolution.notice?.message,
    ).toContain("HTTP 401");
  });

  it("makes a run for another app, or for none, neither wait for Song nor hear about it", async () => {
    for (const boundAppId of ["mail", "dispatch", undefined]) {
      const { input, prepare } = song(
        { state: "unavailable", stage: "mint", reason: "timed-out" },
        { boundAppId },
      );
      expect(await resolveDesktopAppMcpServer(input)).toEqual({
        state: "omitted",
      });
      expect(prepare).not.toHaveBeenCalled();
    }
  });

  it("waits for Song exactly once for a run opened from Song", async () => {
    const { input, prepare } = song(ready);
    await resolveDesktopAppMcpServer(input);
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it("adds no generic status line when everything is healthy", async () => {
    const resolutions = [
      await resolveDesktopAppMcpServer(song(ready).input),
      await resolveDesktopAppMcpServer({
        ...song(ready).input,
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
      ...song(ready).input,
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
    ).toEqual({ state: "omitted" });
  });
});

describe("boundAppIdFromRunMetadata", () => {
  it("reads the app a run was opened from and nothing else", () => {
    expect(boundAppIdFromRunMetadata({ appId: "song-studio" })).toBe(
      "song-studio",
    );
    expect(boundAppIdFromRunMetadata({ appId: "" })).toBeUndefined();
    expect(boundAppIdFromRunMetadata({ appId: 3 })).toBeUndefined();
    expect(boundAppIdFromRunMetadata({})).toBeUndefined();
    expect(boundAppIdFromRunMetadata(undefined)).toBeUndefined();
    expect(boundAppIdFromRunMetadata("song-studio")).toBeUndefined();
  });
});
