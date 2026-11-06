import type { Session } from "electron";

import { FOGBREAK_SONG_STUDIO_URL } from "../../shared/fogbreak.js";

/**
 * Song Studio runs on this computer, so the desktop signs the owner in with the
 * app's own loopback-only "Continue as local dev" route. No account, password or
 * fogbreak.io login is involved, and nothing here is sent off the machine.
 */
export interface ParsedSetCookie {
  name: string;
  value: string;
  path: string;
  httpOnly: boolean;
  secure: boolean;
  expirationDate?: number;
  sameSite: "unspecified" | "no_restriction" | "lax" | "strict";
}

export function isLoopbackSongStudioUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" ||
        url.hostname === "localhost" ||
        url.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

export function parseSetCookie(
  header: string,
  now = Date.now(),
): ParsedSetCookie | null {
  const parts = header.split(";").map((part) => part.trim());
  const [pair, ...attrs] = parts;
  const eq = pair?.indexOf("=") ?? -1;
  if (!pair || eq <= 0) return null;
  const cookie: ParsedSetCookie = {
    name: pair.slice(0, eq),
    value: pair.slice(eq + 1),
    path: "/",
    httpOnly: false,
    secure: false,
    sameSite: "unspecified",
  };
  for (const attr of attrs) {
    const [rawKey, ...rest] = attr.split("=");
    const key = (rawKey ?? "").toLowerCase();
    const value = rest.join("=");
    if (key === "path" && value) cookie.path = value;
    else if (key === "httponly") cookie.httpOnly = true;
    else if (key === "secure") cookie.secure = true;
    else if (key === "max-age" && Number.isFinite(Number(value))) {
      cookie.expirationDate = (now + Number(value) * 1000) / 1000;
    } else if (key === "expires" && cookie.expirationDate === undefined) {
      const at = Date.parse(value);
      if (Number.isFinite(at)) cookie.expirationDate = at / 1000;
    } else if (key === "samesite") {
      const lower = value.toLowerCase();
      if (lower === "lax" || lower === "strict") cookie.sameSite = lower;
      else if (lower === "none") cookie.sameSite = "no_restriction";
    }
  }
  return cookie;
}

export type SongStudioLocalSignInResult =
  | { ok: true }
  | { ok: false; reason: string };

/** Signs the given app session into the local Song Studio. Never logs cookie values. */
export async function signInSongStudioLocally(
  ses: Pick<Session, "cookies">,
  songStudioUrl: string = FOGBREAK_SONG_STUDIO_URL,
  fetchImpl: typeof fetch = fetch,
): Promise<SongStudioLocalSignInResult> {
  if (!isLoopbackSongStudioUrl(songStudioUrl)) {
    return { ok: false, reason: "Song Studio is not a local address." };
  }
  const base = new URL(songStudioUrl);
  const basePath = base.pathname.replace(/\/+$/, "");
  const target = `${base.origin}${basePath}/_agent-native/auth/local-dev`;
  try {
    const response = await fetchImpl(target, {
      method: "POST",
      headers: { Origin: base.origin, "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) {
      return { ok: false, reason: `local sign-in answered ${response.status}` };
    }
    const headers = response.headers.getSetCookie?.() ?? [];
    let stored = 0;
    for (const header of headers) {
      const cookie = parseSetCookie(header);
      if (!cookie) continue;
      await ses.cookies.set({
        url: base.origin,
        name: cookie.name,
        value: cookie.value,
        path: cookie.path,
        httpOnly: cookie.httpOnly,
        secure: false,
        sameSite:
          cookie.sameSite === "no_restriction"
            ? "unspecified"
            : cookie.sameSite,
        ...(cookie.expirationDate !== undefined
          ? { expirationDate: cookie.expirationDate }
          : {}),
      });
      stored += 1;
    }
    return stored > 0
      ? { ok: true }
      : { ok: false, reason: "local sign-in set no session" };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "unknown error",
    };
  }
}

export interface SongStudioMcpEntry {
  type: "http";
  url: string;
  headers?: Record<string, string>;
}

/** Song's dev server compiles the connect route on first use; a cold hit took 54 s. */
export const SONG_STUDIO_MINT_TIMEOUT_MS = 90_000;
export const SONG_STUDIO_MINT_MAX_ATTEMPTS = 2;

export type SongStudioMcpUnavailableReason =
  | "not-local"
  | "no-session"
  | "timed-out"
  | "unreachable"
  | "rejected"
  | "malformed";

/**
 * Absent (no local sign-in), timed out, unreachable, refused and unreadable are
 * different facts and callers word them differently; none is a bare null.
 */
export type SongStudioMcpMintResult =
  | { state: "minted"; entry: SongStudioMcpEntry }
  | {
      state: "unavailable";
      reason: SongStudioMcpUnavailableReason;
      attempts: number;
      status?: number;
    };

export interface SongStudioMintOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  createTimeoutSignal?: (ms: number) => AbortSignal;
}

