import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_CLAUDE_AUTH_STATUS_TIMEOUT_MS,
  claudeCliModelOptions,
  classifyLocalClaudeCli,
  executeClaudeProcess,
  getClaudeSubscriptionLoginLaunchSpec,
  isClaudeSubscriptionStatus,
  readClaudeSubscriptionStatus,
  type ClaudeCliProbeRun,
  type ClaudeProcessExecutor,
} from "./claude-subscription.js";

describe("readClaudeSubscriptionStatus", () => {
  it("maps Claude Code subscription authentication into a provider-neutral connection status", async () => {
    const execute = vi.fn<ClaudeProcessExecutor>().mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({
        loggedIn: true,
        authMethod: "claude.ai",
        email: "person@example.test",
        orgId: "org-example",
        orgName: "Example Org",
        subscriptionType: "max",
      }),
      stderr: "",
    });

    const status = await readClaudeSubscriptionStatus({ execute });
    expect(status).toEqual({
      schemaVersion: 1,
      providerId: "claude",
      connectionState: "connected",
      authMethod: "claude.ai",
      plan: { type: "max" },
      telemetry: {
        state: "unsupported",
        source: "connection-only",
        capabilities: {
          account: false,
          plan: true,
          rateLimits: false,
          modelTierRateLimits: false,
          contextWindow: false,
          credits: false,
          liveUpdates: false,
        },
        meters: [],
        error: {
          message:
            "Claude Code does not expose live plan usage to non-interactive sessions.",
        },
      },
    });
    expect(execute).toHaveBeenCalledWith(
      "claude",
      ["auth", "status", "--json"],
      { timeoutMs: DEFAULT_CLAUDE_AUTH_STATUS_TIMEOUT_MS },
    );
    expect(status).not.toHaveProperty("account");
  });

  it("keeps a signed-out CLI distinct from an unavailable CLI", async () => {
    const execute: ClaudeProcessExecutor = async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ loggedIn: false, authMethod: "claudeai" }),
      stderr: "",
    });

    await expect(readClaudeSubscriptionStatus({ execute })).resolves.toEqual({
      schemaVersion: 1,
      providerId: "claude",
      connectionState: "needs-sign-in",
      authMethod: "claudeai",
      telemetry: {
        state: "unavailable",
        source: "connection-only",
        capabilities: {
          account: false,
          plan: false,
          rateLimits: false,
          modelTierRateLimits: false,
          contextWindow: false,
          credits: false,
          liveUpdates: false,
        },
        meters: [],
      },
    });
  });

  it("does not advertise plan capability when Claude omits the plan tier", async () => {
    const status = await readClaudeSubscriptionStatus({
      execute: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          loggedIn: true,
          authMethod: "claude.ai",
        }),
        stderr: "",
      }),
    });

    expect(status.telemetry).toMatchObject({
      state: "unsupported",
      capabilities: { account: false, plan: false },
    });
    expect(status).not.toHaveProperty("account");
    expect(status).not.toHaveProperty("plan");
  });

  it("reads the signed-out answer the real CLI gives, which exits 1 with JSON on stdout", async () => {
    const execute: ClaudeProcessExecutor = async () => ({
      exitCode: 1,
      stdout: JSON.stringify({ loggedIn: false, authMethod: "none" }),
      stderr: "",
    });

    await expect(
      readClaudeSubscriptionStatus({ execute }),
    ).resolves.toMatchObject({
      providerId: "claude",
      connectionState: "needs-sign-in",
      authMethod: "none",
    });
  });

  it("reports a missing CLI as unavailable, in words", async () => {
    const execute: ClaudeProcessExecutor = async () => ({
      exitCode: null,
      stdout: "",
      stderr: "",
      spawnErrorCode: "ENOENT",
    });

    await expect(
      readClaudeSubscriptionStatus({ execute }),
    ).resolves.toMatchObject({
      connectionState: "unavailable",
      connectionMessage: "Claude Code was not found on this computer.",
    });
  });

  it.each([
    {
      name: "timeout",
      result: { exitCode: null, stdout: "", stderr: "", timedOut: true },
      message: "Claude Code did not answer when asked whether it is signed in.",
    },
    {
      name: "spawn failure other than a missing CLI",
      result: {
        exitCode: null,
        stdout: "",
        stderr: "",
        spawnErrorCode: "EACCES",
      },
      message: "Fogbreak could not run Claude Code to check its sign-in.",
    },
    {
      name: "exit 1 without JSON",
      result: { exitCode: 1, stdout: "", stderr: "something broke" },
      message: "Claude Code answered, but its sign-in state could not be read.",
    },
    {
      name: "exit 0 with text instead of JSON",
      result: { exitCode: 0, stdout: "not json", stderr: "" },
      message: "Claude Code answered, but its sign-in state could not be read.",
    },
    {
      name: "unexpected exit code with JSON",
      result: {
        exitCode: 2,
        stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }),
        stderr: "",
      },
      message: "Claude Code answered, but its sign-in state could not be read.",
    },
  ])(
    "reports an unreadable answer ($name) as an error, never as signed out or missing",
    async ({ result, message }) => {
      const execute: ClaudeProcessExecutor = async () => result;
      const status = await readClaudeSubscriptionStatus({ execute });

      expect(status).toMatchObject({
        schemaVersion: 1,
        providerId: "claude",
        connectionState: "error",
        connectionMessage: message,
        telemetry: { state: "unavailable", source: "connection-only" },
      });
      expect(status).not.toHaveProperty("plan");
      expect(status).not.toHaveProperty("authMethod");
    },
  );

  it("treats exit 1 with loggedIn:true as unreadable, not as a connection", async () => {
    const execute: ClaudeProcessExecutor = async () => ({
      exitCode: 1,
      stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }),
      stderr: "",
    });

    await expect(
      readClaudeSubscriptionStatus({ execute }),
    ).resolves.toMatchObject({
      connectionState: "error",
    });
  });

  it("reports a rejected executor as an error", async () => {
    const execute: ClaudeProcessExecutor = async () => {
      throw new Error("spawn exploded");
    };

    await expect(
      readClaudeSubscriptionStatus({ execute }),
    ).resolves.toMatchObject({
      connectionState: "error",
    });
  });

  it("does not treat API or console authentication as a Claude subscription", async () => {
    const execute: ClaudeProcessExecutor = async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        loggedIn: true,
        authMethod: "api_key",
        email: "person@example.test",
        orgId: "org-example",
        orgName: "Example Org",
        subscriptionType: "max",
      }),
      stderr: "",
    });

    const status = await readClaudeSubscriptionStatus({ execute });

    expect(status).toMatchObject({
      connectionState: "connected",
      authMethod: "api_key",
      connectionMessage:
        "Claude Code is authenticated with API or console billing, not a Claude subscription.",
      telemetry: {
        source: "connection-only",
        capabilities: { account: false, plan: false },
      },
    });
    expect(status.plan).toBeUndefined();
    expect(status).not.toHaveProperty("account");
    expect(isClaudeSubscriptionStatus(status)).toBe(false);
  });
});

