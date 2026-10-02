import { useFeatureFlag } from "@agent-native/core/client/feature-flags";
import {
  useActionMutation,
  useActionQuery,
} from "@agent-native/core/client/hooks";
import { useT } from "@agent-native/core/client/i18n";
import { AGENT_NATIVE_WORKSPACE_APP_ROUTE_MESSAGE_TYPE } from "@agent-native/core/client/navigation";
import {
  buildEmbeddedThemeUpdate,
  parseEmbeddedThemeUpdate,
  type EmbeddedThemeUpdate,
  type ResolvedTheme,
} from "@agent-native/core/client/theme";
import { withBuilderUtmTrackingParams } from "@agent-native/core/shared/builder-link-tracking";
import { AgentSidebar } from "@agent-native/toolkit/app/chat/AgentSidebar";
import { defaultChatFirstCopy } from "@agent-native/toolkit/app/chat/chat-first-copy";
import type { ChatFirstCopy } from "@agent-native/toolkit/app/chat/chat-first/types";
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconClockHour4,
} from "@tabler/icons-react";
import { useTheme } from "next-themes";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Link } from "react-router";

import { isEmbedSessionExpiredMessage } from "../lib/embed-session-recovery";
import {
  isWorkspaceSsoApp,
  isDispatchWorkspaceAppId,
  navigateToWorkspaceApp,
  shouldOpenWorkspaceAppInTopWindow,
  normalizeWorkspaceAppLocalPath,
  workspaceAppDirectHref,
  workspaceAppHref,
  workspaceAppLocalPathForChildPath,
  workspaceAppRouteForLocalPath,
  workspaceAppTargetPath,
  type WorkspaceAppSummary,
} from "../lib/workspace-apps";
import { DISPATCH_WORKSPACE_SSO_FLAG } from "../shared/feature-flags";
import { ActionQueryError } from "./action-query-error";
import { ChatFirstAppPane } from "./deferred-chat-components.js";
import { Alert, AlertDescription } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Skeleton } from "./ui/skeleton";
import { useWorkspaceAppChatApi } from "./workspace-app-chat-api";

const EMBED_SESSION_TIMEOUT_MS = 100_000;
/**
 * How long a rendered iframe may go without a browser `load` event before
 * Native reports `frame-load-failed` / `timeout` for that frame instance. The
 * report is terminal for the attempt: Native does not retry or reset anything.
 */
export const WORKSPACE_APP_FRAME_LOAD_TIMEOUT_MS = 60_000;

interface EmbedSessionResult {
  startUrl: string;
}

interface EmbedSessionInput {
  app?: string;
  path?: string;
  url?: string;
  chrome: "minimal";
}

/**
 * Identity of one workspace app iframe as Native owns it. Consumers receive it
 * as metadata only; it never carries the iframe, its window, or a post API.
 */
export interface WorkspaceAppFrameIdentity {
  /** Native registry id of the app. */
  appId: string;
  /** Changes when the iframe element is replaced; stable across keep-alive. */
  frameInstanceId: string;
  /** Number of browser `load` events this frame instance has seen. */
  loadRevision: number;
  /** Whether this frame is the visible keep-alive entry. */
  active: boolean;
  /** Latest app-local route Native accepted from this frame's trusted route messages. */
  path: string;
  /**
   * Origin Native validated from the embed target, or `null` when the target
   * has no http(s) origin. Personalized theme vars are only posted to it.
   */
  targetOrigin: string | null;
}

/**
 * Optional per-frame theme composition. `resolveThemeUpdate` must be pure and
 * synchronous; Native calls it on frame load and whenever `revision`, the
 * resolved light/dark mode, the frame's active state, or its route changes,
 * and delivers the result through its single ordered post path.
 *
 * Return the complete current update (mode plus the full personalized
 * variable set) or `null` when that baseline is unavailable. `null` is not a
 * reset: Native posts only the light/dark mode and leaves previously applied
 * variables in the child untouched until a later revision supplies a complete
 * update.
 *
 * Migration: a host that today broadcasts semantic theme tokens to workspace
 * app frames itself, or replays them on frame load, must retire that frame
 * delivery in the same change that adopts this extension; Native is then the
 * only sender of theme messages to these frames. The host keeps owning its
 * theme state and its own document's theming.
 */
export interface WorkspaceAppThemeExtension {
  revision: string | number;
  resolveThemeUpdate(input: {
    identity: Readonly<WorkspaceAppFrameIdentity>;
    theme: ResolvedTheme;
  }): EmbeddedThemeUpdate | null;
}