type MintAttempt =
  | { state: "minted"; entry: SongStudioMcpEntry }
  | {
      state: "unavailable";
      reason: SongStudioMcpUnavailableReason;
      status?: number;
      retryable: boolean;
    };

function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

async function mintOnce(
  target: string,
  origin: string,
  cookieHeader: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<MintAttempt> {
  try {
    const response = await fetchImpl(target, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        Cookie: cookieHeader,
      },
      body: JSON.stringify({
        label: "Fogbreak desktop",
        client: "fogbreak-desktop",
      }),
      signal,
    });
    if (!response.ok) {
      return {
        state: "unavailable",
        reason: "rejected",
        status: response.status,
        retryable: response.status >= 500,
      };
    }
    const payload = (await response.json()) as {
      mcpServerEntry?: { type?: string; url?: unknown; headers?: unknown };
    };
    const entry = payload.mcpServerEntry;
    if (!entry || entry.type !== "http" || typeof entry.url !== "string") {
      return { state: "unavailable", reason: "malformed", retryable: false };
    }
    const headers: Record<string, string> = {};
    if (entry.headers && typeof entry.headers === "object") {
      for (const [key, value] of Object.entries(entry.headers)) {
        if (typeof value === "string") headers[key] = value;
      }
    }
    return {
      state: "minted",
      entry: {
        type: "http",
        url: entry.url,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      },
    };
  } catch (error) {
    return {
      state: "unavailable",
      reason: isTimeoutError(error) ? "timed-out" : "unreachable",
      retryable: true,
    };
  }
}

/**
 * Song Studio's MCP endpoint does not accept the browser session cookie; it
 * wants the connection entry its own "connect" route hands to a signed-in
 * user. This asks that route (with the local-dev cookie) for the entry the
 * Claude and Codex command-line tools should use. The entry carries a
 * credential, so callers must never log it. A timeout, a refused connection or
 * a 5xx is retried once; a 4xx or an unreadable answer is not.
 */
export async function mintSongStudioMcpEntry(
  cookieHeader: string,
  songStudioUrl: string = FOGBREAK_SONG_STUDIO_URL,
  fetchImpl: typeof fetch = fetch,
  options: SongStudioMintOptions = {},
): Promise<SongStudioMcpMintResult> {
  if (!isLoopbackSongStudioUrl(songStudioUrl)) {
    return { state: "unavailable", reason: "not-local", attempts: 0 };
  }
  if (!cookieHeader) {
    return { state: "unavailable", reason: "no-session", attempts: 0 };
  }
  const timeoutMs = options.timeoutMs ?? SONG_STUDIO_MINT_TIMEOUT_MS;
  const maxAttempts = options.maxAttempts ?? SONG_STUDIO_MINT_MAX_ATTEMPTS;
  const createTimeoutSignal =
    options.createTimeoutSignal ?? ((ms: number) => AbortSignal.timeout(ms));
  const base = new URL(songStudioUrl);
  const basePath = base.pathname.replace(/\/+$/, "");
  const target = `${base.origin}${basePath}/_agent-native/mcp/connect/token`;

  let attempts = 0;
  for (;;) {
    attempts += 1;
    const attempt = await mintOnce(
      target,
      base.origin,
      cookieHeader,
      fetchImpl,
      createTimeoutSignal(timeoutMs),
    );
    if (attempt.state === "minted") {
      return { state: "minted", entry: attempt.entry };
    }
    if (!attempt.retryable || attempts >= maxAttempts) {
      return {
        state: "unavailable",
        reason: attempt.reason,
        attempts,
        ...(attempt.status !== undefined ? { status: attempt.status } : {}),
      };
    }
  }
}

/** The plain status line a run shows when Song's tools were left out of it. */
export function songStudioToolsUnavailableNotice(
  result: Extract<SongStudioMcpMintResult, { state: "unavailable" }>,
): string {
  switch (result.reason) {
    case "timed-out":
    case "unreachable":
      return "Song tools unavailable: Song Studio is still starting";
    case "no-session":
      return "Song tools unavailable: Song Studio has not signed this computer in yet";
    case "rejected":
      return `Song tools unavailable: Song Studio refused the connection request (HTTP ${result.status ?? "unknown"})`;
    case "malformed":
      return "Song tools unavailable: Song Studio sent a connection entry this app could not read";
    case "not-local":
      return "Song tools unavailable: Song Studio is not a local address";
  }
}

