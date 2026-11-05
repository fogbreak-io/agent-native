import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

describe("Fogbreak model picker engines", () => {
  it("keeps the local subscription engines on the user's own CLI logins", () => {
    expect(source).toContain('const CLAUDE_CLI_ENGINE_NAME = "claude-cli"');
    expect(source).toContain('const CODEX_CLI_ENGINE_NAME = "codex-cli"');
    expect(source).toContain("Run locally through your signed-in Claude subscription.");
    expect(source).toContain("Run locally through your signed-in ChatGPT subscription.");
  });
  it("offers Gemini and OpenRouter through the shipped core engines", () => {
    expect(source).toContain('engine: "ai-sdk:google"');
    expect(source).toContain('engine: "ai-sdk:openrouter"');
    expect(source).toContain('"OPENROUTER_API_KEY"');
  });
  it("never offers Claude models through OpenRouter", () => {
    expect(source).toContain('!model.toLowerCase().startsWith("anthropic/")');
  });
  it("supports a launch that never takes focus", () => {
    expect(source).toContain('process.env.FOGBREAK_BACKGROUND_LAUNCH === "1"');
    expect(source).toContain("win.showInactive()");
  });
  it("signs in to the local Song Studio and skips the fogbreak.io inventory when logged out", () => {
    expect(source).toContain("signInSongStudioLocally(");
    expect(source).toContain("await ensureSongStudioLocalSession();");
    expect(source).toContain("baseUrl: FOGBREAK_SONG_STUDIO_URL");
    expect(source).toContain("cookies.length === 0");
  });
});
