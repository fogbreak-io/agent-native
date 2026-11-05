import { describe, expect, it } from "vitest";

import { DESKTOP_DEFAULT_APPS } from "./app-registry.js";
import {
  FOGBREAK_ORIGIN,
  FOGBREAK_SESSION_PARTITION,
  FOGBREAK_SONG_STUDIO_URL,
  desktopAppSessionPartition,
  resolveFogbreakOpenUrl,
} from "./fogbreak.js";

const byId = (id: string) => {
  const app = DESKTOP_DEFAULT_APPS.find((candidate) => candidate.id === id);
  if (!app) throw new Error(`missing default app ${id}`);
  return app;
};

describe("Fogbreak hosted composition", () => {
  it("uses the owned hosted entry and one shared partition without vendor SSO", () => {
    expect(DESKTOP_DEFAULT_APPS.map(({ id, url }) => [id, url])).toEqual([
      ["song-studio", FOGBREAK_SONG_STUDIO_URL],
      ["fogbreak", "https://fogbreak.io/"],
      ["content", "https://fogbreak.io/content"],
      ["dispatch", "https://fogbreak.io/dispatch"],
    ]);
    for (const app of DESKTOP_DEFAULT_APPS) {
      expect(app.mode).toBe("prod");
      expect(app.workspaceSso).toBe(false);
      // Song Studio is the local service on this computer: its own partition.
      expect(desktopAppSessionPartition(app)).toBe(
        app.id === "song-studio"
          ? "persist:app-song-studio"
          : FOGBREAK_SESSION_PARTITION,
      );
    }
  });
  it("preserves hosted paths, queries and fragments", () => {
    expect(resolveFogbreakOpenUrl(byId("fogbreak"))).toBe(
      `${FOGBREAK_ORIGIN}/`,
    );
    expect(resolveFogbreakOpenUrl(byId("content"))).toBe(
      `${FOGBREAK_ORIGIN}/content`,
    );
    for (const path of [
      "/dispatch",
      "/content/item?view=all#section",
      "/world",
      "/golf",
      "/games",
    ]) {
      expect(resolveFogbreakOpenUrl(byId("fogbreak"), path)).toBe(
        `${FOGBREAK_ORIGIN}${path}`,
      );
    }
  });
  it.each([
    "//evil.example",
    "/\\evil.example",
    "https://evil.example",
    "/https:evil.example",
    "/\n/evil.example",
  ])("rejects unsafe open path %s", (path) => {
    expect(resolveFogbreakOpenUrl(byId("fogbreak"), path)).toBeNull();
  });
  it("does not share the owned partition with modified or unrelated apps", () => {
    for (const change of [
      { id: "mail" },
      { url: "https://evil.example" },
      { url: "https://name:password@fogbreak.io/" },
      { mode: "dev" as const },
    ]) {
      const app = { ...byId("fogbreak"), ...change };
      expect(resolveFogbreakOpenUrl(app)).toBeNull();
      expect(desktopAppSessionPartition(app)).not.toBe(
        FOGBREAK_SESSION_PARTITION,
      );
    }
  });
});
