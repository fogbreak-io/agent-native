// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  surfaceProps: null as Record<string, unknown> | null,
  apps: [{ id: "mail", name: "Mail", path: "/mail", status: "ready" }] as Array<
    Record<string, unknown>
  >,
  fetchImpl: vi.fn(),
}));

vi.mock("@agent-native/toolkit/app/chat/AgentChatHome", () => ({
  AgentChatHome: (props: Record<string, unknown>) => {
    state.surfaceProps = props;
    return <div data-agent-chat-home />;
  },
}));

vi.mock("@agent-native/toolkit/app/chat/chat-first-copy", () => ({
  defaultChatFirstCopy: (key: string) => key,
}));

vi.mock("@agent-native/core/client/api-path", () => ({
  agentNativePath: (path: string) => path,
}));

vi.mock("@agent-native/core/client/hooks", () => ({
  useActionQuery: () => ({
    data: state.apps,
    error: null,
    isError: false,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

vi.mock("@agent-native/core/client/i18n", () => ({
  useT: () => (key: string, values?: { defaultValue?: string }) =>
    values?.defaultValue ?? key,
}));

vi.mock("./layout/Layout", () => ({
  dispatchNavLinkTarget: (path: string) => path,
}));

import type { WorkspaceAppChatHandoff } from "../lib/workspace-app-chat-handoff";
import { WorkspaceAppChatFullView } from "./workspace-app-chat-full-view";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("WorkspaceAppChatFullView", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    state.surfaceProps = null;
    state.apps = [{ id: "mail", name: "Mail", path: "/mail", status: "ready" }];
    state.fetchImpl.mockReset();
    vi.stubGlobal("fetch", state.fetchImpl);
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

  function routeFetch(threadResponse: Response) {
    state.fetchImpl.mockImplementation(async (url: string) =>
      url.endsWith("/mode") ? json(200, {}) : threadResponse.clone(),
    );
  }

  async function render(
    handoff: WorkspaceAppChatHandoff,
    entryState?: unknown,
  ) {
    await act(async () => {
      root.render(
        <MemoryRouter
          initialEntries={[{ pathname: "/chat", state: entryState ?? null }]}
        >
          <WorkspaceAppChatFullView handoff={handoff} />
        </MemoryRouter>,
      );
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });
  }

  const handoff: WorkspaceAppChatHandoff = {
    appId: "mail",
    threadId: "t1",
    returnTarget: { appId: "mail", path: "/inbox/5" },
  };

  function fullViewState() {
    return container
      .querySelector("[data-dispatch-app-chat-full-view]")
      ?.getAttribute("data-dispatch-app-chat-full-view");
  }

  it("opens the same app-scoped session the rail uses, on the resolved thread", async () => {
    routeFetch(
      json(200, { id: "t1", scope: { type: "workspace-app", id: "mail" } }),
    );
    await render(handoff);

    expect(fullViewState()).toBe("ready");
    expect(state.surfaceProps).toMatchObject({
      apiUrl: "/_agent-native/workspace-app-chat/mail",
      storageKey: "dispatch-app-chat:mail",
      scope: {
        type: "workspace-app",
        id: "mail",
        contextKey: "workspace-app:mail",
      },
      isolateHistoryByScope: true,
      agentChatSurface: "app",
    });
    const sync = state.surfaceProps?.threadUrlSync as {
      routeThreadId: string | null;
      getPath: (threadId: string | null) => string;
    };
    expect(sync.routeThreadId).toBe("t1");
    expect(sync.getPath("t2")).toBe(
      "/chat/t2?appChat=mail&appReturn=%2Finbox%2F5",
    );
    expect(
      container
        .querySelector("[data-dispatch-app-chat-back]")
        ?.getAttribute("href"),
    ).toBe("/apps/mail/inbox/5");
  });

  it("shows an explicit unavailable state for a thread it cannot resolve", async () => {
    routeFetch(new Response("", { status: 404 }));
    await render(handoff);

    expect(fullViewState()).toBe("unavailable");
    expect(
      container
        .querySelector("[data-dispatch-app-chat-unavailable-reason]")
        ?.getAttribute("data-dispatch-app-chat-unavailable-reason"),
    ).toBe("thread-not-found");
    expect(state.surfaceProps).toBeNull();
    expect(container.querySelector("[data-dispatch-app-chat-back]")).not.toBe(
      null,
    );
  });

  it("accepts the live rail's unsaved draft thread from the same tab", async () => {
    routeFetch(new Response("", { status: 404 }));
    await render(handoff, { dispatchAppChatEntry: { threadId: "t1" } });

    expect(fullViewState()).toBe("ready");
    expect(
      (state.surfaceProps?.threadUrlSync as { routeThreadId: string })
        .routeThreadId,
    ).toBe("t1");
  });

  it("never accepts a forbidden or other-scope thread, even from the rail", async () => {
    routeFetch(new Response("", { status: 403 }));
    await render(handoff, { dispatchAppChatEntry: { threadId: "t1" } });
    expect(fullViewState()).toBe("unavailable");

    act(() => root.unmount());
    root = createRoot(container);
    routeFetch(json(200, { id: "t1", scope: { type: "agent", id: "x" } }));
    await render(handoff, { dispatchAppChatEntry: { threadId: "t1" } });
    expect(fullViewState()).toBe("unavailable");
    expect(state.surfaceProps).toBeNull();
  });

  it("does not open any chat for an app the user cannot reach", async () => {
    state.apps = [];
    routeFetch(json(200, {}));
    await render({ ...handoff, threadId: undefined });

    expect(fullViewState()).toBe("unavailable");
    expect(state.surfaceProps).toBeNull();
    expect(state.fetchImpl).not.toHaveBeenCalled();
  });

  it("starts a new app conversation when the handoff has no thread", async () => {
    routeFetch(json(200, {}));
    await render({ ...handoff, threadId: undefined });

    expect(fullViewState()).toBe("ready");
    expect(
      (state.surfaceProps?.threadUrlSync as { routeThreadId: string | null })
        .routeThreadId,
    ).toBeNull();
    expect(state.fetchImpl).toHaveBeenCalledTimes(1);
  });
});
