import { createAgentNativeQueryClient } from "@agent-native/core/client/hooks";
import { DESKTOP_LOCAL_CODE_CHANGE_EVENT } from "@agent-native/core/client/host";
import {
  AgentChatMemoryRouter as MemoryRouter,
  AgentSidebar,
} from "@agent-native/toolkit/app/chat";
import { preloadAgentChatSurface } from "@agent-native/toolkit/app/chat/AgentSidebar";
import type { BuilderConnectTransport } from "@agent-native/toolkit/app/settings";
import { Button } from "@agent-native/toolkit/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@agent-native/toolkit/ui/dialog";
import type {
  DesktopAppRuntimeStatus,
  DesktopIdentityStatus,
  DesktopPrepareLocalCodeChangeResult,
} from "@shared/ipc-channels";
import {
  IconAlertCircle,
  IconCircleCheck,
  IconLoader2,
} from "@tabler/icons-react";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  DesktopChatRelayAppContext,
  installDesktopChatFetchRelay,
  setDesktopChatRelayActive,
  setDesktopChatRelayBase,
} from "../lib/desktop-chat-relay.js";
import {
  DESKTOP_LOCAL_AGENT_ENGINE_BY_ID,
  DESKTOP_LOCAL_AGENT_OPTIONS,
  CLAUDE_CODE_NOT_INSTALLED_MESSAGE,
  createDesktopLocalAgentRuntime,
  describeClaudeCodeProblem,
  desktopLocalRuntimeNotice,
  desktopLocalRuntimeStatusLabel,
  pickDefaultDesktopLocalAgent,
  type DesktopLocalAgentId,
} from "../lib/desktop-local-agent-runtime.js";
import type { DesktopTerminalAgentId } from "../lib/desktop-terminal-preferences.js";
import type { RendererTheme } from "../lib/theme.js";
import type { AppWebviewAuthState } from "./AppWebview.js";
import DesktopRuntimeNotice, {
  type ClaudeSignInState,
} from "./DesktopRuntimeNotice.js";
import DesktopTerminalTabs from "./DesktopTerminalTabs.js";

type DesktopChatModelGroup = {
  engine: string;
  label: string;
  models: string[];
  configured: boolean;
  statusLabel?: string;
  isSubscription?: boolean;
};

function desktopModelProviderLabel(model: CodeAgentModelOption): string {
  const normalizedModel = model.model.toLowerCase();
  if (
    model.engine === "codex-cli" ||
    normalizedModel.startsWith("gpt-") ||
    normalizedModel.startsWith("openai/gpt-")
  ) {
    return "OpenAI";
  }
  if (normalizedModel.startsWith("claude-")) return "Anthropic";
  if (normalizedModel.startsWith("gemini-")) return "Gemini";
  return model.engineLabel;
}

export interface DesktopAppChatShellProps {
  appId: string;
  appName: string;
  children: ReactNode;
  onOpenSettings?: (section?: string) => void;
  desktopIdentityUnauthenticated?: boolean;
  desktopIdentityAuthenticated?: boolean;
  desktopIdentityStatus?: DesktopIdentityStatus | "checking";
  appAuthState?: AppWebviewAuthState;
  isActive?: boolean;
  chatEnabled?: boolean;
  toggleScopeId?: string;
  defaultMode?: "chat" | "cli";
  terminal?: {
    agent: DesktopTerminalAgentId;
    theme: RendererTheme;
    path?: string;
    view?: string;
  };
  onLocalCodeChangeStarted?: (
    result: DesktopPrepareLocalCodeChangeResult,
  ) => void;
}

