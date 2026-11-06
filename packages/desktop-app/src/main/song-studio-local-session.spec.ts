import { describe, expect, it, vi } from "vitest";

import {
  SONG_STUDIO_MINT_TIMEOUT_MS,
  createSongStudioLocalSession,
  isLoopbackSongStudioUrl,
  SONG_STUDIO_READY_BUDGET_MS,
  mintSongStudioMcpEntry,
  parseSetCookie,
  prepareSongStudioMcp,
  signInSongStudioLocally,
  songStudioToolsUnavailableNotice,
  warmSongStudioMcp,
} from "./song-studio-local-session.js";

describe("song studio local sign-in", () => {
  it("only accepts loopback addresses", () => {
    expect(isLoopbackSongStudioUrl("http://127.0.0.1:8100/song-studio")).toBe(
      true,
    );
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
      expect.objectContaining({
        url: "http://127.0.0.1:8100",
        name: "an_session",
      }),
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

const SONG_URL = "http://127.0.0.1:8100/song-studio";
const TOKEN = "tok-secret-123";
const COOKIE = "an_session=cookie-secret-456";

function timeoutError(): Error {
  return Object.assign(new Error(`timed out talking with ${TOKEN}`), {
    name: "TimeoutError",
  });
}

function mintedResponse(): Response {
  return new Response(
    JSON.stringify({
      mcpServerEntry: {
        type: "http",
        url: "http://127.0.0.1:8100/song-studio/mcp",
        headers: { Authorization: `Bearer ${TOKEN}` },
      },
    }),
    { status: 200 },
  );
}

const MINTED_ENTRY = {
  type: "http",
  url: "http://127.0.0.1:8100/song-studio/mcp",
  headers: { Authorization: `Bearer ${TOKEN}` },
};

describe("song studio MCP entry", () => {
  it("returns the entry from the connect route", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(mintedResponse());
    const result = await mintSongStudioMcpEntry(
      COOKIE,
      SONG_URL,
      fetchImpl as never,
    );
    expect(result).toEqual({ state: "minted", entry: MINTED_ENTRY });
    expect(fetchImpl.mock.calls[0][0]).toBe(
      "http://127.0.0.1:8100/song-studio/_agent-native/mcp/connect/token",
    );
  });

  it("waits 90 s for a cold Song route on every attempt", async () => {
    expect(SONG_STUDIO_MINT_TIMEOUT_MS).toBe(90_000);
    const createTimeoutSignal = vi.fn(() => new AbortController().signal);
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(timeoutError())
      .mockResolvedValueOnce(mintedResponse());
    await mintSongStudioMcpEntry(COOKIE, SONG_URL, fetchImpl as never, {
      createTimeoutSignal,
    });
    expect(createTimeoutSignal.mock.calls).toEqual([[90_000], [90_000]]);
  });

  it("retries once after a timeout and then succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(timeoutError())
      .mockResolvedValueOnce(mintedResponse());
    const result = await mintSongStudioMcpEntry(
      COOKIE,
      SONG_URL,
      fetchImpl as never,
    );
    expect(result).toEqual({ state: "minted", entry: MINTED_ENTRY });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("gives up after exactly one retry and says it timed out", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(timeoutError());
    const result = await mintSongStudioMcpEntry(
      COOKIE,
      SONG_URL,
      fetchImpl as never,
    );
    expect(result).toEqual({
      state: "unavailable",
      reason: "timed-out",
      attempts: 2,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries a server error once but never a refusal", async () => {
    const flaky = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(mintedResponse());
    expect(
      (await mintSongStudioMcpEntry(COOKIE, SONG_URL, flaky as never)).state,
    ).toBe("minted");
    expect(flaky).toHaveBeenCalledTimes(2);

    const refused = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 401 }));
    expect(
      await mintSongStudioMcpEntry(COOKIE, SONG_URL, refused as never),
    ).toEqual({
      state: "unavailable",
      reason: "rejected",
      status: 401,
      attempts: 1,
    });
    expect(refused).toHaveBeenCalledTimes(1);
  });

  it("tells absent, refused, unreachable, timed out and unreadable apart", async () => {
    const reasonFor = async (
      cookie: string,
      url: string,
      fetchImpl: typeof fetch,
    ) => {
      const result = await mintSongStudioMcpEntry(cookie, url, fetchImpl);
      return result.state === "unavailable" ? result.reason : result.state;
    };
    const never = vi.fn();
    expect(await reasonFor("", SONG_URL, never as never)).toBe("no-session");
    expect(
      await reasonFor(COOKIE, "https://fogbreak.io/song", never as never),
    ).toBe("not-local");
    expect(never).not.toHaveBeenCalled();
    expect(
      await reasonFor(
        COOKIE,
        SONG_URL,
        vi.fn().mockResolvedValue(new Response("{}", { status: 403 })) as never,
      ),
    ).toBe("rejected");
    expect(
      await reasonFor(
        COOKIE,
        SONG_URL,
        vi.fn().mockRejectedValue(new TypeError("fetch failed")) as never,
      ),
    ).toBe("unreachable");
    expect(
      await reasonFor(
        COOKIE,
        SONG_URL,
        vi.fn().mockRejectedValue(timeoutError()) as never,
      ),
    ).toBe("timed-out");
    expect(
      await reasonFor(
        COOKIE,
        SONG_URL,
        vi.fn().mockResolvedValue(new Response("{}", { status: 200 })) as never,
      ),
    ).toBe("malformed");
  });

  it("words a cold Song as still starting and a refusal as a refusal", () => {
    expect(songStudioToolsUnavailableNotice({ reason: "timed-out" })).toBe(
      "Song tools unavailable: Song Studio is still starting",
    );
    expect(
      songStudioToolsUnavailableNotice({ reason: "rejected", status: 401 }),
    ).toContain("HTTP 401");
  });
});

describe("song studio MCP warm-up", () => {
  it("mints, then sends the MCP initialize with the minted entry", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(mintedResponse())
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const result = await warmSongStudioMcp({
      readCookies: async () => COOKIE,
      songStudioUrl: SONG_URL,
      fetchImpl: fetchImpl as never,
    });
    expect(result).toEqual({ state: "warm" });
    const [url, init] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8100/song-studio/mcp");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${TOKEN}`,
    );
    expect(JSON.parse(init.body as string)).toMatchObject({
      method: "initialize",
    });
  });

  it("reports which step was cold", async () => {
    const coldMint = await warmSongStudioMcp({
      readCookies: async () => COOKIE,
      songStudioUrl: SONG_URL,
      fetchImpl: vi.fn().mockRejectedValue(timeoutError()) as never,
    });
    expect(coldMint).toEqual({
      state: "cold",
      stage: "mint",
      reason: "timed-out",
    });

    const coldInit = await warmSongStudioMcp({
      readCookies: async () => COOKIE,
      songStudioUrl: SONG_URL,
      fetchImpl: vi
        .fn()
        .mockResolvedValueOnce(mintedResponse())
        .mockResolvedValueOnce(new Response("{}", { status: 401 })) as never,
    });
    expect(coldInit).toEqual({
      state: "cold",
      stage: "initialize",
      reason: "rejected",
      status: 401,
    });
  });

  it("never sends the entry's credential to a non-local address", async () => {
    const remoteEntry = new Response(
      JSON.stringify({
        mcpServerEntry: {
          type: "http",
          url: "https://elsewhere.example/mcp",
          headers: { Authorization: `Bearer ${TOKEN}` },
        },
      }),
      { status: 200 },
    );
    const fetchImpl = vi.fn().mockResolvedValueOnce(remoteEntry);
    const result = await warmSongStudioMcp({
      readCookies: async () => COOKIE,
      songStudioUrl: SONG_URL,
      fetchImpl: fetchImpl as never,
    });
    expect(result).toMatchObject({ state: "cold", reason: "not-local" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("logs states only, never the token or the cookie", async () => {
    const log = vi.fn();
    await warmSongStudioMcp({
      readCookies: async () => COOKIE,
      songStudioUrl: SONG_URL,
      fetchImpl: vi
        .fn()
        .mockResolvedValueOnce(mintedResponse())
        .mockResolvedValueOnce(new Response("{}", { status: 200 })) as never,
      log,
    });
    await warmSongStudioMcp({
      readCookies: async () => COOKIE,
      songStudioUrl: SONG_URL,
      fetchImpl: vi
        .fn()
        .mockResolvedValueOnce(mintedResponse())
        .mockRejectedValueOnce(timeoutError()) as never,
      log,
    });
    await warmSongStudioMcp({
      readCookies: async () => COOKIE,
      songStudioUrl: SONG_URL,
      fetchImpl: vi.fn().mockRejectedValue(timeoutError()) as never,
      log,
    });
    expect(log).toHaveBeenCalled();
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain("cookie-secret");
  });
});

describe("song studio local session", () => {
  function setup(
    overrides: {
      signIn?: () => Promise<{ ok: boolean; reason?: string }>;
    } = {},
  ) {
    let clock = 1_000;
    const signIn = vi.fn(
      overrides.signIn ?? (async () => ({ ok: true as const })),
    );
    const warmUp = vi.fn(() => new Promise<void>(() => undefined));
    const log = vi.fn();
    const session = createSongStudioLocalSession({
      signIn: signIn as never,
      warmUp,
      now: () => clock,
      ttlMs: 600_000,
      log,
    });
    return {
      session,
      signIn,
      warmUp,
      log,
      advance: (ms: number) => (clock += ms),
    };
  }

  it("starts a background warm-up after a successful sign-in without waiting for it", async () => {
    const { session, warmUp } = setup();
    await session.ensure();
    expect(warmUp).toHaveBeenCalledTimes(1);
  });

  it("does not warm up when the sign-in failed", async () => {
    const { session, warmUp, log } = setup({
      signIn: async () => ({ ok: false, reason: "local sign-in answered 500" }),
    });
    await session.ensure();
    expect(warmUp).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("local sign-in not available", {
      reason: "local sign-in answered 500",
    });
  });

  it("warms up again after the next real sign-in, not on a cached one", async () => {
    const { session, signIn, warmUp, advance } = setup();
    warmUp.mockResolvedValue(undefined as never);
    await session.ensure();
    await session.ensure();
    expect(signIn).toHaveBeenCalledTimes(1);
    expect(warmUp).toHaveBeenCalledTimes(1);
    advance(600_001);
    await session.ensure();
    expect(signIn).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(warmUp).toHaveBeenCalledTimes(2));
    await session.ensure(true);
    await vi.waitFor(() => expect(warmUp).toHaveBeenCalledTimes(3));
  });

  it("does not start a second warm-up while one is still running", async () => {
    const { session, warmUp } = setup();
    await session.ensure();
    await session.ensure(true);
    expect(warmUp).toHaveBeenCalledTimes(1);
  });

  it("keeps a failing warm-up from failing the sign-in", async () => {
    const { session, warmUp, log } = setup();
    warmUp.mockRejectedValue(new Error(`boom ${TOKEN}`) as never);
    await expect(session.ensure()).resolves.toBeUndefined();
    await vi.waitFor(() =>
      expect(log).toHaveBeenCalledWith("warm-up: failed unexpectedly", {
        reason: "error",
      }),
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain(TOKEN);
  });
});

describe("song studio MCP entry answers", () => {
  it("maps a 200 that is not JSON to malformed, without a retry", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response("<html>starting</html>", { status: 200 }),
      );
    expect(
      await mintSongStudioMcpEntry(COOKIE, SONG_URL, fetchImpl as never),
    ).toEqual({ state: "unavailable", reason: "malformed", attempts: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("song studio readiness before a run", () => {
  // Every request below "takes" exactly as long as the timeout it was given.
  function slowSong() {
    let clock = 0;
    let lastTimeoutMs = 0;
    const timeouts: number[] = [];
    const fetchImpl = vi.fn(async () => {
      clock += lastTimeoutMs;
      throw timeoutError();
    });
    return {
      fetchImpl,
      timeouts,
      elapsed: () => clock,
      options: {
        now: () => clock,
        createTimeoutSignal: (ms: number) => {
          lastTimeoutMs = ms;
          timeouts.push(ms);
          return new AbortController().signal;
        },
      },
    };
  }

  it("gives up inside its budget however slow Song is, and says which step", async () => {
    expect(SONG_STUDIO_READY_BUDGET_MS).toBe(90_000);
    const song = slowSong();
    const result = await prepareSongStudioMcp({
      readCookies: async () => COOKIE,
      songStudioUrl: SONG_URL,
      fetchImpl: song.fetchImpl as never,
      options: song.options,
    });
    expect(result).toEqual({
      state: "unavailable",
      stage: "mint",
      reason: "timed-out",
    });
    expect(song.elapsed()).toBeLessThanOrEqual(90_000);
    expect(song.timeouts).toEqual([90_000]);
  });

  it("spends what the first attempt left on the retry and on the ping", async () => {
    let clock = 0;
    const timeouts: number[] = [];
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(async () => {
        clock += 50_000;
        throw timeoutError();
      })
      .mockImplementationOnce(async () => {
        clock += 20_000;
        return mintedResponse();
      })
      .mockImplementationOnce(async () => new Response("{}", { status: 200 }));
    const result = await prepareSongStudioMcp({
      readCookies: async () => COOKIE,
      songStudioUrl: SONG_URL,
      fetchImpl: fetchImpl as never,
      options: {
        now: () => clock,
        createTimeoutSignal: (ms: number) => {
          timeouts.push(ms);
          return new AbortController().signal;
        },
      },
    });
    expect(result).toEqual({ state: "ready", entry: MINTED_ENTRY });
    expect(timeouts).toEqual([90_000, 40_000, 20_000]);
  });

  it("is not ready when the MCP route does not answer in time", async () => {
    let clock = 0;
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(async () => mintedResponse())
      .mockImplementationOnce(async () => {
        clock += 90_000;
        throw timeoutError();
      });
    const result = await prepareSongStudioMcp({
      readCookies: async () => COOKIE,
      songStudioUrl: SONG_URL,
      fetchImpl: fetchImpl as never,
      options: { now: () => clock },
    });
    expect(result).toEqual({
      state: "unavailable",
      stage: "initialize",
      reason: "timed-out",
    });
  });

  it("does not ping when the mint used up the budget", async () => {
    let clock = 0;
    const fetchImpl = vi.fn().mockImplementationOnce(async () => {
      clock += 90_000;
      return mintedResponse();
    });
    const result = await prepareSongStudioMcp({
      readCookies: async () => COOKIE,
      songStudioUrl: SONG_URL,
      fetchImpl: fetchImpl as never,
      options: { now: () => clock },
    });
    expect(result).toMatchObject({ state: "unavailable", stage: "initialize" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("song studio readiness ping", () => {
  const prepare = (initializeAnswer: Response | Error) =>
    prepareSongStudioMcp({
      readCookies: async () => COOKIE,
      songStudioUrl: SONG_URL,
      fetchImpl: vi
        .fn()
        .mockResolvedValueOnce(mintedResponse())
        .mockImplementationOnce(async () => {
          if (initializeAnswer instanceof Error) throw initializeAnswer;
          return initializeAnswer;
        }) as never,
    });

  it("sends only the bearer: no Cookie, nothing but the three request headers", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(mintedResponse())
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    await prepareSongStudioMcp({
      readCookies: async () => COOKIE,
      songStudioUrl: SONG_URL,
      fetchImpl: fetchImpl as never,
    });
    const init = fetchImpl.mock.calls[1][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(Object.keys(headers).sort()).toEqual([
      "Accept",
      "Authorization",
      "Content-Type",
    ]);
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.stringify(init)).not.toContain("cookie-secret");
  });

  it("stays ready when the route answers something other than a refusal", async () => {
    for (const status of [406, 404, 500, 204]) {
      expect(
        await prepare(new Response(null, { status })),
        `status ${status}`,
      ).toEqual({ state: "ready", entry: MINTED_ENTRY });
    }
  });

  it("still leaves Song out on a 401, a 403 or a network failure", async () => {
    for (const status of [401, 403]) {
      expect(await prepare(new Response("{}", { status }))).toEqual({
        state: "unavailable",
        stage: "initialize",
        reason: "rejected",
        status,
      });
    }
    expect(await prepare(new TypeError("fetch failed"))).toEqual({
      state: "unavailable",
      stage: "initialize",
      reason: "unreachable",
    });
    expect(await prepare(timeoutError())).toEqual({
      state: "unavailable",
      stage: "initialize",
      reason: "timed-out",
    });
  });
});

describe("song studio re-sign-in on a refused mint", () => {
  const cookieOf = (call: unknown[]) =>
    ((call[1] as RequestInit).headers as Record<string, string>).Cookie;

  it("signs in again once and retries the mint with the new cookie", async () => {
    const refreshCookies = vi.fn(async () => "an_session=fresh");
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockResolvedValueOnce(mintedResponse());
    const result = await mintSongStudioMcpEntry(
      COOKIE,
      SONG_URL,
      fetchImpl as never,
      { refreshCookies },
    );
    expect(result).toEqual({ state: "minted", entry: MINTED_ENTRY });
    expect(refreshCookies).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls.map(cookieOf)).toEqual([
      COOKIE,
      "an_session=fresh",
    ]);
  });

  it("does it for a 403 too, but only once however often Song refuses", async () => {
    const refreshCookies = vi.fn(async () => "an_session=fresh");
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 403 }));
    const result = await mintSongStudioMcpEntry(
      COOKIE,
      SONG_URL,
      fetchImpl as never,
      { refreshCookies },
    );
    expect(result).toMatchObject({
      state: "unavailable",
      reason: "rejected",
      status: 403,
    });
    expect(refreshCookies).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not sign in again for any other refusal", async () => {
    const refreshCookies = vi.fn(async () => "an_session=fresh");
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 404 }));
    await mintSongStudioMcpEntry(COOKIE, SONG_URL, fetchImpl as never, {
      refreshCookies,
    });
    expect(refreshCookies).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("passes the re-sign-in through the readiness step", async () => {
    const refreshCookies = vi.fn(async () => "an_session=fresh");
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockResolvedValueOnce(mintedResponse())
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const result = await prepareSongStudioMcp({
      readCookies: async () => COOKIE,
      refreshCookies,
      songStudioUrl: SONG_URL,
      fetchImpl: fetchImpl as never,
    });
    expect(result.state).toBe("ready");
    expect(refreshCookies).toHaveBeenCalledTimes(1);
  });
});
