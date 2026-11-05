import { describe, expect, it, vi } from "vitest";

import {
  isLoopbackSongStudioUrl,
  parseSetCookie,
  signInSongStudioLocally,
} from "./song-studio-local-session.js";

describe("song studio local sign-in", () => {
  it("only accepts loopback addresses", () => {
    expect(isLoopbackSongStudioUrl("http://127.0.0.1:8100/song-studio")).toBe(true);
    expect(isLoopbackSongStudioUrl("https://fogbreak.io/")).toBe(false);
  });

  it("parses a session cookie", () => {
    const cookie = parseSetCookie(
      "an_session=abc; Path=/; HttpOnly; Max-Age=60; SameSite=Lax",
      0,
    );
    expect(cookie).toMatchObject({
      name: "an_session",
      value: "abc",
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      expirationDate: 60,
    });
  });

  it("stores the cookie the local route returns", async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("{}", {
        status: 200,
        headers: { "set-cookie": "an_session=abc; Path=/; HttpOnly" },
      }),
    );
    const result = await signInSongStudioLocally(
      { cookies: { set } } as never,
      "http://127.0.0.1:8100/song-studio",
      fetchImpl as never,
    );
    expect(result).toEqual({ ok: true });
    expect(fetchImpl.mock.calls[0][0]).toBe(
      "http://127.0.0.1:8100/song-studio/_agent-native/auth/local-dev",
    );
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ url: "http://127.0.0.1:8100", name: "an_session" }),
    );
  });

  it("refuses a hosted address", async () => {
    const result = await signInSongStudioLocally(
      { cookies: { set: vi.fn() } } as never,
      "https://fogbreak.io/song-studio",
    );
    expect(result.ok).toBe(false);
  });
});
