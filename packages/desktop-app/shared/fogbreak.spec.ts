import { describe, expect, it } from "vitest";

import { DESKTOP_DEFAULT_APPS } from "./app-registry.js";
import {
  FOGBREAK_ORIGIN,
  FOGBREAK_SESSION_PARTITION,
  desktopAppSessionPartition,
  resolveFogbreakOpenUrl,
} from "./fogbreak.js";

describe("Fogbreak hosted composition", () => {
  it("uses the owned hosted entry and one shared partition without vendor SSO", () => {
    expect(DESKTOP_DEFAULT_APPS.map(({ id, url }) => [id, url])).toEqual([
      ["fogbreak", "https://fogbreak.io/"],
      ["content", "https://fogbreak.io/content"],
      ["dispatch", "https://fogbreak.io/dispatch"],
    ]);
    for (const app of DESKTOP_DEFAULT_APPS) {
      expect(app.mode).toBe("prod");
      expect(app.workspaceSso).toBe(false);
      expect(desktopAppSessionPartition(app)).toBe(FOGBREAK_SESSION_PARTITION);
    }
  });
  it("preserves hosted paths, queries and fragments", () => {
    expect(resolveFogbreakOpenUrl(DESKTOP_DEFAULT_APPS[0])).toBe(
      `${FOGBREAK_ORIGIN}/`,
    );
    expect(resolveFogbreakOpenUrl(DESKTOP_DEFAULT_APPS[1])).toBe(
      `${FOGBREAK_ORIGIN}/content`,
    );
    for (const path of [
      "/dispatch",
      "/content/item?view=all#section",
      "/world",
      "/golf",
      "/games",
    ]) {
      expect(resolveFogbreakOpenUrl(DESKTOP_DEFAULT_APPS[0], path)).toBe(
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
    expect(resolveFogbreakOpenUrl(DESKTOP_DEFAULT_APPS[0], path)).toBeNull();
  });
  it("does not share the owned partition with modified or unrelated apps", () => {
    for (const change of [
      { id: "mail" },
      { url: "https://evil.example" },
      { url: "https://name:password@fogbreak.io/" },
      { mode: "dev" as const },
    ]) {
      const app = { ...DESKTOP_DEFAULT_APPS[0], ...change };
      expect(resolveFogbreakOpenUrl(app)).toBeNull();
      expect(desktopAppSessionPartition(app)).not.toBe(
        FOGBREAK_SESSION_PARTITION,
      );
    }
  });
});