export function desktopSettingsTabForSection(section?: string | null): string {
  const normalized = section?.replace(/^#/, "").trim().toLowerCase() ?? "";
  if (normalized === "terminal") return "terminal";
  if (normalized === "llm" || normalized === "app-models") return "providers";
  if (
    normalized === "integrations" ||
    normalized === "connections" ||
    normalized.startsWith("secrets:") ||
    normalized === "secrets" ||
    normalized === "email" ||
    normalized === "browser"
  ) {
    return "connections";
  }
  if (
    normalized === "hosting" ||
    normalized === "database" ||
    normalized === "uploads" ||
    normalized === "auth" ||
    normalized === "demo-mode" ||
    normalized === "workspace" ||
    normalized === "workspace-settings"
  ) {
    return "workspace";
  }
  return "general";
}

export function shouldShowDesktopAppChatSidebar(input: {
  apiUrl?: string | null;
  appAuthState?: AppWebviewAuthState;
  chatEnabled?: boolean;
  desktopIdentityUnauthenticated?: boolean;
  desktopIdentityStatus?: DesktopIdentityStatus | "checking";
}): boolean {
  if (
    input.chatEnabled === false ||
    !input.apiUrl ||
    input.appAuthState === "unauthenticated"
  ) {
    return false;
  }
  if (input.desktopIdentityUnauthenticated) return false;
  return input.desktopIdentityStatus !== "sign-in-required";
}

function hasSignedInClaude(models: readonly CodeAgentModelOption[]): boolean {
  return models.some(
    (model) =>
      model.engine === DESKTOP_LOCAL_AGENT_ENGINE_BY_ID["claude-code"] &&
      model.configured === true,
  );
}

type LocalCodeChangeState =
  | { status: "idle" }
  | { status: "starting"; message?: string }
  | { status: "ready" }
  | { status: "error"; message: string };

export default function DesktopAppChatShell({
  appId,
  appName,
  children,
  onOpenSettings,
  desktopIdentityUnauthenticated = false,
  desktopIdentityAuthenticated = false,
  desktopIdentityStatus,
  appAuthState,
  isActive = true,
  chatEnabled = true,
  toggleScopeId,
  defaultMode = "chat",
  terminal,
  onLocalCodeChangeStarted,
}: DesktopAppChatShellProps) {
  const [desktopChatQueryClient] = useState(() =>
    createAgentNativeQueryClient(),
  );
  const shellRootRef = useRef<HTMLDivElement>(null);
  const [apiUrl, setApiUrl] = useState<string | null>(null);
  const [localAgentModels, setLocalAgentModels] = useState<
    CodeAgentModelOption[]
  >([]);
  const [localAgentModelsLoading, setLocalAgentModelsLoading] = useState(true);
  // A failed probe is not an empty list: every row would otherwise read
  // "Not installed".
  const [localAgentModelsFailed, setLocalAgentModelsFailed] = useState(false);
  const [claudeSignIn, setClaudeSignIn] = useState<ClaudeSignInState>({
    status: "idle",
  });
  const [selectedAgent, setSelectedAgent] = useState("default");
  // True once the person has picked a runtime for this app; until then the
  // chat opens on the first signed-in subscription runtime.
  const agentChosenRef = useRef(false);
  const [localCodeChangePrompt, setLocalCodeChangePrompt] = useState("");
  const [localCodeChange, setLocalCodeChange] = useState<LocalCodeChangeState>({
    status: "idle",
  });
  const builderConnectTransport = useMemo<BuilderConnectTransport>(
    () => ({
      async readStatus({ connectAttemptId }) {
        const api = window.electronAPI?.codeAgents;
        if (!api) return null;
        const result = await api.getBuilderConnectionStatus(connectAttemptId);
        return result.state === "unavailable" ? null : result.status;
      },
      async activateAccount(request) {
        const api = window.electronAPI?.codeAgents;
        if (!api) {
          return {
            ok: false,
            code: "desktop_bridge_unavailable",
            message: "Restart Agent-Native Desktop to continue.",
          };
        }
        return api.activateBuilderAccount({
          ...request,
          scope: request.scope ?? undefined,
        });
      },
      async openConnectUrl(request) {
        const api = window.electronAPI?.codeAgents;
        if (!api) {
          return {
            ok: false,
            error: "Restart Agent-Native Desktop to continue.",
          };
        }
        return api.openBuilderConnectUrl(request);
      },
    }),
    [],
  );

  useEffect(() => {
    try {
      const stored = localStorage.getItem(`desktop-app-agent:${appId}`);
      if (stored) {
        agentChosenRef.current = true;
        setSelectedAgent(stored);
      }
      // coercion-ok: localStorage is optional renderer state; the explicit default remains active.
    } catch {
      // Keep the default agent when storage is unavailable.
    }
  }, [appId, isActive]);

  useEffect(() => {
    let cancelled = false;
    setLocalAgentModelsLoading(true);
    const listModels = window.electronAPI?.codeAgents
      ? () => window.electronAPI!.codeAgents!.listModels()
      : undefined;
    if (!listModels) {
      setLocalAgentModelsLoading(false);
      return () => undefined;
    }
    void listModels()
      .then((result) => {
        if (cancelled) return;
        setLocalAgentModels(result.models);
        setLocalAgentModelsFailed(result.status !== "ok");
      })
      .catch(() => {
        if (cancelled) return;
        setLocalAgentModels([]);
        setLocalAgentModelsFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLocalAgentModelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [appId, appAuthState]);

  const availableModels = useMemo<DesktopChatModelGroup[]>(() => {
    const groups = new Map<string, DesktopChatModelGroup>();
    for (const model of localAgentModels) {
      const modelId = model.model.trim();
      if (!modelId || modelId === "auto") continue;
      const label = desktopModelProviderLabel(model);
      const key = `${model.engine}:${label}`;
      const existing = groups.get(key);
      if (existing) {
        if (!existing.models.includes(modelId)) existing.models.push(modelId);
        existing.configured ||= model.configured === true;
        if (!existing.statusLabel && model.statusLabel) {
          existing.statusLabel = model.statusLabel;
        }
        existing.isSubscription ||= model.isSubscription === true;
        continue;
      }
      groups.set(key, {
        engine: model.engine,
        label,
        models: [modelId],
        configured: model.configured === true,
        ...(model.statusLabel ? { statusLabel: model.statusLabel } : {}),
        ...(model.isSubscription ? { isSubscription: true } : {}),
      });
    }
    return [...groups.values()];
  }, [localAgentModels]);

  const availableAgents = useMemo(
    () =>
      DESKTOP_LOCAL_AGENT_OPTIONS.map((agent) => {
        if (agent.id === "default") return agent;
        const engine =
          DESKTOP_LOCAL_AGENT_ENGINE_BY_ID[agent.id as DesktopLocalAgentId];
        const model = localAgentModels.find((item) => item.engine === engine);
        const configured = model?.configured === true;
        const runtimeState = model?.runtimeState;
        const problem =
          agent.id === "claude-code" && !configured && !localAgentModelsFailed
            ? describeClaudeCodeProblem(runtimeState ?? "not-installed")
            : undefined;
        return {
          ...agent,
          configured,
          ...(problem ? { description: problem } : {}),
          ...(runtimeState ? { runtimeState } : {}),
          statusLabel: localAgentModelsFailed
            ? "Couldn't check"
            : (model?.statusLabel ??
              desktopLocalRuntimeStatusLabel(
                model ? (runtimeState ?? "needs-sign-in") : "not-installed",
              )),
        };
      }),
    [localAgentModels, localAgentModelsFailed],
  );

  const handleAgentChange = useCallback(
    (agent: string) => {
      const option = availableAgents.find((item) => item.id === agent);
      if (!option || option.configured === false) return;
      agentChosenRef.current = true;
      setSelectedAgent(agent);
      try {
        localStorage.setItem(`desktop-app-agent:${appId}`, agent);
        // coercion-ok: localStorage is optional renderer state; this mount already has the selection.
      } catch {
        // The selection still applies for this mount when storage is unavailable.
      }
    },
    [appId, availableAgents],
  );

  const defaultLocalAgent = useMemo(
    () => pickDefaultDesktopLocalAgent(availableAgents),
    [availableAgents],
  );
  useEffect(() => {
    if (localAgentModelsLoading || agentChosenRef.current) return;
    if (!defaultLocalAgent) return;
    setSelectedAgent((current) =>
      current === "default" ? defaultLocalAgent : current,
    );
  }, [defaultLocalAgent, localAgentModelsLoading]);

  const claudeAgent = availableAgents.find(
    (agent) => agent.id === "claude-code",
  );
  const claudeConfigured = claudeAgent?.configured === true;
  const claudeInstalled = localAgentModels.some(
    (model) => model.engine === DESKTOP_LOCAL_AGENT_ENGINE_BY_ID["claude-code"],
  );

  const startClaudeSignIn = useCallback(async () => {
    const api = window.electronAPI.multiFrontier;
    if (!api) {
      setClaudeSignIn({
        status: "failed",
        message: "Claude sign-in is unavailable in this Desktop build.",
      });
      return;
    }
    setClaudeSignIn({ status: "opening" });
    try {
      const result = await api.beginProviderLogin("claude");
      setClaudeSignIn(
        result.error?.message
          ? { status: "failed", message: result.error.message }
          : { status: "opened" },
      );
    } catch (error) {
      setClaudeSignIn({
        status: "failed",
        message:
          error instanceof Error
            ? error.message
            : "Could not open the Claude sign-in.",
      });
    }
  }, []);

  const openLocalRuntimeSetup = useCallback((agent: string) => {
    if (agent === "codex") {
      void window.electronAPI?.codeAgents?.openCodexLogin();
      return;
    }
    void window.electronAPI?.codeAgents?.openTerminal();
  }, []);

  const handleLocalRuntimeSetup = useCallback(
    (agent: string) => {
      if (agent !== "claude-code") {
        openLocalRuntimeSetup(agent);
      } else if (claudeInstalled) {
        void startClaudeSignIn();
      } else {
        setClaudeSignIn({
          status: "failed",
          message: CLAUDE_CODE_NOT_INSTALLED_MESSAGE,
        });
      }
    },
    [claudeInstalled, openLocalRuntimeSetup, startClaudeSignIn],
  );

  // The sign-in finishes in Terminal, outside this window: look again when the
  // person comes back, past the main-process status cache. One look at a time.
  const recheckingRef = useRef(false);
  const recheckLocalAgents = useCallback(async () => {
    if (recheckingRef.current) return;
    recheckingRef.current = true;
    try {
      const result = await window.electronAPI.codeAgents.listModels({
        refresh: true,
      });
      setLocalAgentModels(result.models);
      setLocalAgentModelsFailed(result.status !== "ok");
      if (result.status !== "ok") {
        setClaudeSignIn({ status: "recheck-failed" });
      } else if (!hasSignedInClaude(result.models)) {
        // Still signed out: drop "Finish signing in…" and offer the button again.
        setClaudeSignIn({ status: "idle" });
      }
    } catch {
      setLocalAgentModelsFailed(true);
      setClaudeSignIn({ status: "recheck-failed" });
    } finally {
      recheckingRef.current = false;
    }
  }, []);
  useEffect(() => {
    if (
      claudeSignIn.status !== "opened" &&
      claudeSignIn.status !== "recheck-failed"
    ) {
      return;
    }
    const lookAgain = () => void recheckLocalAgents();
    window.addEventListener("focus", lookAgain);
    return () => window.removeEventListener("focus", lookAgain);
  }, [claudeSignIn.status, recheckLocalAgents]);

  // The person asked to sign in to Claude: once it can run, use it unless they
  // have picked a runtime themselves.
  useEffect(() => {
    if (claudeSignIn.status === "idle" || !claudeConfigured) return;
    setClaudeSignIn({ status: "idle" });
    if (!agentChosenRef.current) setSelectedAgent("claude-code");
  }, [claudeConfigured, claudeSignIn.status]);

  const runtimeNotice = useMemo(
    () =>
      localAgentModelsLoading
        ? undefined
        : desktopLocalRuntimeNotice({
            agents: availableAgents,
            selectedAgent,
            modelListFailed: localAgentModelsFailed,
          }),
    [
      availableAgents,
      localAgentModelsFailed,
      localAgentModelsLoading,
      selectedAgent,
    ],
  );

  const localAgentId =
    selectedAgent === "default"
      ? undefined
      : (selectedAgent as DesktopLocalAgentId);
  const engineModelsKey = useMemo(() => {
    if (!localAgentId) return "";
    const engine = DESKTOP_LOCAL_AGENT_ENGINE_BY_ID[localAgentId];
    return JSON.stringify(
      localAgentModels
        .filter((item) => item.engine === engine)
        .map((item) => item.model),
    );
  }, [localAgentId, localAgentModels]);
  const localRuntime = useMemo(
    () =>
      localAgentId
        ? createDesktopLocalAgentRuntime(localAgentId, undefined, {
            appId,
            appName,
            ...(engineModelsKey
              ? { engineModels: JSON.parse(engineModelsKey) as string[] }
              : {}),
          })
        : undefined,
    [appId, appName, engineModelsKey, localAgentId],
  );

  // The rail's Chat button toggles this panel: leave one state-only log line
  // in main.log so the opening can be verified without a screenshot.
  useEffect(() => {
    if (!toggleScopeId) return;
    const onToggle = (event: Event) => {
      const detail = (event as CustomEvent<{ scopeId?: unknown }>).detail;
      if (detail?.scopeId !== toggleScopeId) return;
      void window.electronAPI?.codeAgents
        ?.noteAppChatOpened?.({ appId, runtime: selectedAgent })
        ?.catch(() => undefined);
    };
    window.addEventListener("agent-panel:toggle", onToggle);
    return () => window.removeEventListener("agent-panel:toggle", onToggle);
  }, [appId, selectedAgent, toggleScopeId]);
  const openDesktopSettings = useCallback(
    (section?: string) =>
      onOpenSettings?.(desktopSettingsTabForSection(section)),
    [onOpenSettings],
  );
  const ignoreOpenSettings = useCallback(() => undefined, []);

  installDesktopChatFetchRelay();

  useEffect(() => {
    let cancelled = false;
    setApiUrl(null);
    setDesktopChatRelayBase(appId, null);

    const getApiUrl = window.electronAPI?.desktopChat
      ? (id: string) => window.electronAPI!.desktopChat!.getApiUrl(id)
      : undefined;
    if (!getApiUrl) return () => undefined;

    void getApiUrl(appId)
      .then((nextApiUrl) => {
        if (cancelled) return;
        setDesktopChatRelayBase(appId, nextApiUrl);
        setApiUrl(nextApiUrl);
      })
      .catch(() => {
        if (cancelled) return;
        setDesktopChatRelayBase(appId, null);
        setApiUrl(null);
      });

    return () => {
      cancelled = true;
      setDesktopChatRelayBase(appId, null);
    };
  }, [appId]);

  useEffect(() => {
    void preloadAgentChatSurface();
  }, []);

  useEffect(() => {
    setDesktopChatRelayActive(appId, isActive && Boolean(apiUrl));
    return () => {
      setDesktopChatRelayActive(appId, false);
    };
  }, [apiUrl, appId, isActive]);

  const startLocalCodeChange = useCallback(
    async (prompt: string) => {
      const trimmed = prompt.trim();
      if (!trimmed || localCodeChange.status === "starting") return;

      setLocalCodeChangePrompt(trimmed);
      setLocalCodeChange({
        status: "starting",
        message: `Preparing ${appName} in a local workspace.`,
      });
      const prepare = window.electronAPI?.appConfig
        ? (
            input: Parameters<
              NonNullable<
                typeof window.electronAPI.appConfig.prepareLocalCodeChange
              >
            >[0],
          ) => window.electronAPI!.appConfig!.prepareLocalCodeChange(input)
        : undefined;
      if (!prepare) {
        setLocalCodeChange({
          status: "error",
          message: "Local code setup is unavailable in this Desktop session.",
        });
        return;
      }

      try {
        const result = await prepare({ appId, prompt: trimmed });
        if (!result.ok) {
          throw new Error(result.error ?? result.message);
        }
        onLocalCodeChangeStarted?.(result);
        setLocalCodeChange({
          status: "starting",
          message: `Cloning the template and applying your change in ${appName}.`,
        });
      } catch (error) {
        setLocalCodeChange({
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : "Desktop could not prepare the local app.",
        });
      }
    },
    [appId, appName, localCodeChange.status, onLocalCodeChangeStarted],
  );

  useEffect(() => {
    const shellRoot = shellRootRef.current;
    if (!shellRoot) return;
    const handleLocalCodeChange = (event: Event) => {
      const detail = (event as CustomEvent<{ prompt?: unknown }>).detail;
      const prompt = typeof detail?.prompt === "string" ? detail.prompt : "";
      if (!prompt || localCodeChange.status === "starting") return;
      event.stopPropagation();
      void startLocalCodeChange(prompt);
    };
    shellRoot.addEventListener(
      DESKTOP_LOCAL_CODE_CHANGE_EVENT,
      handleLocalCodeChange,
    );
    return () => {
      shellRoot.removeEventListener(
        DESKTOP_LOCAL_CODE_CHANGE_EVENT,
        handleLocalCodeChange,
      );
    };
  }, [localCodeChange.status, startLocalCodeChange]);

  useEffect(() => {
    if (localCodeChange.status === "idle") return;
    const onRuntimeStatus = window.electronAPI?.appConfig
      ? (callback: (status: DesktopAppRuntimeStatus) => void) =>
          window.electronAPI!.appConfig!.onRuntimeStatus(callback)
      : undefined;
    if (!onRuntimeStatus) return;
    return onRuntimeStatus((status: DesktopAppRuntimeStatus) => {
      if (status.appId !== appId) return;
      if (status.state === "waiting" || status.state === "starting") {
        setLocalCodeChange({
          status: "starting",
          message: status.message,
        });
        return;
      }
      if (status.state === "running") {
        setLocalCodeChange({ status: "ready" });
        return;
      }
      if (status.state === "error" || status.state === "stopped") {
        setLocalCodeChange({
          status: "error",
          message: status.message ?? `The local ${appName} preview stopped.`,
        });
      }
    });
  }, [appId, appName, localCodeChange.status]);

  useEffect(() => {
    if (localCodeChange.status !== "ready") return;
    const timer = window.setTimeout(
      () => setLocalCodeChange({ status: "idle" }),
      900,
    );
    return () => window.clearTimeout(timer);
  }, [localCodeChange.status]);

  const closeLocalCodeChangeDialog = useCallback(() => {
    if (localCodeChange.status === "starting") return;
    setLocalCodeChange({ status: "idle" });
  }, [localCodeChange.status]);

  const appSurface = (
    <div className="desktop-app-webview-surface relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {children}
    </div>
  );

  const localCodeChangeDialog = (
    <Dialog
      open={localCodeChange.status !== "idle"}
      onOpenChange={(open) => {
        if (!open) closeLocalCodeChangeDialog();
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {localCodeChange.status === "error"
              ? `Couldn’t start ${appName} locally`
              : localCodeChange.status === "ready"
                ? `${appName} is ready locally`
                : `Preparing ${appName} locally`}
          </DialogTitle>
          <DialogDescription>
            {localCodeChange.status === "error"
              ? localCodeChange.message
              : localCodeChange.status === "ready"
                ? "The app is now running from your local code."
                : localCodeChange.status === "starting"
                  ? (localCodeChange.message ??
                    "Cloning the template, installing dependencies, and applying your request.")
                  : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-3 rounded-lg border border-border/70 bg-muted/30 px-3 py-3 text-sm">
          {localCodeChange.status === "error" ? (
            <IconAlertCircle className="size-5 shrink-0 text-destructive" />
          ) : localCodeChange.status === "ready" ? (
            <IconCircleCheck className="size-5 shrink-0 text-primary" />
          ) : (
            <IconLoader2 className="size-5 shrink-0 animate-spin text-muted-foreground" />
          )}
          <span className="text-muted-foreground">
            {localCodeChange.status === "error"
              ? "You can close this and keep working in the current app."
              : localCodeChange.status === "ready"
                ? "Continue prompting to customize the local app."
                : "This usually takes a moment."}
          </span>
        </div>
        {localCodeChange.status === "error" ? (
          <DialogFooter>
            <Button variant="outline" onClick={closeLocalCodeChangeDialog}>
              Close
            </Button>
            {localCodeChangePrompt ? (
              <Button
                onClick={() => void startLocalCodeChange(localCodeChangePrompt)}
              >
                Try again
              </Button>
            ) : null}
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );

  const showChatSidebar = shouldShowDesktopAppChatSidebar({
    apiUrl,
    appAuthState,
    chatEnabled,
    desktopIdentityUnauthenticated,
    desktopIdentityStatus,
  });

  return (
    <DesktopChatRelayAppContext.Provider value={appId}>
      <div
        ref={shellRootRef}
        className="relative flex h-full min-h-0 min-w-0 flex-1 overflow-hidden"
      >
        <MemoryRouter>
          <QueryClientProvider client={desktopChatQueryClient}>
            <AgentSidebar
              enabled={showChatSidebar}
              position="left"
              defaultOpen
              animateDesktop={false}
              openStorageKey="desktop-app-chat"
              storageKey={`desktop-app-chat:${appId}`}
              defaultMode={defaultMode}
              scope={{
                type: "desktop-app",
                id: appId,
                label: appName,
                contextKey: `desktop-app:${appId}`,
              }}
              toggleScopeId={toggleScopeId}
              renderCliTab={
                terminal
                  ? ({ active }) => (
                      <DesktopTerminalTabs
                        agent={terminal.agent}
                        theme={terminal.theme}
                        active={active}
                        activeApp={{
                          id: appId,
                          name: appName,
                          ...(terminal.path ? { path: terminal.path } : {}),
                          ...(terminal.view ? { view: terminal.view } : {}),
                        }}
                      />
                    )
                  : undefined
              }
              onOpenSettings={
                isActive
                  ? onOpenSettings
                    ? openDesktopSettings
                    : undefined
                  : ignoreOpenSettings
              }
              newCliTabLabel="New CLI tab"
              newUiTabLabel="New UI tab"
              chatOnly={false}
              apiUrl={showChatSidebar ? (apiUrl ?? undefined) : undefined}
              isolateHistoryByScope
              agentChatSurface="desktop"
              desktopIdentityUnauthenticated={desktopIdentityUnauthenticated}
              desktopIdentityAuthenticated={desktopIdentityAuthenticated}
              builderConnectTransport={builderConnectTransport}
              showTabBar
              restoreActiveThread={false}
              suppressInlineOpenApp
              dynamicSuggestions={false}
              suggestions={[]}
              emptyStateText={`Ask about ${appName}`}
              composerSlot={
                runtimeNotice || claudeSignIn.status !== "idle" ? (
                  <DesktopRuntimeNotice
                    {...(runtimeNotice
                      ? { message: runtimeNotice.message }
                      : {})}
                    canSignIn={
                      claudeInstalled &&
                      !claudeConfigured &&
                      (runtimeNotice?.canSignIn ?? true)
                    }
                    signIn={claudeSignIn}
                    onSignIn={() => void startClaudeSignIn()}
                    onRetry={() => void recheckLocalAgents()}
                  />
                ) : undefined
              }
              showMissingApiKeySetup={!defaultLocalAgent}
              availableAgents={availableAgents}
              selectedAgent={selectedAgent}
              onAgentChange={handleAgentChange}
              onConnectLocalRuntime={handleLocalRuntimeSetup}
              availableModels={
                localAgentModelsLoading || localAgentModels.length > 0
                  ? availableModels
                  : undefined
              }
              modelListLoading={localAgentModelsLoading}
              runtime={localRuntime}
            >
              {appSurface}
            </AgentSidebar>
          </QueryClientProvider>
        </MemoryRouter>
        {localCodeChangeDialog}
      </div>
    </DesktopChatRelayAppContext.Provider>
  );
}