export type WorkspaceAppFrameLifecyclePhase =
  | "frame-loaded"
  | "frame-load-failed"
  | "active-change"
  | "route-change"
  | "disposed";

/**
 * Only failures Native itself observes. A child page that loads and then
 * refuses or errors is indistinguishable from success at the parent, so it is
 * reported as `frame-loaded`, never as a failure Native cannot see.
 */
export type WorkspaceAppFrameFailure = "refused" | "load-error" | "timeout";

/**
 * What Native posted for a theme delivery. `complete` means a validated
 * resolver update was posted to the frame's origin; `baseline-unavailable`
 * means the resolver returned `null`; `rejected` means the resolver threw,
 * returned data that failed the public theme message contract or disagreed
 * with the resolved mode, or the frame had no validated origin. The last two
 * post the mode only.
 */
export type WorkspaceAppThemeDelivery =
  | "complete"
  | "baseline-unavailable"
  | "rejected";

/**
 * Observation of Native's frame lifecycle. `frame-loaded` means only that the
 * browser fired the iframe `load` event and Native ran its theme handling; it
 * is not child readiness, authenticated access, or navigation success.
 * Consumers must ignore events whose `frameInstanceId`/`loadRevision` are
 * older than ones they have already seen.
 */
export interface WorkspaceAppFrameLifecycleEvent {
  phase: WorkspaceAppFrameLifecyclePhase;
  identity: Readonly<WorkspaceAppFrameIdentity>;
  failure?: WorkspaceAppFrameFailure;
  themeDelivery?: WorkspaceAppThemeDelivery;
}

/**
 * Additive workspace app host extension, threaded from
 * `DispatchExtensionConfig.workspaceApps` through Layout, the keep-alive
 * cache and each host to its frame. Native keeps sole ownership of frame
 * identity, origin validation, posting, keep-alive and teardown; callbacks
 * observe and must not post, navigate, or replace frames.
 */
export interface WorkspaceAppHostExtensions {
  theme?: WorkspaceAppThemeExtension;
  onFrameLifecycle?: (event: WorkspaceAppFrameLifecycleEvent) => void;
}

interface ResolvedFrameThemeMessage {
  message: EmbeddedThemeUpdate;
  targetOrigin: string;
  delivery?: WorkspaceAppThemeDelivery;
}

function resolveFrameThemeMessage(
  extension: WorkspaceAppThemeExtension | undefined,
  identity: WorkspaceAppFrameIdentity,
  theme: ResolvedTheme,
): ResolvedFrameThemeMessage {
  const modeOnly = buildEmbeddedThemeUpdate(theme);
  if (!extension) return { message: modeOnly, targetOrigin: "*" };

  let resolved: EmbeddedThemeUpdate | null;
  try {
    resolved = extension.resolveThemeUpdate({
      identity: Object.freeze({ ...identity }),
      theme,
    });
  } catch (cause) {
    console.warn(
      `[dispatch] workspace app theme resolver threw for ${identity.appId}`,
      cause,
    );
    return { message: modeOnly, targetOrigin: "*", delivery: "rejected" };
  }
  if (resolved === null) {
    return {
      message: modeOnly,
      targetOrigin: "*",
      delivery: "baseline-unavailable",
    };
  }

  const parsed = parseEmbeddedThemeUpdate(resolved);
  const suppliedVarCount =
    resolved && typeof resolved.vars === "object" && resolved.vars
      ? Object.keys(resolved.vars).length
      : 0;
  const acceptedVarCount = Object.keys(parsed?.vars ?? {}).length;
  if (
    !parsed ||
    parsed.theme !== theme ||
    acceptedVarCount !== suppliedVarCount ||
    !identity.targetOrigin
  ) {
    console.warn(
      `[dispatch] rejected workspace app theme update for ${identity.appId}`,
    );
    return { message: modeOnly, targetOrigin: "*", delivery: "rejected" };
  }
  return {
    message: buildEmbeddedThemeUpdate(theme, parsed.vars),
    targetOrigin: identity.targetOrigin,
    delivery: "complete",
  };
}

function validatedFrameOrigin(embedUrl: string | null): string | null {
  if (!embedUrl || typeof window === "undefined") return null;
  try {
    const url = new URL(embedUrl, window.location.href);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.origin
      : null;
  } catch {
    // coercion-ok: an unparseable embed target has no origin to deliver personalized vars to.
    return null;
  }
}

