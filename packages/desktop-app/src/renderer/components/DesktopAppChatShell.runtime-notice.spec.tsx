// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import DesktopAppChatShell from "./DesktopAppChatShell.js";

type PanelProps = {
  selectedAgent: string;
  availableAgents: unknown[];
  composerSlot?: React.ReactNode;
  onConnectLocalRuntime: (agent: string) => void;
  children: React.ReactNode;
};

vi.mock("@agent-native/toolkit/app/chat", () => ({
  AgentChatMemoryRouter: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  AgentSidebar: (props: PanelProps) => (
    <div>
      <span data-testid="selected">{props.selectedAgent}</span>
      <pre data-testid="agents">{JSON.stringify(props.availableAgents)}</pre>
      <button
        type="button"
        data-testid="pick-claude-row"
        onClick={() => props.onConnectLocalRuntime("claude-code")}
      />
      <div data-testid="footer">{props.composerSlot}</div>
      <span data-testid="empty-footer">
        {"emptyStateFooter" in props ? "present" : "absent"}
      </span>
      {props.children}
    </div>
  ),
}));
vi.mock("@agent-native/toolkit/app/chat/AgentSidebar", () => ({
  preloadAgentChatSurface: vi.fn(() => Promise.resolve()),
}));

function claudeModels(
  runtimeState:
    | "signed-in"
    | "needs-sign-in"
    | "not-subscription"
    | "no-plan"
    | "unreadable",
) {
  return [
    {
      engine: "claude-cli",
      engineLabel: "Anthropic",
      model: "claude-sonnet-5-5",
      label: "claude-sonnet-5-5",
      configured: runtimeState === "signed-in",
      runtimeState,
      ...(runtimeState === "signed-in"
        ? { statusLabel: "Claude subscription", isSubscription: true }
        : {}),
    },
  ];
}

const codexModels = [
  {
    engine: "codex-cli",
    engineLabel: "OpenAI",
    model: "gpt-5",
    label: "gpt-5",
    configured: true,
    statusLabel: "ChatGPT subscription",
    isSubscription: true,
  },
];

