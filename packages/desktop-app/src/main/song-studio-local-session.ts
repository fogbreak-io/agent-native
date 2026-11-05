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
        sameSite: cookie.sameSite === "no_restriction" ? "unspecified" : cookie.sameSite,
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

/**
 * Song Studio's MCP endpoint does not accept the browser session cookie; it
 * wants the connection entry its own "connect" route hands to a signed-in
 * user. This asks that route (with the local-dev cookie) for the entry the
 * Claude and Codex command-line tools should use. The entry carries a
 * credential, so callers must never log it.
 */
export async function mintSongStudioMcpEntry(
  cookieHeader: string,
  songStudioUrl: string = FOGBREAK_SONG_STUDIO_URL,
  fetchImpl: typeof fetch = fetch,
): Promise<SongStudioMcpEntry | null> {
  if (!isLoopbackSongStudioUrl(songStudioUrl) || !cookieHeader) return null;
  const base = new URL(songStudioUrl);
  const basePath = base.pathname.replace(/\/+$/, "");
  const target = `${base.origin}${basePath}/_agent-native/mcp/connect/token`;
  try {
    const response = await fetchImpl(target, {
      method: "POST",
      headers: {
        Origin: base.origin,
        "Content-Type": "application/json",
        Cookie: cookieHeader,
      },
      body: JSON.stringify({ label: "Fogbreak desktop", client: "fogbreak-desktop" }),
      signal: AbortSignal.timeout(6000),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as {
      mcpServerEntry?: { type?: string; url?: unknown; headers?: unknown };
    };
    const entry = payload.mcpServerEntry;
    if (!entry || entry.type !== "http" || typeof entry.url !== "string") {
      return null;
    }
    const headers: Record<string, string> = {};
    if (entry.headers && typeof entry.headers === "object") {
      for (const [key, value] of Object.entries(entry.headers)) {
        if (typeof value === "string") headers[key] = value;
      }
    }
    return {
      type: "http",
      url: entry.url,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    };
  } catch {
    return null;
  }
}
