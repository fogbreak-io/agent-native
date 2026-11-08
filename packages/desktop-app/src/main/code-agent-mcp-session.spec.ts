import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { desktopAppSessionPartition } from "../../shared/fogbreak.js";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

function body(name: string): string {
  const start = source.indexOf(name);
  expect(start).toBeGreaterThan(-1);
  return source.slice(start, start + 6000);
}

describe("code-agent MCP tools use the app's own signed-in session", () => {
  it("reads app cookies from the webview partition, not a per-id copy", () => {
    const mcp = body("async function desktopCodeAgentMcpEnvironment");
    expect(mcp).toContain("session.fromPartition(desktopAppSessionPartition(appConfig))");
    expect(mcp).not.toContain("persist:app-${appConfig.id}");
  });

  it("matches the remote relay to the same partition", () => {
    const relay = body("function findRemoteRelaySession");
    expect(relay).toContain("session.fromPartition(desktopAppSessionPartition(matchingApp))");
  });

  it("hosted Fogbreak apps share the workspace partition", () => {
    for (const id of ["fogbreak", "content", "dispatch"]) {
      expect(
        desktopAppSessionPartition({ id, url: `https://fogbreak.io/${id}`, mode: "prod" } as never),
      ).toBe("persist:fogbreak-workspace");
    }
    expect(
      desktopAppSessionPartition({ id: "song-studio", url: "http://127.0.0.1:8100/song-studio", mode: "prod" } as never),
    ).toBe("persist:app-song-studio");
  });
  it("never registers a cookie-only Song Studio server when the mint fails", () => {
    const mcp = body("async function desktopCodeAgentMcpEnvironment");
    const song = mcp.slice(mcp.indexOf('if (appConfig.id === "song-studio")'));
    const branch = song.slice(0, song.indexOf("} else if (!cookieHeader)"));
    expect(branch).toContain("Song Studio MCP entry not minted; skipping");
    expect(branch.trimEnd().endsWith("continue;")).toBe(true);
  });
});
