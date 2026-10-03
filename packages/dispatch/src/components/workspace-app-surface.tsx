import { agentNativePath } from "@agent-native/core/client/api-path";
import { useT } from "@agent-native/core/client/i18n";
import { IconAlertTriangle, IconArrowLeft } from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  buildWorkspaceAppChatFullViewPath,
  parseWorkspaceAppChatFullViewLocation,
  resolveWorkspaceAppChatThread,
  workspaceAppChatReturnRoute,
  type WorkspaceAppChatFullViewLocation,
  type WorkspaceAppChatHandoff,
} from "../lib/workspace-app-chat-handoff";
import { workspaceAppLocalPathFromRoute } from "../lib/workspace-apps";
import { workspaceAppChatProxyPath } from "../shared/workspace-app-chat";
import { Alert, AlertDescription } from "./ui/alert";
import { Button } from "./ui/button";
import { Skeleton } from "./ui/skeleton";
import {
  WorkspaceAppChatRail,
  WorkspaceAppKeepAlive,
  type WorkspaceAppHostExtensions,
} from "./workspace-app-host";

export interface WorkspaceAppSurfaceNavigateOptions {
  replace?: boolean;
}

export interface WorkspaceAppSurfaceProps {
  /** Dispatch-local location (base path already removed). */
  location: { pathname: string; search: string; hash: string };
  /** The `/apps/:appId` route's app, or null when no app route is active. */
  routeAppId: string | null;
  /** Native app registry, used for names and as the app access gate. */
  apps: readonly { id: string; name?: string }[];
  appsStatus: "loading" | "ready" | "error";
  appsErrorMessage: string;
  onRetryApps: () => void;
  extensions?: WorkspaceAppHostExtensions & {
    onAppChatFullView?: (handoff: Readonly<WorkspaceAppChatHandoff>) => void;
  };
  agentPageHref?: string;
  navigate: (
    path: string,
    options?: WorkspaceAppSurfaceNavigateOptions,
  ) => void;
}

type ThreadGate =
  | { status: "ready" }
  | { status: "pending" }
  | { status: "unavailable"; reason: "apps" | "app" | "thread" | "agent" };

function liveThreadKey(appId: string, threadId: string): string {
  return `${appId.toLowerCase()}\u0000${threadId}`;
}

/**
 * The single owner of a workspace app's frames and its chat controller.
 *
 * The rail and the keep-alive cache keep one tree shape on every Dispatch
 * route, so retained frames never reload and the rail's chat controller is
 * never remounted. App-chat full view is a presentation of that same live
 * controller, laid over whatever route content sits beneath it.
 */
