import { useActionQuery } from "@agent-native/core/client/hooks";
import { useT } from "@agent-native/core/client/i18n";
import { AgentChatHome } from "@agent-native/toolkit/app/chat/AgentChatHome";
import { defaultChatFirstCopy } from "@agent-native/toolkit/app/chat/chat-first-copy";
import { IconAlertTriangle, IconArrowLeft } from "@tabler/icons-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Link, useLocation, useNavigate } from "react-router";

import {
  buildWorkspaceAppChatFullViewPath,
  resolveWorkspaceAppChatThread,
  workspaceAppChatReturnRoute,
  type WorkspaceAppChatHandoff,
  type WorkspaceAppChatThreadResolution,
} from "../lib/workspace-app-chat-handoff";
import type { WorkspaceAppSummary } from "../lib/workspace-apps";
import { ActionQueryError } from "./action-query-error";
import { dispatchNavLinkTarget } from "./layout/Layout";
import { Alert, AlertDescription } from "./ui/alert";
import { Button } from "./ui/button";
import { Skeleton } from "./ui/skeleton";
import { useWorkspaceAppChatApi } from "./workspace-app-chat-api";

interface AppChatEntryState {
  dispatchAppChatEntry?: { threadId?: string | null };
}

type EntryResolution =
  | { status: "pending" }
  | { status: "ready" }
  | { status: "failed"; reason: WorkspaceAppChatThreadResolution["status"] };

/**
 * Full-view chat for one workspace app's own agent. It uses the exact
 * identity the app's chat rail uses — the app chat proxy, the
 * `dispatch-app-chat:<appId>` storage key and the `workspace-app:<appId>`
 * scope with isolated history — so the rail and this page are one session.
 * Layout disables the rail while this page is mounted, so only one chat
 * controller for that identity is live at a time.
 */