describe("getClaudeSubscriptionLoginLaunchSpec", () => {
  it("uses a fixed subscription-login command on macOS", () => {
    expect(getClaudeSubscriptionLoginLaunchSpec("darwin")).toEqual({
      ok: true,
      command: "/usr/bin/osascript",
      args: [
        "-e",
        'tell application "Terminal" to do script "claude auth login --claudeai"',
        "-e",
        'tell application "Terminal" to activate',
      ],
    });
  });

  it("selects a supported Linux terminal without accepting caller-controlled command text", () => {
    expect(
      getClaudeSubscriptionLoginLaunchSpec(
        "linux",
        (command) => command === "gnome-terminal",
      ),
    ).toEqual({
      ok: true,
      command: "gnome-terminal",
      args: ["--", "claude", "auth", "login", "--claudeai"],
    });
  });

  it("returns guidance instead of a shell fallback when no terminal is available", () => {
    expect(getClaudeSubscriptionLoginLaunchSpec("linux", () => false)).toEqual({
      ok: false,
      error:
        "No supported terminal emulator was found. Install a terminal emulator and try again.",
    });
  });
});

describe("executeClaudeProcess", () => {
  it("escalates a timed-out child through TERM and KILL before forced settlement", async () => {
    vi.useFakeTimers();
    try {
      const child = createFakeProcess();
      const execution = executeClaudeProcess(
        "claude",
        ["auth", "status", "--json"],
        { timeoutMs: 1 },
        () => child,
      );
      const result = expect(execution).resolves.toMatchObject({
        exitCode: null,
        timedOut: true,
      });

      await vi.advanceTimersByTimeAsync(501);
      expect(child.killedSignals).toEqual(["SIGTERM", "SIGKILL"]);
      await result;
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the errno code when the child cannot be started", async () => {
    vi.useFakeTimers();
    try {
      const child = createFakeProcess();
      const execution = executeClaudeProcess(
        "claude",
        ["auth", "status", "--json"],
        { timeoutMs: 10_000 },
        () => child,
      );
      const result = expect(execution).resolves.toMatchObject({
        exitCode: null,
        timedOut: false,
        spawnErrorCode: "ENOENT",
      });
      child.emit(
        "error",
        Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }),
      );

      await vi.advanceTimersByTimeAsync(501);
      await result;
    } finally {
      vi.useRealTimers();
    }
  });

  it("reaps a wedged child after a stdout stream error", async () => {
    vi.useFakeTimers();
    try {
      const child = createFakeProcess();
      const execution = executeClaudeProcess(
        "claude",
        ["auth", "status", "--json"],
        { timeoutMs: 10_000 },
        () => child,
      );
      const result = expect(execution).resolves.toMatchObject({
        exitCode: null,
        timedOut: false,
      });
      child.stdout.emit("error", new Error("stdout failed"));

      await vi.advanceTimersByTimeAsync(500);
      expect(child.killedSignals).toEqual(["SIGTERM", "SIGKILL"]);
      await result;
    } finally {
      vi.useRealTimers();
    }
  });
});