export type SongStudioLog = (
  message: string,
  fields?: Record<string, string | number>,
) => void;

export type SongStudioWarmUpResult =
  | { state: "warm" }
  | {
      state: "cold";
      stage: "mint" | "initialize";
      reason: SongStudioMcpUnavailableReason;
      status?: number;
    };

export interface SongStudioWarmUpDeps {
  readCookies: () => Promise<string>;
  songStudioUrl?: string;
  fetchImpl?: typeof fetch;
  log?: SongStudioLog;
  options?: SongStudioMintOptions;
}

/**
 * Pays Song's cold-route compile cost before a chat needs it: mint a connection
 * entry, then send the MCP `initialize` the CLIs send. Logs states only; the
 * minted entry and the cookie never leave this function.
 */
export async function warmSongStudioMcp(
  deps: SongStudioWarmUpDeps,
): Promise<SongStudioWarmUpResult> {
  const songStudioUrl = deps.songStudioUrl ?? FOGBREAK_SONG_STUDIO_URL;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const log = deps.log ?? (() => undefined);
  const timeoutMs = deps.options?.timeoutMs ?? SONG_STUDIO_MINT_TIMEOUT_MS;
  const createTimeoutSignal =
    deps.options?.createTimeoutSignal ??
    ((ms: number) => AbortSignal.timeout(ms));

  const minted = await mintSongStudioMcpEntry(
    await deps.readCookies(),
    songStudioUrl,
    fetchImpl,
    deps.options,
  );
  if (minted.state !== "minted") {
    log("warm-up: connection entry not minted", {
      reason: minted.reason,
      attempts: minted.attempts,
    });
    return {
      state: "cold",
      stage: "mint",
      reason: minted.reason,
      ...(minted.status !== undefined ? { status: minted.status } : {}),
    };
  }
  // The entry's credential only goes to a local address.
  if (!isLoopbackSongStudioUrl(minted.entry.url)) {
    log("warm-up: MCP address is not local", { reason: "not-local" });
    return { state: "cold", stage: "initialize", reason: "not-local" };
  }
  try {
    const response = await fetchImpl(minted.entry.url, {
      method: "POST",
      headers: {
        ...(minted.entry.headers ?? {}),
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "fogbreak-desktop-warmup", version: "1" },
        },
      }),
      signal: createTimeoutSignal(timeoutMs),
    });
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok) {
      log("warm-up: MCP initialize refused", {
        reason: "rejected",
        status: response.status,
      });
      return {
        state: "cold",
        stage: "initialize",
        reason: "rejected",
        status: response.status,
      };
    }
    log("warm-up: Song Studio MCP is warm");
    return { state: "warm" };
  } catch (error) {
    const reason = isTimeoutError(error) ? "timed-out" : "unreachable";
    log("warm-up: MCP initialize did not answer", { reason });
    return { state: "cold", stage: "initialize", reason };
  }
}

export interface SongStudioLocalSessionDeps {
  signIn: () => Promise<SongStudioLocalSignInResult>;
  /** Started in the background after every successful sign-in; never awaited. */
  warmUp: () => Promise<unknown>;
  now?: () => number;
  ttlMs?: number;
  log?: SongStudioLog;
}

export const SONG_STUDIO_LOCAL_SIGN_IN_TTL_MS = 10 * 60 * 1000;

/**
 * Keeps the desktop signed in to the local Song Studio. Each sign-in that
 * actually happens also starts one background warm-up of Song's MCP route.
 */
export function createSongStudioLocalSession(
  deps: SongStudioLocalSessionDeps,
): {
  ensure: (force?: boolean) => Promise<void>;
} {
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? SONG_STUDIO_LOCAL_SIGN_IN_TTL_MS;
  const log = deps.log ?? (() => undefined);
  let signedInAt = 0;
  let signInPending: Promise<void> | null = null;
  let warmUpPending: Promise<unknown> | null = null;

  const startWarmUp = (): void => {
    if (warmUpPending) return;
    warmUpPending = Promise.resolve()
      .then(() => deps.warmUp())
      .catch(() => log("warm-up: failed unexpectedly", { reason: "error" }))
      .finally(() => {
        warmUpPending = null;
      });
  };

  const ensure = (force = false): Promise<void> => {
    if (!force && signedInAt && now() - signedInAt < ttlMs) {
      return Promise.resolve();
    }
    if (signInPending) return signInPending;
    signInPending = deps
      .signIn()
      .then((result) => {
        if (result.ok) {
          signedInAt = now();
          log("signed in with the local identity");
          startWarmUp();
        } else {
          log("local sign-in not available", { reason: result.reason });
        }
      })
      .finally(() => {
        signInPending = null;
      });
    return signInPending;
  };

  return { ensure };
}