export function WorkspaceAppChatFullView({
  handoff,
}: {
  handoff: WorkspaceAppChatHandoff;
}) {
  const t = useT();
  const location = useLocation();
  const navigate = useNavigate();
  const appId = handoff.appId;
  const appsQuery = useActionQuery<WorkspaceAppSummary[]>(
    "list-workspace-apps",
    { includeAgentCards: false, includeArchived: true },
  );
  const app = useMemo(
    () =>
      (appsQuery.data ?? []).find(
        (item) =>
          !item.archived &&
          item.status !== "pending" &&
          item.id.trim().toLowerCase() === appId.trim().toLowerCase(),
      ) ?? null,
    [appId, appsQuery.data],
  );
  const appName = app?.name ?? appId;
  const appChat = useWorkspaceAppChatApi(appId, Boolean(app));

  // The entry thread is checked once; later thread changes come from this
  // page's own chat controller writing the URL.
  const [entry] = useState(() => {
    const state = location.state as AppChatEntryState | null;
    const railThreadId = state?.dispatchAppChatEntry?.threadId ?? undefined;
    return {
      threadId: handoff.threadId,
      fromLiveRail:
        Boolean(handoff.threadId) && railThreadId === handoff.threadId,
    };
  });
  const [resolution, setResolution] = useState<EntryResolution>(() =>
    entry.threadId ? { status: "pending" } : { status: "ready" },
  );
  const [resolveAttempt, setResolveAttempt] = useState(0);

  useEffect(() => {
    if (!app || !entry.threadId || appChat.unavailable) return;
    let cancelled = false;
    setResolution({ status: "pending" });
    void resolveWorkspaceAppChatThread(
      appChat.apiUrl,
      appId,
      entry.threadId,
    ).then((result) => {
      if (cancelled) return;
      if (result.status === "found") {
        setResolution({ status: "ready" });
      } else if (result.status === "not-found" && entry.fromLiveRail) {
        // The rail's active thread in this tab has not been saved yet: it is
        // the same draft, and its first message saves it under this id.
        setResolution({ status: "ready" });
      } else {
        if (result.status === "unavailable") {
          console.warn(
            `[dispatch] could not resolve app chat thread for ${appId}`,
            result.error,
          );
        }
        setResolution({ status: "failed", reason: result.status });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [
    app,
    appChat.apiUrl,
    appChat.unavailable,
    appId,
    entry.fromLiveRail,
    entry.threadId,
    resolveAttempt,
  ]);

  const returnRoute = workspaceAppChatReturnRoute(handoff);
  const scope = useMemo(
    () => ({
      type: "workspace-app",
      id: appId,
      label: appName,
      contextKey: `workspace-app:${appId}`,
    }),
    [appId, appName],
  );
  const navigateThreadUrl = useCallback(
    (path: string, options?: { replace?: boolean }) =>
      navigate(dispatchNavLinkTarget(path), options),
    [navigate],
  );
  const threadUrlSync = useMemo(
    () => ({
      routeThreadId: handoff.threadId ?? null,
      getPath: (threadId: string | null) =>
        buildWorkspaceAppChatFullViewPath({
          ...handoff,
          threadId: threadId ?? undefined,
        }) ?? `${location.pathname}${location.search}`,
      navigate: navigateThreadUrl,
    }),
    [handoff, location.pathname, location.search, navigateThreadUrl],
  );

  const backButton = returnRoute ? (
    <Button asChild size="sm" variant="ghost">
      <Link to={dispatchNavLinkTarget(returnRoute)} data-dispatch-app-chat-back>
        <IconArrowLeft size={15} className="mr-1.5" />
        {t("dispatch.pages.backToApp", {
          defaultValue: "Back to {{name}}",
          name: appName,
        })}
      </Link>
    </Button>
  ) : null;

  if (appsQuery.isError && !app) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center bg-background px-4">
        <ActionQueryError
          error={appsQuery.error}
          onRetry={() => void appsQuery.refetch()}
        />
      </div>
    );
  }

  if (
    (appsQuery.isLoading && !app) ||
    (app && !appChat.unavailable && resolution.status === "pending")
  ) {
    return (
      <div
        data-dispatch-app-chat-full-view="loading"
        className="flex h-full min-h-0 flex-col gap-4 bg-background px-4 py-6 sm:px-6"
      >
        <Skeleton className="mx-auto h-6 w-48" />
        <Skeleton className="mx-auto h-12 w-full max-w-2xl" />
      </div>
    );
  }

  if (!app) {
    return (
      <WorkspaceAppChatUnavailable state="app-unavailable">
        <Button asChild size="sm" variant="ghost" className="-ml-2">
          <Link to={dispatchNavLinkTarget("/apps")}>
            <IconArrowLeft size={15} className="mr-1.5" />
            {t("dispatch.nav.apps")}
          </Link>
        </Button>
        <p className="text-sm text-muted-foreground">
          {t("dispatch.pages.appNotFound")}
        </p>
      </WorkspaceAppChatUnavailable>
    );
  }

  if (appChat.unavailable || resolution.status === "failed") {
    return (
      <WorkspaceAppChatUnavailable
        state={
          appChat.unavailable
            ? "agent-unavailable"
            : `thread-${resolution.status === "failed" ? resolution.reason : "unknown"}`
        }
      >
        {backButton}
        <Alert variant="destructive">
          <IconAlertTriangle className="size-4" />
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>
              {appChat.unavailable
                ? t("dispatch.pages.appChatUnavailable", {
                    defaultValue:
                      "Dispatch could not connect to {{name}}'s agent, so its chat is unavailable here.",
                    name: appName,
                  })
                : t("dispatch.pages.appChatThreadUnavailable", {
                    defaultValue:
                      "This conversation is not available in {{name}}.",
                    name: appName,
                  })}
            </span>
            {appChat.unavailable ||
            (resolution.status === "failed" &&
              resolution.reason === "unavailable") ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  appChat.retry();
                  setResolveAttempt((value) => value + 1);
                }}
              >
                {defaultChatFirstCopy("retry")}
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      </WorkspaceAppChatUnavailable>
    );
  }

  return (
    <div
      data-dispatch-app-chat-full-view="ready"
      className="flex h-full min-h-0 flex-col bg-background"
    >
      {backButton ? (
        <div className="shrink-0 px-3 pt-2">{backButton}</div>
      ) : null}
      <AgentChatHome
        className="flex-1 min-h-0"
        contentClassName="max-w-none"
        surfaceClassName="dispatch-chat-panel"
        chatViewTransition
        defaultMode="chat"
        apiUrl={appChat.apiUrl}
        agentChatSurface="app"
        storageKey={`dispatch-app-chat:${appId}`}
        scope={scope}
        isolateHistoryByScope
        threadUrlSync={threadUrlSync}
        showHeader={false}
        showTabBar={false}
        dynamicSuggestions={false}
        suppressInlineOpenApp
        suggestions={[]}
        emptyStateText={`Ask about ${appName}`}
        centerComposerWhenEmpty={!handoff.threadId}
        composerLayoutVariant={handoff.threadId ? "default" : "hero"}
      />
    </div>
  );
}

function WorkspaceAppChatUnavailable({
  state,
  children,
}: {
  state: string;
  children: ReactNode;
}) {
  return (
    <div
      data-dispatch-app-chat-full-view="unavailable"
      data-dispatch-app-chat-unavailable-reason={state}
      className="flex h-full min-h-0 items-center justify-center bg-background p-6"
    >
      <div className="w-full max-w-2xl space-y-3">{children}</div>
    </div>
  );
}