describe("desktop app chat Claude Code state", () => {
  let container: HTMLDivElement;
  let root: Root;
  let listModels: ReturnType<typeof vi.fn>;
  let beginProviderLogin: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    localStorage.clear();
    listModels = vi.fn(async () => ({
      status: "ok",
      models: claudeModels("needs-sign-in"),
    }));
    beginProviderLogin = vi.fn(async () => ({}));
    vi.stubGlobal("electronAPI", {
      desktopChat: { getApiUrl: async () => "http://127.0.0.1:1/chat" },
      codeAgents: { listModels },
      multiFrontier: { beginProviderLogin },
      appConfig: {},
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function mountShell() {
    await act(async () => {
      root.render(
        <DesktopAppChatShell
          appId="orchestrator"
          appName="Orchestrator"
          appAuthState="authenticated"
        >
          <div />
        </DesktopAppChatShell>,
      );
    });
    await settle();
  }

  async function settle() {
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  }

  const text = (id: string) =>
    container.querySelector(`[data-testid="${id}"]`)?.textContent ?? "";
  const buttonLabeled = (label: string) =>
    Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === label,
    );
  const signInButton = () => buttonLabeled("Sign in to Claude");

  it("says why Claude cannot run and offers one sign-in button", async () => {
    await mountShell();

    expect(text("footer")).toContain(
      "Claude Code is installed but not signed in.",
    );
    expect(signInButton()).toBeDefined();
    const [claude] = JSON.parse(text("agents")).filter(
      (agent: { id: string }) => agent.id === "claude-code",
    );
    expect(claude).toMatchObject({
      configured: false,
      statusLabel: "Sign in",
      runtimeState: "needs-sign-in",
      description: "Claude Code is installed but not signed in.",
    });
  });

  it("opens the Claude subscription sign-in, not a bare terminal", async () => {
    await mountShell();

    await act(async () => {
      signInButton()!.click();
    });
    await settle();

    expect(beginProviderLogin).toHaveBeenCalledWith("claude");
    expect(text("footer")).toContain(
      "Finish signing in to Claude in Terminal.",
    );
  });

  it("shows a failed sign-in launch in words", async () => {
    beginProviderLogin.mockResolvedValue({
      error: { message: "The provider sign-in terminal did not open." },
    });
    await mountShell();

    await act(async () => {
      signInButton()!.click();
    });
    await settle();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "The provider sign-in terminal did not open.",
    );
  });

  it("looks again when the person returns and switches to Claude once it can run", async () => {
    await mountShell();
    await act(async () => {
      signInButton()!.click();
    });
    await settle();
    listModels.mockResolvedValue({
      status: "ok",
      models: claudeModels("signed-in"),
    });

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await settle();

    expect(listModels).toHaveBeenLastCalledWith({ refresh: true });
    expect(text("selected")).toBe("claude-code");
    expect(text("footer")).toBe("");
  });

  it("says when the panel is using Codex because Claude cannot run", async () => {
    listModels.mockResolvedValue({
      status: "ok",
      models: [...codexModels, ...claudeModels("needs-sign-in")],
    });
    await mountShell();

    expect(text("selected")).toBe("codex");
    expect(text("footer")).toContain("This panel is using Codex.");
  });

  it("does not announce a missing Claude CLI, but the row and sign-in click say so", async () => {
    listModels.mockResolvedValue({ status: "ok", models: codexModels });
    await mountShell();

    expect(text("footer")).toBe("");
    const claude = JSON.parse(text("agents")).find(
      (agent: { id: string }) => agent.id === "claude-code",
    );
    expect(claude).toMatchObject({
      configured: false,
      statusLabel: "Not installed",
    });

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="pick-claude-row"]')!
        .click();
    });
    await settle();

    expect(beginProviderLogin).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Claude Code isn't installed on this computer.",
    );
  });

  it("reports an unreadable Claude check as such, never as not installed", async () => {
    listModels.mockResolvedValue({
      status: "ok",
      models: claudeModels("unreadable"),
    });
    await mountShell();

    expect(text("footer")).toContain(
      "Fogbreak couldn't tell whether Claude Code is signed in.",
    );
    const claude = JSON.parse(text("agents")).find(
      (agent: { id: string }) => agent.id === "claude-code",
    );
    expect(claude.statusLabel).toBe("Couldn't check");
  });

  it("reports a failed model probe instead of marking every runtime not installed", async () => {
    listModels.mockRejectedValue(new Error("ipc failed"));
    await mountShell();

    expect(text("footer")).toContain(
      "Fogbreak couldn't check which local agents are installed or signed in.",
    );
    expect(signInButton()).toBeUndefined();
    const labels = JSON.parse(text("agents"))
      .filter((agent: { id: string }) => agent.id !== "default")
      .map((agent: { statusLabel: string }) => agent.statusLabel);
    expect(new Set(labels)).toEqual(new Set(["Couldn't check"]));
  });

  it("keeps a signed-out Codex as Sign in, not Not installed", async () => {
    listModels.mockResolvedValue({
      status: "ok",
      models: [
        { ...codexModels[0], configured: false, statusLabel: undefined },
        ...claudeModels("signed-in"),
      ],
    });
    await mountShell();

    const codex = JSON.parse(text("agents")).find(
      (agent: { id: string }) => agent.id === "codex",
    );
    expect(codex).toMatchObject({ configured: false, statusLabel: "Sign in" });
  });

  it("keeps the notice in the composer slot, which survives the first message", async () => {
    await mountShell();

    expect(text("footer")).toContain("not signed in");
    expect(text("empty-footer")).toBe("absent");
  });

  it("looks again once at a time", async () => {
    await mountShell();
    await act(async () => {
      signInButton()!.click();
    });
    await settle();
    let release: (value: unknown) => void = () => undefined;
    listModels.mockImplementation(
      () => new Promise((resolve) => (release = resolve)),
    );

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("focus"));
    });
    expect(
      listModels.mock.calls.filter(([arg]) => arg?.refresh === true),
    ).toHaveLength(1);

    await act(async () => {
      release({ status: "ok", models: claudeModels("needs-sign-in") });
    });
    await settle();
  });

  it("shows a failed re-check instead of 'Finish signing in'", async () => {
    await mountShell();
    await act(async () => {
      signInButton()!.click();
    });
    await settle();
    listModels.mockRejectedValue(new Error("ipc failed"));

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await settle();

    expect(text("footer")).toContain("couldn't re-check the Claude sign-in");
    expect(text("footer")).not.toContain("Finish signing in");
    expect(buttonLabeled("Try again")).toBeDefined();
  });

  it("stays retryable after a failed re-check and recovers to Claude", async () => {
    await mountShell();
    await act(async () => {
      signInButton()!.click();
    });
    await settle();
    listModels.mockRejectedValueOnce(new Error("ipc failed"));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await settle();
    expect(text("footer")).toContain("couldn't re-check");
    const refreshes = () =>
      listModels.mock.calls.filter(([arg]) => arg?.refresh === true).length;
    expect(refreshes()).toBe(1);

    listModels.mockResolvedValue({
      status: "ok",
      models: claudeModels("signed-in"),
    });
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await settle();

    expect(refreshes()).toBe(2);
    expect(text("selected")).toBe("claude-code");
    expect(text("footer")).toBe("");
  });

  it("recovers through the Try again button too", async () => {
    await mountShell();
    await act(async () => {
      signInButton()!.click();
    });
    await settle();
    listModels.mockRejectedValueOnce(new Error("ipc failed"));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await settle();
    listModels.mockResolvedValue({
      status: "ok",
      models: claudeModels("signed-in"),
    });

    await act(async () => {
      buttonLabeled("Try again")!.click();
    });
    await settle();

    expect(text("selected")).toBe("claude-code");
  });

  it("shows a signed-in claude.ai login the runner would reject as no plan, not as signed in", async () => {
    listModels.mockResolvedValue({
      status: "ok",
      models: claudeModels("no-plan"),
    });
    await mountShell();

    expect(text("footer")).toContain(
      "Claude is signed in, but no usable subscription plan was reported.",
    );
    const claude = JSON.parse(text("agents")).find(
      (agent: { id: string }) => agent.id === "claude-code",
    );
    expect(claude).toMatchObject({ configured: false, statusLabel: "No plan" });
  });

  it("clears 'Finish signing in' when the person is still signed out after coming back", async () => {
    await mountShell();
    await act(async () => {
      signInButton()!.click();
    });
    await settle();
    expect(text("footer")).toContain("Finish signing in");

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await settle();

    expect(text("footer")).not.toContain("Finish signing in");
    expect(text("footer")).toContain("not signed in");
    expect(signInButton()).toBeDefined();
  });

  it("does not override an explicit Codex pick when Claude signs in", async () => {
    localStorage.setItem("desktop-app-agent:orchestrator", "codex");
    listModels.mockResolvedValue({
      status: "ok",
      models: [...codexModels, ...claudeModels("needs-sign-in")],
    });
    await mountShell();
    await act(async () => {
      signInButton()!.click();
    });
    await settle();
    listModels.mockResolvedValue({
      status: "ok",
      models: [...codexModels, ...claudeModels("signed-in")],
    });

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await settle();

    expect(text("selected")).toBe("codex");
  });

  it("moves an auto-picked Codex to Claude after the person signs in to Claude", async () => {
    listModels.mockResolvedValue({
      status: "ok",
      models: [...codexModels, ...claudeModels("needs-sign-in")],
    });
    await mountShell();
    expect(text("selected")).toBe("codex");
    await act(async () => {
      signInButton()!.click();
    });
    await settle();
    listModels.mockResolvedValue({
      status: "ok",
      models: [...codexModels, ...claudeModels("signed-in")],
    });

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await settle();

    expect(text("selected")).toBe("claude-code");
  });
});
