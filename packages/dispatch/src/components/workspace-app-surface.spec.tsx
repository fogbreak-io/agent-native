// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  MemoryRouter,
  useLocation,
  useNavigate,
  type NavigateFunction,
} from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The real Toolkit sidebar, panel, multi-tab controller and thread hook run
// under the real Dispatch rail and keep-alive cache. Only the leaf
// conversation view is replaced: it keeps a draft and an in-flight flag in
// its own state and counts mounts, so any controller remount resets both.
const leaf = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }));
const sidebar = vi.hoisted(() => ({
  onFullscreenRequest: undefined as ((threadId?: string) => void) | undefined,
}));
// React Query's `mutateAsync` is stable across renders, and the frame's
// embed-session effect depends on it: a fresh function per render would
// restart the session on every render.
const embedSession = vi.hoisted(() => ({
  mutateAsync: async () => ({ startUrl: "about:blank" }),
}));
const server = vi.hoisted(() => ({
  threads: new Map<string, { id: string; scope: unknown }>(),
  threadLookups: [] as string[],
}));

vi.mock("@agent-native/toolkit/app/chat/AgentKitAssistantChat", async () => {
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
vi.mock(
  "@agent-native/toolkit/app/chat/AgentSidebar",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@agent-native/toolkit/app/chat/AgentSidebar")
      >();
    return {
      ...actual,
      AgentSidebar: (props: Parameters<typeof actual.AgentSidebar>[0]) => {
        sidebar.onFullscreenRequest = props.onFullscreenRequest;
        return <actual.AgentSidebar {...props} />;
      },
    };
  },
);
vi.mock("@agent-native/toolkit/app/chat/chat-first/app-pane", () => ({
  ChatFirstAppPane: ({
    app,
    embedUrl,
    renderEmbed,
  }: {
    app: { name: string } | null;
    embedUrl?: string | null;
    renderEmbed: (target: { url: string; title?: string }) => React.ReactNode;
  }) => (
    <div data-app-pane>
      {embedUrl ? renderEmbed({ url: embedUrl, title: app?.name }) : null}
    </div>
  ),
}));
vi.mock("@agent-native/core/client/feature-flags", () => ({
  useFeatureFlag: () => false,
}));
vi.mock("@agent-native/core/client/app-config", () => ({
  injectedAgentNativeConfig: () => ({ harness: undefined }),
}));
vi.mock("@agent-native/core/client/onboarding", () => ({
  isFirstRunOnboardingEnabled: () => false,
  useFirstRunOnboardingGateOwnsSurface: () => false,
  useOnboardingPreviewMode: () => false,
}));
vi.mock("@agent-native/core/client/hooks", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@agent-native/core/client/hooks")>();
  return {
    ...actual,
    useActionQuery: ((name: string, ...rest: unknown[]) =>
      name === "list-workspace-apps"
        ? {
            data: [
              {
                id: "mail",
                name: "Mail",
                path: "/mail",
                url: null,
                status: "ready",
              },
            ],
            isError: false,
            isLoading: false,
            refetch: vi.fn(),
          }
        : (actual.useActionQuery as (...args: unknown[]) => unknown)(
            name,
            ...rest,
          )) as typeof actual.useActionQuery,
    useActionMutation: ((name: string, ...rest: unknown[]) =>
      name === "create_embed_session" ||
      name === "create-workspace-app-embed-session"
        ? embedSession
        : (actual.useActionMutation as (...args: unknown[]) => unknown)(
            name,
            ...rest,
          )) as typeof actual.useActionMutation,
  };
});

import { WorkspaceAppSurface } from "./workspace-app-surface";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let navigateRef: NavigateFunction | null = null;
let locationRef: { pathname: string; search: string } | null = null;

function Harness() {
  const location = useLocation();
  const navigate = useNavigate();
  navigateRef = navigate;
  locationRef = location;
  const routeMatch = location.pathname.match(/^\/apps\/([^/]+)/);
  return (
    <WorkspaceAppSurface
      location={location}
      routeAppId={routeMatch ? decodeURIComponent(routeMatch[1]!) : null}
      apps={[{ id: "mail", name: "Mail" }]}
      appsStatus="ready"
      appsErrorMessage="Apps could not load"
      onRetryApps={() => undefined}
      navigate={(path, options) => void navigate(path, options)}
    />
  );
}