function frameFailureForError(error: unknown): WorkspaceAppFrameFailure {
  const status = (error as { status?: unknown } | null)?.status;
  if (status === 401 || status === 403) return "refused";
  if (status === 408) return "timeout";
  return "load-error";
}

let nextWorkspaceAppFrameMountId = 0;

export function buildChatFirstEmbedSessionInput(
  appId: string,
  path: string,
): EmbedSessionInput {
  return { app: appId, path, chrome: "minimal" };
}

export interface WorkspaceAppChatRailProps {
  appId: string;
  appName: string;
  children: ReactNode;
  copy?: ChatFirstCopy;
  agentPageHref?: string;
  /**
   * Receives the rail's active thread id when the user asks for full view: a
   * thread on the app's own agent (through the app chat proxy), or the id of
   * an unsaved draft there. It is never a Dispatch global thread.
   */
  onFullscreenRequest?: (threadId?: string) => void;
  /**
   * When false the rail mounts no chat controller and shows only `children`,
   * keeping the children's DOM parent stable so retained frames never reload.
   */
  enabled?: boolean;
}

export function WorkspaceAppChatRail({
  appId,
  appName,
  children,
  copy = defaultChatFirstCopy,
  agentPageHref,
  onFullscreenRequest,
  enabled = true,
}: WorkspaceAppChatRailProps) {
  const t = useT();
  const appChat = useWorkspaceAppChatApi(appId, enabled);

  // Children keep one DOM parent whether the rail is enabled, disabled, or
  // unavailable: re-parenting an iframe reloads it and drops keep-alive state.
  return (
    <AgentSidebar
      enabled={enabled && !appChat.unavailable}
      suppressFirstRunOnboarding={!enabled || appChat.unavailable}
      position="left"
      defaultOpen
      openStorageKey="dispatch-app-chat"
      storageKey={`dispatch-app-chat:${appId}`}
      scope={{
        type: "workspace-app",
        id: appId,
        label: appName,
        contextKey: `workspace-app:${appId}`,
      }}
      isolateHistoryByScope
      apiUrl={appChat.apiUrl}
      agentChatSurface="app"
      showTabBar
      suppressInlineOpenApp
      dynamicSuggestions={false}
      suggestions={[]}
      emptyStateText={`Ask about ${appName}`}
      {...(agentPageHref ? { agentPageHref } : {})}
      {...(onFullscreenRequest ? { onFullscreenRequest } : {})}
    >
      <div className="flex h-full min-h-0">
        {appChat.unavailable ? (
          <div
            data-dispatch-app-chat-unavailable
            className="w-88 shrink-0 overflow-auto border-r p-4"
          >
            <Alert variant="destructive">
              <IconAlertTriangle className="size-4" />
              <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
                <span>
                  {t("dispatch.pages.appChatUnavailable", {
                    defaultValue:
                      "Dispatch could not connect to {{name}}'s agent, so its chat is unavailable here.",
                    name: appName,
                  })}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={appChat.retry}
                >
                  {copy("retry")}
                </Button>
              </AlertDescription>
            </Alert>
          </div>
        ) : null}
        <div className="relative min-w-0 flex-1">{children}</div>
      </div>
    </AgentSidebar>
  );
}

export interface WorkspaceAppFrameApp {
  id: string;
  name: string;
  path?: string | null;
  homePath?: string | null;
  url?: string | null;
  isDispatch?: boolean;
}

export interface WorkspaceAppFrameProps {
  app: WorkspaceAppFrameApp;
  navigateToTopWindow?: (href: string) => boolean | void;
  embedPath?: string;
  initialPath?: string;
  onChildRouteChange?: (path: string) => void;
  chatSidebar?: boolean;
  copy?: ChatFirstCopy;
  /** Whether this frame is the visible one; keep-alive passes false when hidden. */
  active?: boolean;
  extensions?: WorkspaceAppHostExtensions;
}

