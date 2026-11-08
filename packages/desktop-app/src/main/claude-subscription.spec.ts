import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import type { SubscriptionStatus } from "../../shared/subscription-status.js";
import {
  DEFAULT_CLAUDE_AUTH_STATUS_TIMEOUT_MS,
  claudeCliModelOptions,
  claudeRunnerAcceptsLogin,
  classifyLocalClaudeCli,
  probeLocalClaudeCli,
  probeLocalClaudeCliAsync,
  cachedLocalClaudeCliStatus,
  readLocalClaudeCliStatus,
  readLocalClaudeCliStatusFresh,
  readLocalClaudeCliStatusAsync,
  executeClaudeProcess,
  getClaudeSubscriptionLoginLaunchSpec,
  isClaudeSubscriptionStatus,
  readClaudeSubscriptionStatus,
  type ClaudeCliProbeRun,
  type ClaudeProcessExecutor,
} from "./claude-subscription.js";
import { createCliStatusCache } from "./cli-status-cache.js";

describe("readClaudeSubscriptionStatus", () => {
  it("maps Claude Code subscription authentication into a provider-neutral connection status", async () => {
    const execute = vi.fn<ClaudeProcessExecutor>().mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({
        loggedIn: true,
        authMethod: "claude.ai",
        apiProvider: "firstParty",
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

  const accepted = {
    loggedIn: true,
    authMethod: "claude.ai",
    apiProvider: "firstParty",
    subscriptionType: "pro",
  };

  it.each([
    {
      name: "missing subscriptionType",
      patch: { subscriptionType: undefined },
    },
    { name: "null subscriptionType", patch: { subscriptionType: null } },
    { name: "blank subscriptionType", patch: { subscriptionType: "  " } },
    { name: "non-string subscriptionType", patch: { subscriptionType: 3 } },
    { name: "missing apiProvider", patch: { apiProvider: undefined } },
    { name: "third-party apiProvider", patch: { apiProvider: "bedrock" } },
    { name: "authMethod Claude.AI", patch: { authMethod: "Claude.AI" } },
    { name: "authMethod claude_ai", patch: { authMethod: "claude_ai" } },
    { name: "authMethod api_key", patch: { authMethod: "api_key" } },
    { name: "authMethod console", patch: { authMethod: "console" } },
    { name: "missing authMethod", patch: { authMethod: undefined } },
  ])(
    "does not report a login the runner rejects as connected ($name)",
    async ({ patch }) => {
      const execute: ClaudeProcessExecutor = async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ ...accepted, ...patch }),
        stderr: "",
      });

      const status = await readClaudeSubscriptionStatus({ execute });

      expect(status).toMatchObject({
        connectionState: "no-subscription",
        telemetry: { source: "connection-only" },
      });
      expect(status.connectionMessage).toBeTruthy();
      expect(status).not.toHaveProperty("plan");
      expect(isClaudeSubscriptionStatus(status)).toBe(false);
    },
  );

  it("accepts the login the runner accepts, trimming the way core does", async () => {
    const execute: ClaudeProcessExecutor = async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        ...accepted,
        authMethod: " claude.ai ",
        apiProvider: " firstParty",
        subscriptionType: " pro ",
      }),
      stderr: "",
    });

    const status = await readClaudeSubscriptionStatus({ execute });

    expect(status).toMatchObject({
      connectionState: "connected",
      authMethod: "claude.ai",
      plan: { type: "pro" },
    });
    expect(isClaudeSubscriptionStatus(status)).toBe(true);
  });

  it("isClaudeSubscriptionStatus rejects a connected status that lacks what the runner needs", () => {
    const base: SubscriptionStatus = {
      schemaVersion: 1,
      providerId: "claude",
      connectionState: "connected",
      authMethod: "claude.ai",
      plan: { type: "pro" },
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
      },
    };
    expect(isClaudeSubscriptionStatus(base)).toBe(true);
    expect(
      isClaudeSubscriptionStatus({ ...base, authMethod: "Claude.ai" }),
    ).toBe(false);
    expect(isClaudeSubscriptionStatus({ ...base, authMethod: "api_key" })).toBe(
      false,
    );
    const { plan: _plan, ...noPlan } = base;
    expect(isClaudeSubscriptionStatus(noPlan)).toBe(false);
    expect(isClaudeSubscriptionStatus({ ...base, plan: { type: "" } })).toBe(
      false,
    );
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

  it("labels API or console authentication as not a Claude subscription, in words", async () => {
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
      connectionState: "no-subscription",
      authMethod: "api_key",
      connectionMessage:
        "Claude Code is signed in with an API key or console login, not a Claude subscription.",
      telemetry: {
        source: "connection-only",
        capabilities: { account: false, plan: false },
      },
    });
    expect(status.plan).toBeUndefined();
    expect(status).not.toHaveProperty("account");
    expect(isClaudeSubscriptionStatus(status)).toBe(false);
  });

  it("says a claude.ai login without a usable plan is not a plan Fogbreak can use", async () => {
    const execute: ClaudeProcessExecutor = async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }),
      stderr: "",
    });

    await expect(
      readClaudeSubscriptionStatus({ execute }),
    ).resolves.toMatchObject({
      connectionState: "no-subscription",
      connectionMessage:
        "Claude is signed in, but not with a Claude subscription plan Fogbreak can use.",
    });
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
      run: statusRun(0, {
        loggedIn: true,
        authMethod: "claude.ai",
        apiProvider: "firstParty",
      }),
      expected: { authenticated: false, runtimeState: "no-plan" },
    },
    {
      name: "claude.ai login with a blank subscriptionType",
      run: statusRun(0, {
        loggedIn: true,
        authMethod: "claude.ai",
        apiProvider: "firstParty",
        subscriptionType: "  ",
      }),
      expected: { authenticated: false, runtimeState: "no-plan" },
    },
    {
      name: "claude.ai login without apiProvider",
      run: statusRun(0, {
        loggedIn: true,
        authMethod: "claude.ai",
        subscriptionType: "max",
      }),
      expected: { authenticated: false, runtimeState: "no-plan" },
    },
    {
      name: "claude.ai login through a third-party apiProvider",
      run: statusRun(0, {
        loggedIn: true,
        authMethod: "claude.ai",
        apiProvider: "bedrock",
        subscriptionType: "max",
      }),
      expected: { authenticated: false, runtimeState: "no-plan" },
    },
    {
      name: "API key",
      run: statusRun(0, {
        loggedIn: true,
        authMethod: "api_key",
        apiProvider: "firstParty",
        subscriptionType: "max",
      }),
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

describe("claudeRunnerAcceptsLogin", () => {
  // Pins the predicate mirrored from assertClaudeCodeSubscription in
  // packages/core/src/cli/claude-code-participant.ts: change both together.
  const ok = {
    loggedIn: true,
    authMethod: "claude.ai",
    apiProvider: "firstParty",
    subscriptionType: "pro",
  };

  it("accepts only a signed-in first-party claude.ai login with a plan", () => {
    expect(claudeRunnerAcceptsLogin(ok)).toBe(true);
    expect(
      claudeRunnerAcceptsLogin({
        ...ok,
        authMethod: " claude.ai ",
        apiProvider: " firstParty",
      }),
    ).toBe(true);
    expect(claudeRunnerAcceptsLogin({ ...ok, loggedIn: false })).toBe(false);
    expect(claudeRunnerAcceptsLogin({ ...ok, authMethod: "api_key" })).toBe(
      false,
    );
    expect(claudeRunnerAcceptsLogin({ ...ok, authMethod: "claudeai" })).toBe(
      false,
    );
    expect(claudeRunnerAcceptsLogin({ ...ok, apiProvider: "vertex" })).toBe(
      false,
    );
    expect(claudeRunnerAcceptsLogin({ ...ok, apiProvider: undefined })).toBe(
      false,
    );
    expect(claudeRunnerAcceptsLogin({ ...ok, subscriptionType: "" })).toBe(
      false,
    );
    expect(claudeRunnerAcceptsLogin({ ...ok, subscriptionType: null })).toBe(
      false,
    );
  });
});

describe("probeLocalClaudeCli", () => {
  const ok = (stdout: string, status = 0): ClaudeCliProbeRun => ({
    status,
    stdout,
    stderr: "",
  });
  const signedOut = JSON.stringify({ loggedIn: false, authMethod: "none" });
  const signedIn = JSON.stringify({
    loggedIn: true,
    authMethod: "claude.ai",
    apiProvider: "firstParty",
    subscriptionType: "max",
  });

  it("runs --version, then auth status, and classifies the answer", () => {
    const calls: string[][] = [];
    const probe = probeLocalClaudeCli((args) => {
      calls.push([...args]);
      return args[0] === "--version"
        ? ok("2.1.318 (Claude Code)")
        : ok(signedOut, 1);
    });

    expect(calls).toEqual([["--version"], ["auth", "status", "--json"]]);
    expect(probe).toMatchObject({
      available: true,
      authenticated: false,
      runtimeState: "needs-sign-in",
    });
    // The model-list rows follow the real probe, not a fixed answer.
    expect(
      claudeCliModelOptions({
        engine: "claude-cli",
        supportedModels: ["claude-sonnet-5-5"],
        probe,
      })[0],
    ).toMatchObject({ configured: false, runtimeState: "needs-sign-in" });
  });

  it("skips auth status when the CLI cannot run", () => {
    const calls: string[][] = [];
    const probe = probeLocalClaudeCli((args) => {
      calls.push([...args]);
      return {
        status: null,
        stdout: "",
        stderr: "",
        error: { code: "ENOENT", message: "spawn claude ENOENT" },
      };
    });

    expect(calls).toEqual([["--version"]]);
    expect(probe.available).toBe(false);
  });

  it("gives the same answer through the async runner", async () => {
    const probe = await probeLocalClaudeCliAsync(async (args) =>
      args[0] === "--version" ? ok("2.1.318") : ok(signedIn),
    );

    expect(probe).toMatchObject({
      available: true,
      authenticated: true,
      runtimeState: "signed-in",
    });
  });
});

describe("local Claude status as Electron main caches and lists it", () => {
  const runner =
    (statusRun: ClaudeCliProbeRun) =>
    (args: readonly string[]): ClaudeCliProbeRun =>
      args[0] === "--version"
        ? { status: 0, stdout: "2.1.318", stderr: "" }
        : statusRun;
  const json = (value: unknown, status = 0): ClaudeCliProbeRun => ({
    status,
    stdout: JSON.stringify(value),
    stderr: "",
  });
  const rowsFor = (status: ReturnType<typeof readLocalClaudeCliStatus>) =>
    claudeCliModelOptions({
      engine: "claude-cli",
      supportedModels: ["claude-sonnet-5-5"],
      probe: status,
    });

  it.each([
    {
      name: "signed out",
      run: json({ loggedIn: false }, 1),
      runtimeState: "needs-sign-in",
    },
    {
      name: "claude.ai login with no plan",
      run: json({ loggedIn: true, authMethod: "claude.ai" }),
      runtimeState: "no-plan",
    },
    {
      name: "API key",
      run: json({ loggedIn: true, authMethod: "api_key" }),
      runtimeState: "not-subscription",
    },
    {
      name: "unreadable answer",
      run: { status: 0, stdout: "not json", stderr: "" },
      runtimeState: "unreadable",
    },
  ])(
    "$name is not authenticated and its rows are unconfigured",
    async ({ run, runtimeState }) => {
      const sync = readLocalClaudeCliStatus(runner(run));
      const async = await readLocalClaudeCliStatusAsync(async (args) =>
        runner(run)(args),
      );

      for (const status of [sync, async]) {
        expect(status).toMatchObject({
          available: true,
          authenticated: false,
          runtimeState,
          label: "Claude subscription",
        });
        expect(rowsFor(status)[0]).toMatchObject({
          configured: false,
          runtimeState,
        });
      }
    },
  );

  it("a login the runner accepts is authenticated with a configured row", () => {
    const status = readLocalClaudeCliStatus(
      runner(
        json({
          loggedIn: true,
          authMethod: "claude.ai",
          apiProvider: "firstParty",
          subscriptionType: "max",
        }),
      ),
    );

    expect(status.authenticated).toBe(true);
    expect(rowsFor(status)[0]).toMatchObject({
      configured: true,
      statusLabel: "Claude subscription",
    });
  });
});

describe("local Claude status after signing in in Terminal", () => {
  // Real cache and real status reader; only the CLI runs are injected.
  function setup() {
    const world = { signedIn: false, probes: 0 };
    const answer = (args: readonly string[]): ClaudeCliProbeRun => {
      if (args[0] === "--version") {
        return { status: 0, stdout: "2.1.318", stderr: "" };
      }
      world.probes += 1;
      return world.signedIn
        ? {
            status: 0,
            stdout: JSON.stringify({
              loggedIn: true,
              authMethod: "claude.ai",
              apiProvider: "firstParty",
              subscriptionType: "max",
            }),
            stderr: "",
          }
        : {
            status: 1,
            stdout: JSON.stringify({ loggedIn: false }),
            stderr: "",
          };
    };
    return {
      world,
      cache:
        createCliStatusCache<ReturnType<typeof readLocalClaudeCliStatus>>(),
      runners: {
        sync: answer,
        async: async (args: readonly string[]) => answer(args),
      },
    };
  }

  it("answers a refresh with the fresh status, not the cached signed-out one", async () => {
    const { world, cache, runners } = setup();
    expect(cachedLocalClaudeCliStatus(cache, runners).authenticated).toBe(
      false,
    );
    world.signedIn = true;

    expect(cachedLocalClaudeCliStatus(cache, runners).authenticated).toBe(
      false,
    );
    expect(
      (await readLocalClaudeCliStatusFresh(cache, runners)).authenticated,
    ).toBe(false);

    const fresh = await readLocalClaudeCliStatusFresh(cache, runners, {
      refresh: true,
    });

    expect(fresh).toMatchObject({
      authenticated: true,
      runtimeState: "signed-in",
    });
    expect(cachedLocalClaudeCliStatus(cache, runners).authenticated).toBe(true);
  });

  it("does not re-probe on a plain read", async () => {
    const { world, cache, runners } = setup();
    await readLocalClaudeCliStatusFresh(cache, runners);
    await readLocalClaudeCliStatusFresh(cache, runners);

    expect(world.probes).toBe(1);
  });
});
