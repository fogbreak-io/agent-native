import { Toaster as ToastToaster } from "@agent-native/toolkit/ui/toaster";
import {
  DESKTOP_DEFAULT_APPS,
  toAppDefinition,
  type AppConfig,
} from "@shared/app-registry";
import { isDesktopSettingsShortcut } from "@shared/desktop-shortcuts";
import {
  FOGBREAK_APP_ID,
  FOGBREAK_SESSION_PARTITION,
  resolveFogbreakOpenUrl,
} from "@shared/fogbreak";
import { useCallback, useEffect, useRef, useState } from "react";
import { Toaster, toast } from "sonner";

import type {
  DesktopIdentityStatus,
  DesktopWorkspaceAppListResult,
} from "../../shared/ipc-channels.js";
import AppSettings from "./components/AppSettings.js";
import AppWebview, {
  rememberDesktopIdentityStatus,
} from "./components/AppWebview.js";
import DesktopIdentityGate from "./components/DesktopIdentityGate.js";
import WindowControls, {
  CollapsedMacWindowControls,
} from "./components/WindowControls.js";
import { useRendererTheme } from "./lib/theme.js";

// The hosted website owns navigation, auth, actions and UI. These slots only
// preserve Native's registered app identity and session across explicit opens.
export default function App() {
  const theme = useRendererTheme();
  const [apps, setApps] = useState<AppConfig[]>([]);
  const [loadError, setLoadError] = useState<string>();
  const [activeAppId, setActiveAppId] = useState(FOGBREAK_APP_ID);
  const [views, setViews] = useState<
    Record<string, { url: string; nonce: number }>
  >({
    [FOGBREAK_APP_ID]: { url: DESKTOP_DEFAULT_APPS[0].url, nonce: 0 },
  });
  const [desktopIdentityStatus, setDesktopIdentityStatus] = useState<
    DesktopIdentityStatus | "checking"
  >("idle");
  const [workspaceAppList, setWorkspaceAppList] =
    useState<DesktopWorkspaceAppListResult>();
  const inventoryGeneration = useRef(0);
  const openNonce = useRef(0);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState("general");
  const [refreshKey, setRefreshKey] = useState(0);
  const [pendingOpenRequest, setPendingOpenRequest] =
    useState<DesktopOpenRequest | null>(null);
  const [pendingShortcut, setPendingShortcut] =
    useState<DesktopShortcutActivationRequest | null>(null);

  const refreshWorkspaceApps = useCallback(async () => {
    const loader = window.electronAPI?.appConfig?.loadWorkspace;
    if (!loader) return;
    const generation = ++inventoryGeneration.current;
    try {
      const result = await loader();
      if (generation === inventoryGeneration.current)
        setWorkspaceAppList(result);
    } catch (error) {
      if (generation === inventoryGeneration.current)
        setWorkspaceAppList({ enabled: true, apps: [], unavailable: true });
      console.warn("[fogbreak] workspace inventory unavailable", error);
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    const load = window.electronAPI?.appConfig?.load;
    void (load ? load() : Promise.resolve(DESKTOP_DEFAULT_APPS))
      .then((loaded) => {
        if (mounted) setApps(loaded);
      })
      .catch((error) => {
        if (mounted)
          setLoadError(
            error instanceof Error
              ? error.message
              : "Unable to load desktop settings",
          );
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    void refreshWorkspaceApps();
    const identity = window.electronAPI?.identity;
    if (!identity) return;
    let mounted = true;
    const onStatus = (status: DesktopIdentityStatus) => {
      if (!mounted) return;
      rememberDesktopIdentityStatus(status);
      setDesktopIdentityStatus(status);
    };
    const unsubscribe = identity.onStatusChange(onStatus);
    void identity
      .getStatus()
      .then(onStatus)
      .catch((error) => {
        // A failed preference/IPC read is not a request for vendor authentication.
        if (mounted)
          setLoadError(
            error instanceof Error
              ? error.message
              : "Unable to load desktop identity settings",
          );
      });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [refreshWorkspaceApps]);

  const handleDesktopOpenRequest = useCallback(
    (request: DesktopOpenRequest): boolean => {
      const appId = request.app ?? FOGBREAK_APP_ID;
      const target = apps.find(
        (candidate) => candidate.id === appId && candidate.enabled,
      );
      if (!target || appId === "dispatch") return false;
      const url = resolveFogbreakOpenUrl(target, request.path);
      if (!url) return false;
      const nonce = ++openNonce.current;
      setViews((current) => ({
        ...current,
        [appId]:
          !request.path && current[appId] ? current[appId] : { url, nonce },
      }));
      setActiveAppId(appId);
      window.electronAPI?.setActiveApp?.(appId);
      setShowSettings(false);
      return true;
    },
    [apps],
  );

  useEffect(() => {
    window.electronAPI?.setActiveApp?.(activeAppId);
  }, [activeAppId]);

  useEffect(() => {
    const bridge = {
      getActiveAppId: () => activeAppId,
      activate: (
        request: DesktopShortcutActivationRequest,
      ): DesktopShortcutActivationResult => {
        const handled = handleDesktopOpenRequest(request);
        return {
          handled,
          ...(handled ? { appId: request.app } : {}),
          activeAppId: handled ? request.app : activeAppId,
        };
      },
    };
    window.__agentNativeDesktopShortcutBridge = bridge;
    return () => {
      if (window.__agentNativeDesktopShortcutBridge === bridge)
        delete window.__agentNativeDesktopShortcutBridge;
    };
  }, [activeAppId, handleDesktopOpenRequest]);

  useEffect(
    () =>
      window.electronAPI?.codeAgents?.onOpenRequest?.(setPendingOpenRequest),
    [],
  );
  useEffect(
    () => window.electronAPI?.shortcuts?.onActivate?.(setPendingShortcut),
    [],
  );
  useEffect(
    () =>
      window.electronAPI?.shortcuts?.onCloseTab?.(() => {
        if (activeAppId !== FOGBREAK_APP_ID)
          handleDesktopOpenRequest({ app: FOGBREAK_APP_ID });
        else window.electronAPI?.windowControls.close();
      }),
    [activeAppId, handleDesktopOpenRequest],
  );

  useEffect(() => {
    if (!pendingOpenRequest || !apps.length) return;
    if (!handleDesktopOpenRequest(pendingOpenRequest))
      toast.error("This destination is unavailable in Fogbreak");
    setPendingOpenRequest(null);
  }, [apps, pendingOpenRequest, handleDesktopOpenRequest]);

  useEffect(() => {
    if (!pendingShortcut || !apps.length) return;
    if (handleDesktopOpenRequest(pendingShortcut)) {
      window.electronAPI?.shortcuts?.ackActivation(
        pendingShortcut.requestId,
        pendingShortcut.app,
      );
    }
    setPendingShortcut(null);
  }, [apps, pendingShortcut, handleDesktopOpenRequest]);

  useEffect(
    () =>
      window.electronAPI?.shortcuts?.onKeydown?.((input) => {
        if (
          isDesktopSettingsShortcut({
            key: input.key,
            code: input.code,
            shift: input.shiftKey,
            alt: input.altKey,
          })
        ) {
          setSettingsTab("general");
          setShowSettings(true);
        }
      }),
    [],
  );

  return (
    <div className="shell fogbreak-shell">
      <div className="fogbreak-titlebar" aria-label="Fogbreak">
        <WindowControls className="win-controls desktop-chat-first-window-controls" />
        {window.electronAPI?.platform === "darwin" ? (
          <CollapsedMacWindowControls className="desktop-chat-first-mac-window-controls" />
        ) : null}
      </div>
      {loadError ? <div role="alert">{loadError}</div> : null}
      {workspaceAppList?.unavailable ? (
        <div className="fogbreak-inventory-status" role="status">
          Workspace app inventory is unavailable
        </div>
      ) : null}
      <div className="shell-body">
        <div className="content-area content-area--chat-first">
          {apps
            .filter((app) => app.enabled && views[app.id])
            .map((app) => (
              <AppWebview
                key={app.id}
                app={toAppDefinition(app)}
                appConfig={app}
                sourceUrl={views[app.id].url}
                urlOpenNonce={views[app.id].nonce}
                partitionKey={FOGBREAK_SESSION_PARTITION}
                isActive={activeAppId === app.id && !showSettings}
                surfaceHidden={showSettings}
                theme={theme}
                syncTheme={false}
                syncAppChatSidebar={false}
                refreshKey={refreshKey}
                onAuthStateChange={() => void refreshWorkspaceApps()}
                onAppsChanged={setApps}
              />
            ))}
        </div>
        <DesktopIdentityGate
          appName="Fogbreak"
          status={desktopIdentityStatus}
          onSignIn={() => window.electronAPI?.identity?.signIn() ?? false}
          onAuthenticate={(request) =>
            window.electronAPI?.identity?.authenticate(request) ??
            Promise.resolve({
              ok: false,
              error: "The desktop identity surface is unavailable.",
            })
          }
          onMagicLink={(request) =>
            window.electronAPI?.identity?.requestMagicLink(request) ??
            Promise.resolve({
              ok: false,
              error: "The desktop identity surface is unavailable.",
            })
          }
        />
      </div>
      {showSettings ? (
        <AppSettings
          key={settingsTab}
          apps={apps}
          initialTab={settingsTab}
          onClose={() => setShowSettings(false)}
          onAppsChanged={setApps}
          onCodeAgentProvidersChanged={() =>
            setRefreshKey((current) => current + 1)
          }
        />
      ) : null}
      <Toaster
        theme="system"
        position="bottom-center"
        offset={20}
        closeButton
        visibleToasts={1}
      />
      <ToastToaster />
    </div>
  );
}