export function WorkspaceAppFrame({
  app,
  navigateToTopWindow = navigateToWorkspaceApp,
  embedPath,
  initialPath,
  onChildRouteChange,
  chatSidebar = false,
  copy = defaultChatFirstCopy,
  active = true,
  extensions,
}: WorkspaceAppFrameProps) {
  const { resolvedTheme } = useTheme();
  const theme: ResolvedTheme =
    resolvedTheme === "dark" || resolvedTheme === "light"
      ? resolvedTheme
      : typeof document !== "undefined" &&
          document.documentElement.classList.contains("dark")
        ? "dark"
        : "light";
  const [embedUrl, setEmbedUrl] = useState<string | null>(null);
  const [embedError, setEmbedError] = useState<Error | null>(null);
  const [isDirectFallback, setIsDirectFallback] = useState(false);
  const [embedAttempt, setEmbedAttempt] = useState(0);
  const [topWindowNavigationFailed, setTopWindowNavigationFailed] =
    useState(false);
  const embedFrameRef = useRef<HTMLIFrameElement>(null);
  const extensionsRef = useRef(extensions);
  extensionsRef.current = extensions;
  const themeRevision = extensions?.theme?.revision;
  const [frameMountId] = useState(() => ++nextWorkspaceAppFrameMountId);
  const [childPath, setChildPath] = useState(
    () =>
      normalizeWorkspaceAppLocalPath(
        initialPath ?? embedPath ?? workspaceAppTargetPath(app),
      ) ?? "/",
  );
  const iframeKey = embedUrl ? `${embedUrl}:${embedAttempt}` : null;
  const frameGenerationRef = useRef<{ key: string | null; value: number }>({
    key: null,
    value: 0,
  });
  if (iframeKey !== frameGenerationRef.current.key) {
    frameGenerationRef.current = {
      key: iframeKey,
      value: frameGenerationRef.current.value + 1,
    };
  }
  const frameGeneration = frameGenerationRef.current.value;
  const loadRevisionRef = useRef({ generation: frameGeneration, value: 0 });
  if (loadRevisionRef.current.generation !== frameGeneration) {
    loadRevisionRef.current = { generation: frameGeneration, value: 0 };
  }
  const identityRef = useRef<WorkspaceAppFrameIdentity | null>(null);
  identityRef.current = {
    appId: app.id,
    frameInstanceId: `${frameMountId}.${frameGeneration}`,
    loadRevision: loadRevisionRef.current.value,
    active,
    path: childPath,
    targetOrigin: validatedFrameOrigin(embedUrl),
  };
  const committedIdentityRef = useRef<WorkspaceAppFrameIdentity | null>(null);
  useEffect(() => {
    committedIdentityRef.current = identityRef.current;
  });
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const emitLifecycle = useCallback(
    (
      phase: WorkspaceAppFrameLifecyclePhase,
      detail: Pick<
        WorkspaceAppFrameLifecycleEvent,
        "failure" | "themeDelivery"
      > & { identity?: WorkspaceAppFrameIdentity } = {},
    ) => {
      const observe = extensionsRef.current?.onFrameLifecycle;
      const identity = detail.identity ?? identityRef.current;
      if (!observe || !identity) return;
      try {
        observe({
          phase,
          identity: Object.freeze({ ...identity }),
          ...(detail.failure ? { failure: detail.failure } : {}),
          ...(detail.themeDelivery
            ? { themeDelivery: detail.themeDelivery }
            : {}),
        });
      } catch (cause) {
        console.warn(
          `[dispatch] workspace app lifecycle observer threw for ${identity.appId}`,
          cause,
        );
      }
    },
    [],
  );
  // The single path that posts theme messages to this frame.
  const deliverThemeToFrame = useCallback(():
    | WorkspaceAppThemeDelivery
    | undefined => {
    const frameWindow = embedFrameRef.current?.contentWindow;
    const identity = identityRef.current;
    if (!frameWindow || !identity) return undefined;
    const resolved = resolveFrameThemeMessage(
      extensionsRef.current?.theme,
      identity,
      themeRef.current,
    );
    frameWindow.postMessage(resolved.message, resolved.targetOrigin);
    return resolved.delivery;
  }, []);
  const handleFrameLoad = useCallback(() => {
    loadRevisionRef.current = {
      generation: loadRevisionRef.current.generation,
      value: loadRevisionRef.current.value + 1,
    };
    if (identityRef.current) {
      identityRef.current = {
        ...identityRef.current,
        loadRevision: loadRevisionRef.current.value,
      };
      committedIdentityRef.current = identityRef.current;
    }
    const themeDelivery = deliverThemeToFrame();
    if (isDirectFallback) setEmbedError(null);
    emitLifecycle("frame-loaded", themeDelivery ? { themeDelivery } : {});
  }, [deliverThemeToFrame, emitLifecycle, isDirectFallback]);
  const workspaceSsoEnabled = useFeatureFlag(DISPATCH_WORKSPACE_SSO_FLAG.key);
  const useWorkspaceSso = workspaceSsoEnabled && isWorkspaceSsoApp(app);
  const createEmbedSession = useActionMutation<
    EmbedSessionResult,
    EmbedSessionInput
  >("create_embed_session", {
    skipActionQueryInvalidation: true,
    timeoutMs: EMBED_SESSION_TIMEOUT_MS,
  });
  const createWorkspaceSsoEmbedSession = useActionMutation<
    EmbedSessionResult,
    EmbedSessionInput
  >("create-workspace-app-embed-session", {
    skipActionQueryInvalidation: true,
    timeoutMs: EMBED_SESSION_TIMEOUT_MS,
  });
  const appHref = workspaceAppHref({
    id: app.id,
    name: app.name,
    path: app.path ?? "",
    homePath: app.homePath ?? undefined,
    url: app.url,
    isDispatch: app.isDispatch ?? isDispatchWorkspaceAppId(app.id),
  });
  const topWindowHref = useMemo(() => {
    if (embedPath !== undefined) {
      return workspaceAppDirectHref(
        { path: app.path, url: app.url },
        embedPath,
      );
    }
    if (initialPath !== undefined) {
      return workspaceAppDirectHref(
        { path: app.path, url: app.url },
        initialPath,
      );
    }

    return appHref;
  }, [appHref, embedPath, initialPath]);
  const openInTopWindow = shouldOpenWorkspaceAppInTopWindow();
  const topWindowSsoAttemptKey = `${app.id}\u0000${app.path ?? ""}\u0000${app.url ?? ""}\u0000${embedPath ?? ""}\u0000${initialPath ?? ""}\u0000${embedAttempt}`;
  const topWindowSsoAttemptedRef = useRef<string | null>(null);
  const embedInput = useMemo<EmbedSessionInput | null>(() => {
    if (embedPath !== undefined) {
      return buildChatFirstEmbedSessionInput(app.id, embedPath);
    }
    if (initialPath !== undefined) {
      return buildChatFirstEmbedSessionInput(app.id, initialPath);
    }
    if (!appHref) return null;
    return {
      app: app.id,
      ...(app.url?.trim() ? { url: appHref } : { path: appHref }),
      chrome: "minimal",
    };
  }, [app.id, app.path, app.url, appHref, embedPath, initialPath]);

  useEffect(() => {
    if (openInTopWindow && useWorkspaceSso && embedInput) {
      setTopWindowNavigationFailed(false);
      return;
    }
    if (!openInTopWindow) {
      setTopWindowNavigationFailed(false);
      return;
    }
    if (!topWindowHref) {
      setTopWindowNavigationFailed(true);
      return;
    }

    let didNavigate = false;
    try {
      didNavigate = navigateToTopWindow(topWindowHref) !== false;
    } catch {
      didNavigate = false;
    }
    setTopWindowNavigationFailed(!didNavigate);
  }, [
    embedInput,
    navigateToTopWindow,
    openInTopWindow,
    topWindowHref,
    useWorkspaceSso,
  ]);

  useEffect(() => {
    const useTopWindowSso = openInTopWindow && useWorkspaceSso && !!embedInput;
    if (
      !embedInput ||
      (openInTopWindow && !useWorkspaceSso && !topWindowNavigationFailed)
    ) {
      return;
    }
    if (
      useTopWindowSso &&
      topWindowSsoAttemptedRef.current === topWindowSsoAttemptKey
    ) {
      return;
    }
    if (useTopWindowSso) {
      topWindowSsoAttemptedRef.current = topWindowSsoAttemptKey;
    }
    let cancelled = false;
    setEmbedUrl(null);
    setEmbedError(null);
    setIsDirectFallback(false);
    const createSession = useWorkspaceSso
      ? createWorkspaceSsoEmbedSession
      : createEmbedSession;
    void createSession
      .mutateAsync(embedInput)
      .then((result) => {
        if (cancelled) return;
        if (useTopWindowSso) {
          let didNavigate = false;
          try {
            didNavigate = navigateToTopWindow(result.startUrl) !== false;
          } catch {
            didNavigate = false;
          }
          setTopWindowNavigationFailed(!didNavigate);
          setEmbedUrl(didNavigate ? null : result.startUrl);
          return;
        }
        setEmbedUrl(result.startUrl);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        const error = cause instanceof Error ? cause : new Error(String(cause));
        if (useWorkspaceSso) {
          setIsDirectFallback(false);
          setEmbedUrl(null);
          setEmbedError(error);
          if (useTopWindowSso) setTopWindowNavigationFailed(true);
          emitLifecycle("frame-load-failed", {
            failure: frameFailureForError(cause),
          });
          return;
        }
        setIsDirectFallback(true);
        const fallbackHref =
          initialPath !== undefined || embedPath !== undefined
            ? workspaceAppDirectHref(
                { path: app.path ?? "", url: app.url },
                initialPath ?? embedPath ?? "/",
              )
            : appHref;
        setEmbedUrl(fallbackHref);
        setEmbedError(error);
      });
    return () => {
      cancelled = true;
    };
  }, [
    app.id,
    app.path,
    app.url,
    appHref,
    createEmbedSession.mutateAsync,
    createWorkspaceSsoEmbedSession.mutateAsync,
    embedInput,
    embedPath,
    emitLifecycle,
    initialPath,
    embedAttempt,
    openInTopWindow,
    navigateToTopWindow,
    topWindowSsoAttemptKey,
    topWindowNavigationFailed,
    useWorkspaceSso,
  ]);

  useEffect(() => {
    const handleEmbedSessionExpired = (event: MessageEvent) => {
      if (
        !isEmbedSessionExpiredMessage(event, embedFrameRef.current, embedUrl)
      ) {
        return;
      }
      setEmbedAttempt((attempt) => attempt + 1);
    };

    window.addEventListener("message", handleEmbedSessionExpired);
    return () =>
      window.removeEventListener("message", handleEmbedSessionExpired);
  }, [embedUrl]);

  useEffect(() => {
    if (!embedUrl) return;

    const frame = embedFrameRef.current;
    if (!frame) return;

    let expectedOrigin: string;
    try {
      expectedOrigin = new URL(embedUrl, window.location.href).origin;
    } catch {
      return;
    }

    const handleWorkspaceAppRoute = (event: MessageEvent) => {
      if (
        event.source !== frame.contentWindow ||
        event.origin !== expectedOrigin
      ) {
        return;
      }
      const message = event.data as {
        type?: unknown;
        path?: unknown;
      } | null;
      if (
        message?.type !== AGENT_NATIVE_WORKSPACE_APP_ROUTE_MESSAGE_TYPE ||
        typeof message.path !== "string"
      ) {
        return;
      }

      const localPath = workspaceAppLocalPathForChildPath(
        { path: app.path ?? "", url: app.url },
        message.path,
      );
      if (localPath === null) return;
      setChildPath(localPath);
      const route = workspaceAppRouteForLocalPath(app.id, localPath);
      if (route) onChildRouteChange?.(route);
    };

    window.addEventListener("message", handleWorkspaceAppRoute);
    return () => window.removeEventListener("message", handleWorkspaceAppRoute);
  }, [app.id, app.path, app.url, embedUrl, onChildRouteChange]);

  // Coalesces every theme input change in a commit into one delivery. Before
  // the frame instance's first load there is no child document to receive
  // it; the load handler makes that first delivery.
  useEffect(() => {
    if (loadRevisionRef.current.value === 0) return;
    deliverThemeToFrame();
  }, [
    active,
    childPath,
    deliverThemeToFrame,
    embedUrl,
    frameGeneration,
    theme,
    themeRevision,
  ]);

  const previousActiveRef = useRef(active);
  useEffect(() => {
    if (previousActiveRef.current === active) return;
    previousActiveRef.current = active;
    emitLifecycle("active-change");
  }, [active, emitLifecycle]);

  const previousChildPathRef = useRef(childPath);
  useEffect(() => {
    if (previousChildPathRef.current === childPath) return;
    previousChildPathRef.current = childPath;
    emitLifecycle("route-change");
  }, [childPath, emitLifecycle]);

  useEffect(() => {
    if (!iframeKey) return;
    const generation = frameGeneration;
    const timer = window.setTimeout(() => {
      if (
        loadRevisionRef.current.generation === generation &&
        loadRevisionRef.current.value === 0
      ) {
        emitLifecycle("frame-load-failed", { failure: "timeout" });
      }
    }, WORKSPACE_APP_FRAME_LOAD_TIMEOUT_MS);
    return () => {
      window.clearTimeout(timer);
      // Passive cleanups run before this commit's effects, so this is still
      // the identity of the frame instance being replaced or unmounted.
      const identity = committedIdentityRef.current;
      if (identity) emitLifecycle("disposed", { identity });
    };
  }, [emitLifecycle, frameGeneration, iframeKey]);

  const appPane = (
    <ChatFirstAppPane
      app={app}
      status={
        embedUrl
          ? "ready"
          : embedError
            ? "error"
            : embedInput
              ? "loading"
              : "unresolved"
      }
      embedUrl={embedUrl}
      errorMessage={embedError?.message}
      onRetry={
        embedInput ? () => setEmbedAttempt((attempt) => attempt + 1) : undefined
      }
      renderEmbed={({ url, title }) => (
        <iframe
          key={url + ":" + embedAttempt}
          data-dispatch-workspace-app-frame
          src={url}
          title={title ?? app.name}
          ref={embedFrameRef}
          onLoad={handleFrameLoad}
          referrerPolicy="no-referrer"
          allow="clipboard-read; clipboard-write"
          className="h-full w-full border-0 bg-background"
        />
      )}
      copy={copy}
    />
  );

  if (!chatSidebar) return appPane;

  return (
    <WorkspaceAppChatRail appId={app.id} appName={app.name} copy={copy}>
      {appPane}
    </WorkspaceAppChatRail>
  );
}

