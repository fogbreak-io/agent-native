import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  resolveDesktopUpdateSupport,
  resolveDesktopUserDataDirectoryName,
} from "../src/main/ipc/update-policy.js";
import { DESKTOP_DEEP_LINK_PROTOCOL } from "./release-channel.js";

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");
describe("Fogbreak distribution isolation", () => {
  it("uses only owned identity and scheme, with signing held for the owner", () => {
    const builder = read("../electron-builder.yml");
    expect(builder).toContain("appId: io.fogbreak.desktop");
    expect(builder).toContain("productName: Fogbreak");
    expect(builder).toContain("- fogbreak");
    expect(builder).toContain("publish: null");
    expect(builder).toContain("forceCodeSigning: true");
    expect(builder).toContain("notarize: true");
    expect(builder).not.toContain("BuilderIO");
    expect(builder).not.toContain("W3PMF2T3MW");
    expect(builder).not.toContain("desktop-update-config.yml");
    expect(builder).not.toContain("x64");
    expect(DESKTOP_DEEP_LINK_PROTOCOL).toBe("fogbreak");
  });
  it("isolates every default profile from the installed generic app", () => {
    expect(resolveDesktopUserDataDirectoryName(false, "0.1.150")).toBe(
      "Fogbreak Dev",
    );
    expect(resolveDesktopUserDataDirectoryName(true, "0.1.150")).toBe(
      "Fogbreak",
    );
    expect(resolveDesktopUserDataDirectoryName(true, "0.1.150-nightly.1")).toBe(
      "Fogbreak Nightly",
    );
  });
  it("fails closed for all updater channels and contains no inherited feed", () => {
    for (const channel of ["dev", "release", "nightly", "unknown"])
      expect(
        resolveDesktopUpdateSupport(true, "0.1.150", channel).supported,
      ).toBe(false);
    const updates = read("../src/main/ipc/updates.ts");
    expect(updates).toContain('const DESKTOP_UPDATE_FEED_URL = "";');
    expect(updates).not.toContain("agent-native.com/api/desktop-updates");
  });
  it("keeps the identity gate implementation and disables hosted development CSP overrides", () => {
    expect(read("../src/main/index.ts")).toContain(
      "IS_DEV && sess !== session.fromPartition(FOGBREAK_SESSION_PARTITION)",
    );
    const gate = read("../src/renderer/components/DesktopIdentityGate.tsx");
    expect(gate).toContain('if (status === "idle" || status === "signed-in")');
  });
  it("keeps the official workspace loader bound to the hosted session", () => {
    const main = read("../src/main/index.ts");
    const start = main.indexOf("loadWorkspaceApps: () => {");
    const end = main.indexOf("registerDesktopChatIpc", start);
    expect(start).toBeGreaterThan(0);
    const loader = main.slice(start, end);
    expect(loader).toContain("loadDesktopWorkspaceApps({");
    expect(loader).toContain(
      "identitySession: session.fromPartition(FOGBREAK_SESSION_PARTITION)",
    );
    expect(loader).not.toContain("DESKTOP_IDENTITY_PARTITION");
  });
});
