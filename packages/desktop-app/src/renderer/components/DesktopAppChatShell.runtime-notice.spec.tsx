// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import DesktopAppChatShell from "./DesktopAppChatShell.js";

type PanelProps = {
  selectedAgent: string;
  availableAgents: unknown[];
  emptyStateFooter?: React.ReactNode;
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
      <div data-testid="footer">{props.emptyStateFooter}</div>
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
  const signInButton = () =>
    Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Sign in to Claude",
    );

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
});