export interface WorkspaceAppHostProps {
  appId?: string;
  navigateToTopWindow?: (href: string) => boolean | void;
  initialPath?: string;
  onChildRouteChange?: (path: string) => void;
  active?: boolean;
  extensions?: WorkspaceAppHostExtensions;
}

export function WorkspaceAppHost({
  appId,
  navigateToTopWindow = navigateToWorkspaceApp,
  initialPath,
  onChildRouteChange,
  active,
  extensions,
}: WorkspaceAppHostProps) {
  const t = useT();
  const workspaceAppsQuery = useActionQuery<WorkspaceAppSummary[]>(
    "list-workspace-apps",
    { includeAgentCards: false, includeArchived: true },
  );
  const apps = useMemo(
    () => (workspaceAppsQuery.data ?? []).filter((item) => !item.archived),
    [workspaceAppsQuery.data],
  );
  const app = useMemo(
    () =>
      apps.find(
        (item) => item.id.trim().toLowerCase() === appId?.trim().toLowerCase(),
      ) ?? null,
    [appId, apps],
  );
  const isLoading = workspaceAppsQuery.isLoading;
  const queryError = workspaceAppsQuery.isError
    ? workspaceAppsQuery.error
    : null;

  if (queryError && !app) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center p-6">
        <div className="w-full max-w-2xl">
          <ActionQueryError
            error={queryError}
            onRetry={() => void workspaceAppsQuery.refetch()}
          />
        </div>
      </div>
    );
  }

  if (isLoading && !app) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center p-6">
        <div className="w-full max-w-2xl space-y-3 rounded-xl border bg-card p-6">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      </div>
    );
  }

  if (!app) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center p-6">
        <div className="w-full max-w-2xl rounded-xl border bg-card p-6">
          <Button asChild size="sm" variant="ghost" className="-ml-2 mb-4">
            <Link to="/apps">
              <IconArrowLeft size={15} className="mr-1.5" />
              {t("dispatch.nav.apps")}
            </Link>
          </Button>
          <div className="space-y-3">
            <h2 className="text-base font-semibold text-foreground">
              {t("dispatch.pages.appNotFound")}
            </h2>
            <p className="text-sm text-muted-foreground">
              {t("dispatch.pages.pageNotFoundDescription")}
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (app.status === "pending") {
    return (
      <div className="flex h-full min-h-0 items-center justify-center p-6">
        <div className="w-full max-w-2xl rounded-xl border bg-card p-6">
          <Button asChild size="sm" variant="ghost" className="-ml-2 mb-4">
            <Link to="/apps">
              <IconArrowLeft size={15} className="mr-1.5" />
              {t("dispatch.nav.apps")}
            </Link>
          </Button>
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold text-foreground">
                {app.name}
              </h2>
              <Badge
                variant="outline"
                className="gap-1 border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
              >
                <IconClockHour4 size={12} />
                {t("dispatch.pages.building")}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              {t("dispatch.pages.appBuildingPrefix")}{" "}
              <span className="font-mono text-foreground">{app.path}</span>{" "}
              {t("dispatch.pages.appBuildingSuffix")}
            </p>
            {app.builderUrl ? (
              <Button asChild>
                <a
                  href={withBuilderUtmTrackingParams(app.builderUrl, {
                    campaign: "product",
                    content: "dispatch_branch",
                  })}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t("dispatch.pages.openBuilderBranch", {
                    defaultValue: "Open in Builder",
                  })}
                </a>
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      data-dispatch-workspace-app-host
      className="flex h-full min-h-0 flex-col bg-background"
    >
      <div className="min-h-0 flex-1 bg-muted/20">
        <WorkspaceAppFrame
          app={app}
          navigateToTopWindow={navigateToTopWindow}
          initialPath={initialPath}
          onChildRouteChange={onChildRouteChange}
          active={active}
          extensions={extensions}
        />
      </div>
    </div>
  );
}

const MAX_KEEP_ALIVE_APPS = 3;

export interface WorkspaceAppKeepAliveProps {
  activeAppId: string | null;
  /**
   * App-local route to open when the active app enters the cache. Retained
   * frames ignore later changes: they keep their own live route.
   */
  activeInitialPath?: string;
  extensions?: WorkspaceAppHostExtensions;
  /**
   * Dispatch route (`/apps/:appId/...`) of a cached frame: reported when the
   * frame enters the cache and on each trusted child route message.
   */
  onChildRouteChange?: (appId: string, route: string) => void;
}

interface WorkspaceAppKeepAliveEntry {
  appId: string;
  initialPath?: string;
}

export function WorkspaceAppKeepAlive({
  activeAppId,
  activeInitialPath,
  extensions,
  onChildRouteChange,
}: WorkspaceAppKeepAliveProps) {
  const [visited, setVisited] = useState<WorkspaceAppKeepAliveEntry[]>(() =>
    activeAppId ? [{ appId: activeAppId, initialPath: activeInitialPath }] : [],
  );

  // Seeding reads the route only when an app enters the cache.
  const activeInitialPathRef = useRef(activeInitialPath);
  activeInitialPathRef.current = activeInitialPath;

  useEffect(() => {
    if (!activeAppId) return;
    setVisited((current) => {
      const existing = current.find((entry) => entry.appId === activeAppId);
      return [
        existing ?? {
          appId: activeAppId,
          initialPath: activeInitialPathRef.current,
        },
        ...current.filter((entry) => entry.appId !== activeAppId),
      ].slice(0, MAX_KEEP_ALIVE_APPS);
    });
  }, [activeAppId]);

  const renderedEntries =
    activeAppId && !visited.some((entry) => entry.appId === activeAppId)
      ? [{ appId: activeAppId, initialPath: activeInitialPath }, ...visited]
      : visited;

  return (
    <div
      data-dispatch-workspace-app-cache
      className={activeAppId ? "absolute inset-0 overflow-hidden" : "hidden"}
    >
      {renderedEntries.map((entry) => {
        const active = entry.appId === activeAppId;
        return (
          <div
            key={entry.appId}
            data-dispatch-workspace-app-cache-entry={entry.appId}
            aria-hidden={!active}
            className={active ? "h-full min-h-0" : "hidden"}
          >
            <WorkspaceAppKeepAliveHost
              appId={entry.appId}
              initialPath={entry.initialPath}
              active={active}
              extensions={extensions}
              onChildRouteChange={onChildRouteChange}
            />
          </div>
        );
      })}
    </div>
  );
}

function WorkspaceAppKeepAliveHost({
  appId,
  initialPath,
  active,
  extensions,
  onChildRouteChange,
}: {
  appId: string;
  initialPath?: string;
  active: boolean;
  extensions?: WorkspaceAppHostExtensions;
  onChildRouteChange?: (appId: string, route: string) => void;
}) {
  const onChildRouteChangeRef = useRef(onChildRouteChange);
  onChildRouteChangeRef.current = onChildRouteChange;
  const handleChildRouteChange = useCallback(
    (route: string) => onChildRouteChangeRef.current?.(appId, route),
    [appId],
  );
  // A fresh cache entry reports the route it opened at, so an observer never
  // keeps a route from an earlier, evicted frame of the same app.
  const [entryPath] = useState(initialPath ?? "/");
  useEffect(() => {
    const route = workspaceAppRouteForLocalPath(appId, entryPath);
    if (route) onChildRouteChangeRef.current?.(appId, route);
  }, [appId, entryPath]);
  return (
    <WorkspaceAppHost
      appId={appId}
      initialPath={initialPath}
      active={active}
      extensions={extensions}
      onChildRouteChange={handleChildRouteChange}
    />
  );
}
