import { describe, expect, it } from "vitest";

import { isAllowedWebviewPermission } from "./webview-permissions.js";

describe("webview permissions", () => {
  it("allows Web MIDI for the local Song Studio only", () => {
    expect(isAllowedWebviewPermission("midi", "song-studio")).toBe(true);
    expect(isAllowedWebviewPermission("midi", "fogbreak")).toBe(false);
    expect(isAllowedWebviewPermission("midi", "content")).toBe(false);
    expect(isAllowedWebviewPermission("midi", null)).toBe(false);
    expect(isAllowedWebviewPermission("midi")).toBe(false);
  });

  it("does not grant SysEx", () => {
    expect(isAllowedWebviewPermission("midiSysex", "song-studio")).toBe(false);
  });

  it("keeps the existing permissions for every app", () => {
    expect(isAllowedWebviewPermission("media", "fogbreak")).toBe(true);
    expect(isAllowedWebviewPermission("geolocation", "song-studio")).toBe(false);
  });
});