function createFakeProcess(): ChildProcess & {
  stdout: PassThrough;
  stderr: PassThrough;
  killedSignals: NodeJS.Signals[];
} {
  const child = new EventEmitter() as ChildProcess & {
    stdout: PassThrough;
    stderr: PassThrough;
    killedSignals: NodeJS.Signals[];
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killedSignals = [];
  child.kill = ((signal?: NodeJS.Signals) => {
    if (signal) child.killedSignals.push(signal);
    return true;
  }) as ChildProcess["kill"];
  return child;
}

describe("classifyLocalClaudeCli", () => {
  const versionOk: ClaudeCliProbeRun = {
    status: 0,
    stdout: "2.1.318 (Claude Code)",
    stderr: "",
  };
  const statusRun = (
    status: number | null,
    body: unknown,
    error?: ClaudeCliProbeRun["error"],
  ): ClaudeCliProbeRun => ({
    status,
    stdout: typeof body === "string" ? body : JSON.stringify(body),
    stderr: "",
    error,
  });

  it("reports a missing CLI as not available, with no probe state", () => {
    const probe = classifyLocalClaudeCli(
      {
        status: null,
        stdout: "",
        stderr: "",
        error: { code: "ENOENT", message: "spawn claude ENOENT" },
      },
      null,
    );
    expect(probe).toMatchObject({ available: false, authenticated: false });
    expect(probe).not.toHaveProperty("runtimeState");
  });

  it("reports a CLI that could not be run as unreadable, not missing", () => {
    expect(
      classifyLocalClaudeCli(
        {
          status: null,
          stdout: "",
          stderr: "",
          error: { code: "ETIMEDOUT", message: "spawnSync claude ETIMEDOUT" },
        },
        null,
      ),
    ).toMatchObject({
      available: true,
      authenticated: false,
      runtimeState: "unreadable",
    });
  });

  it.each([
    {
      name: "signed out (exit 1 with JSON)",
      run: statusRun(1, { loggedIn: false, authMethod: "none" }),
      expected: { authenticated: false, runtimeState: "needs-sign-in" },
    },
    {
      name: "Claude subscription",
      run: statusRun(0, {
        loggedIn: true,
        authMethod: "claude.ai",
        apiProvider: "firstParty",
        subscriptionType: "max",
      }),
      expected: { authenticated: true, runtimeState: "signed-in" },
    },
    {
      name: "claude.ai login without subscriptionType",
      run: statusRun(0, { loggedIn: true, authMethod: "claude.ai" }),
      expected: { authenticated: true, runtimeState: "signed-in" },
    },
    {
      name: "API key",
      run: statusRun(0, { loggedIn: true, authMethod: "api_key" }),
      expected: { authenticated: false, runtimeState: "not-subscription" },
    },
    {
      name: "exit 1 with loggedIn:true",
      run: statusRun(1, { loggedIn: true, authMethod: "claude.ai" }),
      expected: { authenticated: false, runtimeState: "unreadable" },
    },
    {
      name: "status timed out",
      run: statusRun(null, ""),
      expected: { authenticated: false, runtimeState: "unreadable" },
    },
    {
      name: "status output is not JSON",
      run: statusRun(0, "not json"),
      expected: { authenticated: false, runtimeState: "unreadable" },
    },
  ])("classifies $name", ({ run, expected }) => {
    expect(classifyLocalClaudeCli(versionOk, run)).toMatchObject({
      available: true,
      ...expected,
    });
  });
});

describe("claudeCliModelOptions", () => {
  const models = ["claude-sonnet-5-5", "claude-opus-4-8"];

  it("has no rows for an uninstalled CLI", () => {
    expect(
      claudeCliModelOptions({
        engine: "claude-cli",
        supportedModels: models,
        probe: { available: false, authenticated: false },
      }),
    ).toEqual([]);
  });

  it("marks a signed-in CLI configured, with the subscription label", () => {
    const [first] = claudeCliModelOptions({
      engine: "claude-cli",
      supportedModels: models,
      probe: {
        available: true,
        authenticated: true,
        runtimeState: "signed-in",
      },
    });
    expect(first).toMatchObject({
      engine: "claude-cli",
      configured: true,
      statusLabel: "Claude subscription",
      isSubscription: true,
      runtimeState: "signed-in",
    });
  });

  it.each(["needs-sign-in", "not-subscription", "unreadable"] as const)(
    "passes the %s state through on an unconfigured row",
    (runtimeState) => {
      const options = claudeCliModelOptions({
        engine: "claude-cli",
        supportedModels: models,
        probe: { available: true, authenticated: false, runtimeState },
      });
      expect(options).toHaveLength(models.length);
      for (const option of options) {
        expect(option).toMatchObject({ configured: false, runtimeState });
        expect(option).not.toHaveProperty("statusLabel");
        expect(option).not.toHaveProperty("isSubscription");
      }
    },
  );
});