export function WorkspaceAppSurface({
  location,
  routeAppId,
  apps,
  appsStatus,
  appsErrorMessage,
  onRetryApps,
  extensions,
  agentPageHref,
  navigate,
}: WorkspaceAppSurfaceProps) {
  const t = useT();
  // Hosts pass a fresh callback each render; the route binding handed to the
  // live chat controller must only change when the route does, or the
  // controller re-runs its URL effects on every render.
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const fullView: WorkspaceAppChatFullViewLocation = useMemo(
    () =>
      parseWorkspaceAppChatFullViewLocation(location.pathname, location.search),
    [location.pathname, location.search],
  );
  const handoff = fullView.kind === "app" ? fullView.handoff : null;
  const railAppId = handoff?.appId ?? routeAppId;
  const visible = Boolean(routeAppId) || Boolean(handoff);
  const registration = railAppId
    ? apps.find((app) => app.id.toLowerCase() === railAppId.toLowerCase())
    : undefined;
  const appName = registration?.name ?? railAppId ?? "";

  // Thread ids the live controller itself produced in this page session: the
  // one it handed off, and every one it wrote through its route binding. They
  // are trusted without a server round trip because the controller holds them
  // (including an unsaved draft). The set is memory-only, so a reload, a deep
  // link or another tab re-resolves through the app's own access check.
  const liveThreadIdsRef = useRef(new Set<string>());
  const childRoutesRef = useRef(new Map<string, string>());

  const handleChildRouteChange = useCallback((appId: string, route: string) => {
    const url = new URL(route, "https://agent-native.invalid");
    const localPath = workspaceAppLocalPathFromRoute(
      appId,
      url.pathname,
      url.search,
      url.hash,
    );
    if (localPath !== null) {
      childRoutesRef.current.set(appId.toLowerCase(), localPath);
    }
  }, []);

  const openFullView = useCallback(
    (threadId?: string) => {
      if (!routeAppId) return;
      const appId = routeAppId;
      const returnPath =
        childRoutesRef.current.get(appId.toLowerCase()) ??
        workspaceAppLocalPathFromRoute(
          appId,
          location.pathname,
          location.search,
          location.hash,
        ) ??
        "/";
      const entryThreadId = threadId?.trim() || undefined;
      const next: WorkspaceAppChatHandoff = {
        appId,
        ...(entryThreadId ? { threadId: entryThreadId } : {}),
        returnTarget: { appId, path: returnPath },
      };
      const target = buildWorkspaceAppChatFullViewPath(next);
      if (!target) {
        console.warn(
          `[dispatch] could not build app chat full view for ${appId}`,
        );
        return;
      }
      if (entryThreadId) {
        liveThreadIdsRef.current.add(liveThreadKey(appId, entryThreadId));
      }
      try {
        extensions?.onAppChatFullView?.(Object.freeze(next));
      } catch (cause) {
        console.warn("[dispatch] onAppChatFullView observer threw", cause);
      }
      navigateRef.current(target);
    },
    [extensions, location.hash, location.pathname, location.search, routeAppId],
  );

  const apiUrl = useMemo(
    () => agentNativePath(workspaceAppChatProxyPath(railAppId ?? "")),
    [railAppId],
  );
  const [resolutions, setResolutions] = useState(
    () => new Map<string, "found" | "not-found" | "unavailable">(),
  );
  const resolutionsRef = useRef(resolutions);
  resolutionsRef.current = resolutions;
  const [resolveAttempt, setResolveAttempt] = useState(0);
  const pendingThreadKey =
    handoff?.threadId &&
    !liveThreadIdsRef.current.has(
      liveThreadKey(handoff.appId, handoff.threadId),
    )
      ? liveThreadKey(handoff.appId, handoff.threadId)
      : null;

  const hasRegistration = Boolean(registration);
  useEffect(() => {
    if (!handoff?.threadId || !pendingThreadKey || !hasRegistration) return;
    if (resolutionsRef.current.has(pendingThreadKey)) return;
    let cancelled = false;
    const key = pendingThreadKey;
    void resolveWorkspaceAppChatThread(
      apiUrl,
      handoff.appId,
      handoff.threadId,
    ).then((result) => {
      if (cancelled) return;
      if (result.status === "unavailable") {
        console.warn(
          `[dispatch] could not resolve app chat thread for ${handoff.appId}`,
          result.error,
        );
      }
      setResolutions((current) => new Map(current).set(key, result.status));
    });
    return () => {
      cancelled = true;
    };
  }, [
    apiUrl,
    handoff?.appId,
    handoff?.threadId,
    hasRegistration,
    pendingThreadKey,
    resolveAttempt,
  ]);

  let gate: ThreadGate = { status: "ready" };
  if (handoff) {
    if (!registration) {
      gate =
        appsStatus === "ready"
          ? { status: "unavailable", reason: "app" }
          : appsStatus === "error"
            ? { status: "unavailable", reason: "apps" }
            : { status: "pending" };
    } else if (pendingThreadKey) {
      const result = resolutions.get(pendingThreadKey);
      gate =
        result === "found"
          ? { status: "ready" }
          : result === "not-found"
            ? { status: "unavailable", reason: "thread" }
            : result === "unavailable"
              ? { status: "unavailable", reason: "agent" }
              : { status: "pending" };
    }
  }
  const fullViewReady = Boolean(handoff) && gate.status === "ready";

  const threadUrlSync = useMemo(() => {
    if (!handoff || !fullViewReady) return undefined;
    return {
      routeThreadId: handoff.threadId ?? null,
      getPath: (threadId: string | null) =>
        buildWorkspaceAppChatFullViewPath({
          ...handoff,
          threadId: threadId ?? undefined,
        }) ?? `${location.pathname}${location.search}`,
      navigate: (path: string, options?: { replace?: boolean }) => {
        const written = parseWorkspaceAppChatFullViewLocation(
          path.split("?")[0] ?? path,
          path.includes("?") ? path.slice(path.indexOf("?")) : "",
        );
        if (written.kind === "app" && written.handoff.threadId) {
          liveThreadIdsRef.current.add(
            liveThreadKey(written.handoff.appId, written.handoff.threadId),
          );
        }
        navigateRef.current(path, options);
      },
    };
  }, [fullViewReady, handoff, location.pathname, location.search]);

  const returnRoute = handoff ? workspaceAppChatReturnRoute(handoff) : null;
  const initialPath =
    routeAppId && !handoff
      ? workspaceAppLocalPathFromRoute(
          routeAppId,
          location.pathname,
          location.search,
          location.hash,
        )
      : null;

  return (
    <div
      data-dispatch-workspace-app-surface
      data-dispatch-app-chat-full-view={
        handoff ? (gate.status === "ready" ? "ready" : gate.status) : undefined
      }
      className={
        visible
          ? "absolute inset-0 z-10 flex flex-col overflow-hidden bg-background"
          : "hidden"
      }
    >
      {handoff && returnRoute ? (
        <div className="flex shrink-0 items-center border-b px-3 py-1.5">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            data-dispatch-app-chat-back
            onClick={() => navigate(returnRoute)}
          >
            <IconArrowLeft size={15} className="mr-1.5" />
            {t("dispatch.pages.backToApp", { name: appName })}
          </Button>
        </div>
      ) : null}
      <div className="dispatch-workspace-app-surface-body relative min-h-0 flex-1">
        <div
          className="dispatch-workspace-app-surface-rail h-full min-h-0"
          inert={handoff && gate.status !== "ready" ? true : undefined}
        >
          <WorkspaceAppChatRail
            appId={railAppId ?? ""}
            appName={appName}
            enabled={Boolean(railAppId) && hasRegistration}
            presentation={handoff ? "full" : "sidebar"}
            threadUrlSync={threadUrlSync}
            agentPageHref={agentPageHref}
            onFullscreenRequest={openFullView}
          >
            <WorkspaceAppKeepAlive
              activeAppId={handoff ? null : routeAppId}
              activeInitialPath={
                initialPath && initialPath !== "/" ? initialPath : undefined
              }
              extensions={extensions}
              onChildRouteChange={handleChildRouteChange}
            />
          </WorkspaceAppChatRail>
        </div>
        {handoff && gate.status !== "ready" ? (
          <div
            data-dispatch-app-chat-unavailable-reason={
              gate.status === "unavailable" ? gate.reason : undefined
            }
            className="absolute inset-0 z-20 flex items-center justify-center bg-background p-6"
          >
            {gate.status === "pending" ? (
              <div className="w-full max-w-2xl space-y-3">
                <Skeleton className="mx-auto h-6 w-48" />
                <Skeleton className="mx-auto h-12 w-full" />
              </div>
            ) : (
              <Alert variant="destructive" className="max-w-2xl">
                <IconAlertTriangle className="size-4" />
                <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
                  <span>
                    {gate.reason === "apps"
                      ? appsErrorMessage
                      : gate.reason === "app"
                        ? t("dispatch.pages.appNotFound")
                        : gate.reason === "thread"
                          ? t("dispatch.pages.appChatThreadUnavailable", {
                              name: appName,
                            })
                          : t("dispatch.pages.appChatUnavailable", {
                              name: appName,
                            })}
                  </span>
                  {gate.reason === "agent" || gate.reason === "apps" ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        if (gate.reason === "apps") {
                          onRetryApps();
                          return;
                        }
                        if (pendingThreadKey) {
                          setResolutions((current) => {
                            const next = new Map(current);
                            next.delete(pendingThreadKey);
                            return next;
                          });
                        }
                        setResolveAttempt((value) => value + 1);
                      }}
                    >
                      {t("dispatch.pages.appChatRetry")}
                    </Button>
                  ) : null}
                </AlertDescription>
              </Alert>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
