// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Only the leaf conversation view is replaced, so the real sidebar, panel,
// multi-tab controller and thread hook run. The stand-in keeps a draft and an
// in-flight flag in its own state and counts its mounts: any remount anywhere
// above it would reset both and bump the count.
const leaf = vi.hoisted(() => ({
  mounts: 0,
  unmounts: 0,
  threadIds: [] as string[],
}));

vi.mock("./AgentKitAssistantChat.js", async () => {
  const React = await import("react");
  return {
    AgentKitAssistantChat: React.forwardRef(function LeafChat(
      props: { threadId?: string },
      ref,
    ) {
      const [draft, setDraft] = React.useState("");
      const [running, setRunning] = React.useState(false);
      React.useEffect(() => {
        leaf.mounts += 1;
        return () => {
          leaf.unmounts += 1;
        };
      }, []);
      if (props.threadId) leaf.threadIds.push(props.threadId);
      React.useImperativeHandle(ref, () => ({
        sendMessage: async () => ({ status: "submitted" as const }),
        implementPlan: () => false,
        prefillMessage: () => undefined,
        setComposerContextItem: () => undefined,
        removeComposerContextItem: () => undefined,
        clearComposerContextItems: () => undefined,
        sendRecoveryMessage: () => undefined,
        queueMessage: () => undefined,
        isRunning: () => running,
        hasInFlightWork: () => running,
        focusComposer: () => undefined,
        exportThreadSnapshot: () => null,
      }));
      return (
        <div data-testid="leaf-chat" data-thread-id={props.threadId}>
          <textarea
            aria-label="Draft"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button type="button" onClick={() => setRunning(true)}>
            run
          </button>
          <span data-testid="running">{running ? "yes" : "no"}</span>
        </div>
      );
    }),
  };
});
vi.mock("@agent-native/core/client/app-config", () => ({
  injectedAgentNativeConfig: () => ({ harness: undefined }),
}));
vi.mock("@agent-native/core/client/onboarding", () => ({
  isFirstRunOnboardingEnabled: () => false,
  useFirstRunOnboardingGateOwnsSurface: () => false,
  useOnboardingPreviewMode: () => false,
}));
vi.mock("@agent-native/core/client/host", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@agent-native/core/client/host")>();
  return {
    ...actual,
    getFramePostMessageTargetOrigin: () => null,
    isTrustedFrameMessage: () => true,
    shouldParentFrameOwnAgentPanel: () => false,
  };
});

import { AgentSidebar } from "./AgentSidebar.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("AgentSidebar full-surface presentation", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    leaf.mounts = 0;
    leaf.unmounts = 0;
    leaf.threadIds = [];
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes("/threads")) return jsonResponse({ threads: [] });
        return jsonResponse({});
      }),
    );
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function render(presentation: "sidebar" | "full") {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <AgentSidebar
              position="left"
              defaultOpen
              storageKey="presentation-test"
              apiUrl="/proxy"
              scope={{ type: "workspace-app", id: "mail", label: "Mail" }}
              isolateHistoryByScope
              presentation={presentation}
              onFullscreenRequest={() => undefined}
            >
              <iframe data-testid="app-frame" title="app" />
            </AgentSidebar>
          </MemoryRouter>
        </QueryClientProvider>,
      );
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });
  }

  it("keeps the same live controller, draft and in-flight state across sidebar → full → sidebar", async () => {
    await render("sidebar");
    const leafBefore = container.querySelector('[data-testid="leaf-chat"]');
    expect(leafBefore).not.toBeNull();
    const threadBefore = leafBefore?.getAttribute("data-thread-id");
    expect(threadBefore).toBeTruthy();
    const frame = container.querySelector('[data-testid="app-frame"]');

    const textarea = container.querySelector("textarea");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(textarea, "half-written message");
      textarea?.dispatchEvent(new Event("input", { bubbles: true }));
      container
        .querySelector<HTMLButtonElement>('[data-testid="leaf-chat"] button')
        ?.click();
    });
    expect(container.querySelector("textarea")?.value).toBe(
      "half-written message",
    );

    await render("full");
    const panel = container.querySelector<HTMLElement>(".agent-sidebar-panel");
    expect(panel?.getAttribute("data-agent-sidebar-presentation")).toBe("full");
    const main = container.querySelector<HTMLElement>(
      ".agent-sidebar-main-surface",
    );
    expect(main?.style.display).toBe("none");
    // The app frame is hidden, not unmounted.
    expect(container.querySelector('[data-testid="app-frame"]')).toBe(frame);
    expect(container.querySelector('[data-testid="leaf-chat"]')).toBe(
      leafBefore,
    );
    expect(container.querySelector("textarea")?.value).toBe(
      "half-written message",
    );
    expect(
      container.querySelector('[data-testid="running"]')?.textContent,
    ).toBe("yes");
    expect(
      container.querySelector("[data-agent-fullscreen='true']"),
    ).not.toBeNull();

    await render("sidebar");
    expect(main?.style.display).toBe("");
    expect(container.querySelector('[data-testid="leaf-chat"]')).toBe(
      leafBefore,
    );
    expect(
      container
        .querySelector('[data-testid="leaf-chat"]')
        ?.getAttribute("data-thread-id"),
    ).toBe(threadBefore);
    expect(container.querySelector("textarea")?.value).toBe(
      "half-written message",
    );
    expect(leaf.mounts).toBe(1);
    expect(leaf.unmounts).toBe(0);
  });

  it("mounts the panel in full presentation even when the sidebar was closed", async () => {
    window.localStorage.setItem("agent-native-sidebar-open", "false");
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <AgentSidebar
              position="left"
              defaultOpen={false}
              storageKey="presentation-closed"
              apiUrl="/proxy"
              presentation="full"
            >
              <div data-testid="app-content" />
            </AgentSidebar>
          </MemoryRouter>
        </QueryClientProvider>,
      );
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="leaf-chat"]')).not.toBeNull();
    expect(
      container
        .querySelector(".agent-sidebar-panel")
        ?.getAttribute("data-agent-sidebar-state"),
    ).toBe("open");
  });
});