describe("WorkspaceAppSurface app-chat full view (production composition)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    leaf.mounts = 0;
    leaf.unmounts = 0;
    sidebar.onFullscreenRequest = undefined;
    server.threads.clear();
    server.threadLookups = [];
    window.localStorage.clear();
    window.sessionStorage.clear();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = new URL(String(input), "https://dispatch.test");
        const match = url.pathname.match(
          /\/_agent-native\/workspace-app-chat\/mail\/threads\/([^/]+)$/,
        );
        if (match) {
          const id = decodeURIComponent(match[1]!);
          server.threadLookups.push(id);
          const thread = server.threads.get(id);
          // The app's agent chat answers missing, unreadable and
          // other-scope threads with the same 404.
          return thread
            ? json(thread)
            : json({ error: "Thread not found" }, 404);
        }
        if (url.pathname.endsWith("/threads")) return json({ threads: [] });
        return json({});
      }),
    );
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    navigateRef = null;
    locationRef = null;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function flush() {
    await act(async () => {
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
  }

  async function mount(entry: string) {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={[entry]}>
            <Harness />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await flush();
  }

  async function go(path: string) {
    await act(async () => {
      void navigateRef?.(path);
    });
    await flush();
  }

  function surfaceState() {
    return container
      .querySelector("[data-dispatch-workspace-app-surface]")
      ?.getAttribute("data-dispatch-app-chat-full-view");
  }

  it("presents the same live controller, draft, run and retained frame through full view and back", async () => {
    await mount("/apps/mail/inbox?filter=unread");
    const leafBefore = container.querySelector('[data-testid="leaf-chat"]');
    expect(leafBefore).not.toBeNull();
    const threadId = leafBefore?.getAttribute("data-thread-id") ?? "";
    expect(threadId).toBeTruthy();
    const frame = container.querySelector("iframe");
    expect(frame).not.toBeNull();

    await act(async () => {
      const textarea = container.querySelector("textarea");
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, "half-written message");
      textarea?.dispatchEvent(new Event("input", { bubbles: true }));
      container
        .querySelector<HTMLButtonElement>('[data-testid="leaf-chat"] button')
        ?.click();
    });
    // The rail controller hands off its own active thread.
    await act(async () => sidebar.onFullscreenRequest?.(threadId));
    await flush();

    expect(locationRef?.pathname).toBe(`/chat/${threadId}`);
    expect(new URLSearchParams(locationRef?.search).get("appChat")).toBe(
      "mail",
    );
    expect(new URLSearchParams(locationRef?.search).get("appReturn")).toBe(
      "/inbox?filter=unread",
    );
    expect(surfaceState()).toBe("ready");
    // A thread the live controller produced needs no server round trip,
    // even an unsaved draft.
    expect(server.threadLookups).toEqual([]);
    expect(
      container
        .querySelector(".agent-sidebar-panel")
        ?.getAttribute("data-agent-sidebar-presentation"),
    ).toBe("full");
    expect(container.querySelector('[data-testid="leaf-chat"]')).toBe(
      leafBefore,
    );
    expect(container.querySelector("textarea")?.value).toBe(
      "half-written message",
    );
    expect(
      container.querySelector('[data-testid="running"]')?.textContent,
    ).toBe("yes");
    expect(container.querySelector("iframe")).toBe(frame);

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>("[data-dispatch-app-chat-back]")
        ?.click();
    });
    await flush();

    expect(locationRef?.pathname).toBe("/apps/mail/inbox");
    expect(locationRef?.search).toBe("?filter=unread");
    expect(
      container
        .querySelector(".agent-sidebar-panel")
        ?.getAttribute("data-agent-sidebar-presentation"),
    ).toBe("sidebar");
    expect(container.querySelector("iframe")).toBe(frame);
    expect(container.querySelector('[data-testid="leaf-chat"]')).toBe(
      leafBefore,
    );
    expect(
      container
        .querySelector('[data-testid="leaf-chat"]')
        ?.getAttribute("data-thread-id"),
    ).toBe(threadId);
    expect(container.querySelector("textarea")?.value).toBe(
      "half-written message",
    );
    expect(leaf.mounts).toBe(1);
    expect(leaf.unmounts).toBe(0);
  });

  it("re-checks a thread the controller did not produce and shows an opaque denial on 404", async () => {
    await mount("/apps/mail");
    const leafBefore = container.querySelector('[data-testid="leaf-chat"]');
    const threadId = leafBefore?.getAttribute("data-thread-id") ?? "";
    await act(async () => sidebar.onFullscreenRequest?.(threadId));
    await flush();
    expect(surfaceState()).toBe("ready");

    // An external navigation (agent command, back/forward) to another thread.
    await go("/chat/someone-elses?appChat=mail&appReturn=%2F");
    expect(server.threadLookups).toEqual(["someone-elses"]);
    expect(surfaceState()).toBe("unavailable");
    expect(
      container
        .querySelector("[data-dispatch-app-chat-unavailable-reason]")
        ?.getAttribute("data-dispatch-app-chat-unavailable-reason"),
    ).toBe("thread");
    // The live controller is not pointed at the unresolved thread.
    expect(container.querySelector('[data-testid="leaf-chat"]')).toBe(
      leafBefore,
    );
    expect(
      container
        .querySelector('[data-testid="leaf-chat"]')
        ?.getAttribute("data-thread-id"),
    ).toBe(threadId);
    expect(leaf.unmounts).toBe(0);
  });

  it("opens a deep-linked thread only after the app's access check finds it", async () => {
    server.threads.set("t-real", {
      id: "t-real",
      scope: { type: "workspace-app", id: "mail" },
    });
    await mount("/chat/t-real?appChat=mail&appReturn=%2Finbox");
    expect(server.threadLookups).toEqual(["t-real"]);
    expect(surfaceState()).toBe("ready");
    // The controller keeps its own hidden draft tab; the visible tab is the
    // route's thread.
    const activeLeaf = [
      ...container.querySelectorAll<HTMLElement>('[data-testid="leaf-chat"]'),
    ].find((element) => element.parentElement?.style.display !== "none");
    expect(activeLeaf?.getAttribute("data-thread-id")).toBe("t-real");
  });

  it("does not trust a draft id after a reload: it re-resolves and is unavailable", async () => {
    await mount("/chat/old-draft?appChat=mail&appReturn=%2F");
    expect(server.threadLookups).toEqual(["old-draft"]);
    expect(surfaceState()).toBe("unavailable");
  });

  it("refuses an app outside the registry without opening any chat", async () => {
    await mount("/chat/t1?appChat=calendar&appReturn=%2F");
    expect(surfaceState()).toBe("unavailable");
    expect(
      container
        .querySelector("[data-dispatch-app-chat-unavailable-reason]")
        ?.getAttribute("data-dispatch-app-chat-unavailable-reason"),
    ).toBe("app");
    expect(container.querySelector('[data-testid="leaf-chat"]')).toBeNull();
    expect(server.threadLookups).toEqual([]);
  });
});
