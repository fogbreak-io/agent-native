import {
  normalizeWorkspaceAppLocalPath,
  workspaceAppRouteForLocalPath,
} from "./workspace-apps";

/**
 * Where full-view app chat returns to: the same workspace app at the exact
 * app-local route (path relative to the app mount, with search and hash) that
 * was showing when the handoff started. The route is the only location
 * Dispatch can see; anything finer (an app's own view, selection or draft)
 * stays with the app and survives because its keep-alive frame is retained.
 *
 * There is deliberately no `view` field: no public signal carries an app's
 * own view to Dispatch, so Native cannot restore or confirm one. The route
 * helpers encode only `appId` and `path`; any other property on an object
 * passed to them is not carried, and returning never reports a restored view.
 */
export interface WorkspaceAppChatReturnTarget {
  appId: string;
  path: string;
}

/**
 * A Dispatch-owned handoff from an app's chat rail to full view.
 *
 * `threadId` is the app agent's own thread id — the rail controller's active
 * thread under the app chat proxy, `dispatch-app-chat:<appId>` storage and the
 * `workspace-app:<appId>` scope — never a Dispatch global thread. It is absent
 * only for a new conversation. The handoff is not a grant: a thread that did
 * not come from the live controller is re-resolved through the app's own
 * access check before the controller is pointed at it.
 */
export interface WorkspaceAppChatHandoff {
  appId: string;
  threadId?: string;
  returnTarget: WorkspaceAppChatReturnTarget;
}

export type WorkspaceAppChatFullViewLocation =
  | { kind: "none" }
  | { kind: "app"; handoff: WorkspaceAppChatHandoff }
  | { kind: "invalid" };

const APP_PARAM = "appChat";
const RETURN_PARAM = "appReturn";

function chatPath(threadId: string | undefined): string {
  return threadId ? `/chat/${encodeURIComponent(threadId)}` : "/chat";
}

export function buildWorkspaceAppChatFullViewPath(
  handoff: WorkspaceAppChatHandoff,
): string | null {
  const appId = handoff.appId.trim();
  const returnPath = normalizeWorkspaceAppLocalPath(handoff.returnTarget.path);
  if (
    !appId ||
    returnPath === null ||
    handoff.returnTarget.appId.trim().toLowerCase() !== appId.toLowerCase()
  ) {
    return null;
  }
  const params = new URLSearchParams();
  params.set(APP_PARAM, appId);
  params.set(RETURN_PARAM, returnPath);
  return `${chatPath(handoff.threadId?.trim() || undefined)}?${params.toString()}`;
}

export function parseWorkspaceAppChatFullViewLocation(
  localPathname: string,
  search: string,
): WorkspaceAppChatFullViewLocation {
  const params = new URLSearchParams(search);
  if (!params.has(APP_PARAM)) return { kind: "none" };

  const appId = params.get(APP_PARAM)?.trim() ?? "";
  const returnPath = normalizeWorkspaceAppLocalPath(
    params.get(RETURN_PARAM) ?? "",
  );
  const match = localPathname.match(/^\/chat(?:\/([^/]+))?\/?$/);
  if (!appId || returnPath === null || !match) return { kind: "invalid" };

  let threadId: string | undefined;
  if (match[1]) {
    try {
      threadId = decodeURIComponent(match[1]).trim() || undefined;
    } catch {
      // coercion-ok: a malformed thread segment is reported as an invalid handoff, not a new chat.
      return { kind: "invalid" };
    }
    if (!threadId) return { kind: "invalid" };
  }

  return {
    kind: "app",
    handoff: {
      appId,
      ...(threadId ? { threadId } : {}),
      returnTarget: { appId, path: returnPath },
    },
  };
}

export function workspaceAppChatReturnRoute(
  handoff: WorkspaceAppChatHandoff,
): string | null {
  return workspaceAppRouteForLocalPath(
    handoff.returnTarget.appId,
    handoff.returnTarget.path,
  );
}

export type WorkspaceAppChatThreadResolution =
  | { status: "found" }
  | { status: "not-found" }
  | { status: "unavailable"; error: Error };

/**
 * Resolves an app-chat thread through the app chat proxy, so the app's own
 * access check decides. The app's agent chat answers a missing thread, one
 * the user cannot read, and one outside the requested scope with the same
 * 404, so `not-found` is an opaque denial: it never says which. Proxy session
 * and transport failures (401 sign-in, 502/503, upstream session expiry) are
 * `unavailable`, which is retryable and says nothing about the thread.
 */
export async function resolveWorkspaceAppChatThread(
  apiUrl: string,
  appId: string,
  threadId: string,
): Promise<WorkspaceAppChatThreadResolution> {
  const params = new URLSearchParams({
    scopeType: "workspace-app",
    scopeId: appId,
  });
  let response: Response;
  try {
    response = await fetch(
      `${apiUrl}/threads/${encodeURIComponent(threadId)}?${params.toString()}`,
      { credentials: "include" },
    );
  } catch (cause) {
    return {
      status: "unavailable",
      error: cause instanceof Error ? cause : new Error(String(cause)),
    };
  }
  if (response.status === 404) return { status: "not-found" };
  if (!response.ok) {
    return {
      status: "unavailable",
      error: new Error(`Agent chat proxy returned ${response.status}.`),
    };
  }
  let body: { id?: unknown };
  try {
    body = (await response.json()) as { id?: unknown };
  } catch (cause) {
    return {
      status: "unavailable",
      error: cause instanceof Error ? cause : new Error(String(cause)),
    };
  }
  if (body.id !== threadId) {
    return {
      status: "unavailable",
      error: new Error("Agent chat proxy returned a different thread."),
    };
  }
  return { status: "found" };
}
