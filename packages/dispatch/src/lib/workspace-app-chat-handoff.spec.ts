import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildWorkspaceAppChatFullViewPath,
  parseWorkspaceAppChatFullViewLocation,
  resolveWorkspaceAppChatThread,
  workspaceAppChatReturnRoute,
} from "./workspace-app-chat-handoff";
import { workspaceAppLocalPathFromRoute } from "./workspace-apps";

describe("workspace app chat full-view route", () => {
  it("round-trips the app, its thread, and the exact app-local return route", () => {
    const path = buildWorkspaceAppChatFullViewPath({
      appId: "mail",
      threadId: "thread-1",
      returnTarget: { appId: "mail", path: "/inbox/5?filter=unread#top" },
    });
    expect(path).not.toBeNull();
    const url = new URL(path!, "https://dispatch.test");
    expect(url.pathname).toBe("/chat/thread-1");

    const parsed = parseWorkspaceAppChatFullViewLocation(
      url.pathname,
      url.search,
    );
    expect(parsed).toEqual({
      kind: "app",
      handoff: {
        appId: "mail",
        threadId: "thread-1",
        returnTarget: { appId: "mail", path: "/inbox/5?filter=unread#top" },
      },
    });
    if (parsed.kind !== "app") throw new Error("expected an app handoff");
    expect(workspaceAppChatReturnRoute(parsed.handoff)).toBe(
      "/apps/mail/inbox/5?filter=unread#top",
    );
  });

  it("encodes a new conversation without a thread", () => {
    const path = buildWorkspaceAppChatFullViewPath({
      appId: "mail",
      returnTarget: { appId: "mail", path: "/" },
    });
    const url = new URL(path!, "https://dispatch.test");
    expect(url.pathname).toBe("/chat");
    const parsed = parseWorkspaceAppChatFullViewLocation(
      url.pathname,
      url.search,
    );
    expect(parsed).toEqual({
      kind: "app",
      handoff: { appId: "mail", returnTarget: { appId: "mail", path: "/" } },
    });
  });

  it("leaves global and custom-agent chat routes alone", () => {
    expect(parseWorkspaceAppChatFullViewLocation("/chat/t1", "")).toEqual({
      kind: "none",
    });
    expect(
      parseWorkspaceAppChatFullViewLocation("/chat", "?agent=agents%2Fops.md"),
    ).toEqual({ kind: "none" });
  });

  it.each([
    ["//evil.example/path"],
    ["https://evil.example/path"],
    ["javascript:alert(1)"],
    ["relative/path"],
    ["/bad\u0000path"],
    [""],
  ])("refuses a return route that is not app-local: %j", (returnPath) => {
    expect(
      buildWorkspaceAppChatFullViewPath({
        appId: "mail",
        returnTarget: { appId: "mail", path: returnPath },
      }),
    ).toBeNull();
    const params = new URLSearchParams({
      appChat: "mail",
      appReturn: returnPath,
    });
    expect(
      parseWorkspaceAppChatFullViewLocation("/chat", `?${params}`),
    ).toEqual({ kind: "invalid" });
  });

  it("refuses a return target for a different app", () => {
    expect(
      buildWorkspaceAppChatFullViewPath({
        appId: "mail",
        returnTarget: { appId: "calendar", path: "/" },
      }),
    ).toBeNull();
  });

  it("reports a malformed handoff as invalid instead of global chat", () => {
    expect(
      parseWorkspaceAppChatFullViewLocation("/chat", "?appChat=&appReturn=/"),
    ).toEqual({ kind: "invalid" });
    expect(
      parseWorkspaceAppChatFullViewLocation(
        "/chat/%E0%A4%A",
        "?appChat=mail&appReturn=/",
      ),
    ).toEqual({ kind: "invalid" });
    expect(
      parseWorkspaceAppChatFullViewLocation(
        "/chat/a/b",
        "?appChat=mail&appReturn=/",
      ),
    ).toEqual({ kind: "invalid" });
  });
});

describe("workspaceAppLocalPathFromRoute", () => {
  it("reads the app-local route from a Dispatch app route", () => {
    expect(
      workspaceAppLocalPathFromRoute("mail", "/apps/mail/inbox/5", "?a=1", ""),
    ).toBe("/inbox/5?a=1");
    expect(workspaceAppLocalPathFromRoute("Mail", "/apps/mail", "", "")).toBe(
      "/",
    );
    expect(
      workspaceAppLocalPathFromRoute("mail", "/apps/calendar/x", "", ""),
    ).toBeNull();
  });
});

describe("resolveWorkspaceAppChatThread", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(response: Response | Error) {
    const fetchMock = vi.fn(async () => {
      if (response instanceof Error) throw response;
      return response;
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("asks the app's own agent through the proxy with the app scope", async () => {
    const fetchMock = stubFetch(
      new Response(
        JSON.stringify({
          id: "t1",
          scope: { type: "workspace-app", id: "mail" },
        }),
        { status: 200 },
      ),
    );
    await expect(
      resolveWorkspaceAppChatThread(
        "/_agent-native/workspace-app-chat/mail",
        "mail",
        "t1",
      ),
    ).resolves.toEqual({ status: "found" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/_agent-native/workspace-app-chat/mail/threads/t1?scopeType=workspace-app&scopeId=mail",
      { credentials: "include" },
    );
  });

  it("treats the server's single 404 as an opaque not-found", async () => {
    // The app's agent chat answers missing, unreadable and other-scope
    // threads with the same 404; the client must not claim to know which.
    stubFetch(
      new Response(JSON.stringify({ error: "Thread not found" }), {
        status: 404,
      }),
    );
    await expect(
      resolveWorkspaceAppChatThread("/p", "mail", "t1"),
    ).resolves.toEqual({ status: "not-found" });
  });

  it("reports proxy session and transport failures as retryable, not as thread denial", async () => {
    for (const status of [401, 403, 502, 503]) {
      stubFetch(new Response("", { status }));
      await expect(
        resolveWorkspaceAppChatThread("/p", "mail", "t1"),
      ).resolves.toMatchObject({ status: "unavailable" });
    }

    stubFetch(new Error("offline"));
    await expect(
      resolveWorkspaceAppChatThread("/p", "mail", "t1"),
    ).resolves.toMatchObject({ status: "unavailable" });

    stubFetch(new Response(JSON.stringify({ id: "t2" }), { status: 200 }));
    await expect(
      resolveWorkspaceAppChatThread("/p", "mail", "t1"),
    ).resolves.toMatchObject({ status: "unavailable" });
  });
});
