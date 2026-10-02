import { DESKTOP_DEFAULT_APPS } from "@shared/app-registry";
import { FOGBREAK_SESSION_PARTITION } from "@shared/fogbreak";
// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./components/AppSettings.js", () => ({
  default: ({ onClose }: { onClose: () => void }) => (
    <button data-testid="close-settings" onClick={onClose}>
      Close
    </button>
  ),
}));
vi.mock("@agent-native/toolkit/ui/toaster", () => ({ Toaster: () => null }));
vi.mock("sonner", () => ({ Toaster: () => null, toast: { error: vi.fn() } }));
import App from "./App.js";

let container: HTMLDivElement;
let root: Root;
let open: (request: DesktopOpenRequest) => void;
let keydown: (input: { key: string }) => void;
let closeTab: () => void;
let api: any;
let executeGuest: ReturnType<typeof vi.fn>;
let nextContentsId = 0;
const ids = new WeakMap<HTMLElement, number>();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  executeGuest = vi.fn(async () => undefined);
  Object.defineProperties(HTMLElement.prototype, {
    getTitle: { configurable: true, value: () => "Fogbreak" },
    executeJavaScript: {
      configurable: true,
      value: executeGuest,
    },
    getURL: {
      configurable: true,
      value: function (this: HTMLElement) {
        return this.getAttribute("src") ?? "";
      },
    },
    getWebContentsId: {
      configurable: true,
      value: function (this: HTMLElement) {
        if (!ids.has(this)) ids.set(this, ++nextContentsId);
        return ids.get(this);
      },
    },
  });
  api = {
    platform: "darwin",
    appConfig: {
      load: vi.fn(async () => DESKTOP_DEFAULT_APPS),
      loadWorkspace: vi.fn(async () => ({
        enabled: true,
        apps: [],
        unavailable: true,
      })),
    },
    identity: {
      getStatus: vi.fn(async () => "idle"),
      onStatusChange: vi.fn(() => () => {}),
      signIn: vi.fn(),
      ensureAppSession: vi.fn(),
      authenticate: vi.fn(),
      requestMagicLink: vi.fn(),
    },
    windowControls: { close: vi.fn() },
    setActiveApp: vi.fn(),
    setActiveWebview: vi.fn(),
    codeAgents: {
      onOpenRequest: vi.fn((callback) => {
        open = callback;
        return () => {};
      }),
    },
    shortcuts: {
      onActivate: vi.fn(() => () => {}),
      onKeydown: vi.fn((callback) => {
        keydown = callback;
        return () => {};
      }),
      onCloseTab: vi.fn((callback) => {
        closeTab = callback;
        return () => {};
      }),
    },
    webviewPreloadPath: "file:///fixture/content-preload.js",
    webviewChatPreloadPath: "file:///fixture/chat-preload.js",
  };
  Object.defineProperty(window, "electronAPI", {
    configurable: true,
    value: api,
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () => root.render(<App />));
}

describe("owned Fogbreak composition with the real registry and AppWebview", () => {
  it("boots the exact hosted root without vendor authentication or provider launch", async () => {
    await render();
    const webview = container.querySelector("webview")!;
    expect(webview.getAttribute("src")).toBe("https://fogbreak.io/");
    expect(webview.getAttribute("partition")).toBe(FOGBREAK_SESSION_PARTITION);
    expect(webview.getAttribute("preload")).toBe(
      "file:///fixture/chat-preload.js",
    );
    expect(webview.getAttribute("webpreferences")).toContain("sandbox=true");
    expect(api.identity.signIn).not.toHaveBeenCalled();
    expect(api.identity.ensureAppSession).not.toHaveBeenCalled();
    expect(api.identity.authenticate).not.toHaveBeenCalled();
    expect(executeGuest.mock.calls.flat().join(" ")).not.toContain(
      '"hosted":true',
    );
    expect(container.querySelectorAll("webview")).toHaveLength(1);
  });
  it("opens genuine Content with the same partition and preserves both views on repeated opens and return", async () => {
    await render();
    const initial = container.querySelector("webview");
    await act(async () => open({ app: "content" }));
    const views = [...container.querySelectorAll("webview")];
    expect(views).toHaveLength(2);
    expect(views[1].getAttribute("src")).toBe("https://fogbreak.io/content");
    expect(views[1].getAttribute("partition")).toBe(FOGBREAK_SESSION_PARTITION);
    expect(views[1].getAttribute("preload")).toBe(
      "file:///fixture/content-preload.js",
    );
    expect(api.setActiveApp).toHaveBeenLastCalledWith("content");
    await act(async () => open({ app: "content" }));
    expect(container.querySelectorAll("webview")[1]).toBe(views[1]);
    await act(async () => closeTab());
    expect(api.setActiveApp).toHaveBeenLastCalledWith("fogbreak");
    expect(container.querySelector("webview")).toBe(initial);
    expect(api.windowControls.close).not.toHaveBeenCalled();
  });
  it("rejects an external open request and leaves the current website unchanged", async () => {
    await render();
    await act(async () =>
      open({ app: "fogbreak", path: "//evil.example/content" }),
    );
    expect(container.querySelector("webview")?.getAttribute("src")).toBe(
      "https://fogbreak.io/",
    );
    expect(container.querySelectorAll("webview")).toHaveLength(1);
  });
  it("reports unavailable inventory and clears the report only on a newer real result", async () => {
    await render();
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "unavailable",
    );
    api.appConfig.loadWorkspace.mockResolvedValue({ enabled: false, apps: [] });
    await act(async () =>
      container.querySelector("webview")!.dispatchEvent(new Event("dom-ready")),
    );
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
  it("keeps the mounted website through settings open and close", async () => {
    await render();
    const webview = container.querySelector("webview");
    await act(async () => keydown({ key: "," }));
    expect(
      container.querySelector('[data-testid="close-settings"]'),
    ).not.toBeNull();
    await act(async () =>
      (
        container.querySelector(
          '[data-testid="close-settings"]',
        ) as HTMLButtonElement
      ).click(),
    );
    expect(container.querySelector("webview")).toBe(webview);
    expect(api.identity.signIn).not.toHaveBeenCalled();
  });
});
