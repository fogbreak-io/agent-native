import { spawn, type ChildProcess } from "node:child_process";

import type {
  CodeAgentModelOption,
  CodeAgentRuntimeState,
} from "../../shared/ipc-channels.js";
import {
  isClaudeSubscriptionAuthMethod,
  type SubscriptionStatus,
  type SubscriptionTelemetry,
} from "../../shared/subscription-status.js";

export { isClaudeSubscriptionAuthMethod };
import {
  CLI_STATUS_TTL_MS,
  cachedCliStatus,
  invalidateCliStatusCache,
  type CliStatusCache,
} from "./cli-status-cache.js";
import {
  resolveExecutable,
  withResolvedExecutablePaths,
} from "./code-agent-runner.js";

export const DEFAULT_CLAUDE_AUTH_STATUS_TIMEOUT_MS = 10_000;

const CLAUDE_AUTH_STATUS_ARGS = ["auth", "status", "--json"] as const;
const MAX_STATUS_OUTPUT_CHARS = 64 * 1024;
const PROCESS_TERMINATION_GRACE_MS = 250;
const PROCESS_FORCE_SETTLE_MS = 250;

export interface ClaudeProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  /** errno code (ENOENT for a missing CLI) when the child could not be started. */
  spawnErrorCode?: string;
}

export interface ClaudeProcessExecutorOptions {
  timeoutMs: number;
}

export type ClaudeProcessExecutor = (
  command: string,
  args: readonly string[],
  options: ClaudeProcessExecutorOptions,
) => Promise<ClaudeProcessResult>;

export type SpawnClaudeProcess = (
  command: string,
  args: readonly string[],
) => ChildProcess;

export interface ReadClaudeSubscriptionStatusOptions {
  execute?: ClaudeProcessExecutor;
  timeoutMs?: number;
}

export type ClaudeSubscriptionLoginLaunchSpec =
  | {
      ok: true;
      command: string;
      args: string[];
    }
  | {
      ok: false;
      error: string;
    };

type CommandAvailable = (command: string) => boolean;

const LINUX_TERMINAL_CANDIDATES = [
  {
    command: "x-terminal-emulator",
    args: ["-e", "claude", "auth", "login", "--claudeai"],
  },
  {
    command: "gnome-terminal",
    args: ["--", "claude", "auth", "login", "--claudeai"],
  },
  {
    command: "konsole",
    args: ["-e", "claude", "auth", "login", "--claudeai"],
  },
  {
    command: "xfce4-terminal",
    args: ["--command", "claude auth login --claudeai"],
  },
  {
    command: "xterm",
    args: ["-e", "claude", "auth", "login", "--claudeai"],
  },
] as const;

export async function readClaudeSubscriptionStatus(
  options: ReadClaudeSubscriptionStatusOptions = {},
): Promise<SubscriptionStatus> {
  const result: ClaudeProcessResult = await (
    options.execute ?? executeClaudeProcess
  )("claude", CLAUDE_AUTH_STATUS_ARGS, {
    timeoutMs: options.timeoutMs ?? DEFAULT_CLAUDE_AUTH_STATUS_TIMEOUT_MS,
  }).catch(
    (): ClaudeProcessResult => ({
      exitCode: null,
      stdout: "",
      stderr: "",
    }),
  );
  return interpretClaudeAuthStatus(result);
}

/**
 * Turns one `claude auth status --json` run into a connection status. The CLI
 * exits 1 when signed out and still prints `{"loggedIn": false}`, so the exit
 * code alone cannot tell "signed out" from "could not run". "connected" means
 * `claudeRunnerAcceptsLogin`: a login the runner rejects is "no-subscription".
 */
export function interpretClaudeAuthStatus(
  result: ClaudeProcessResult,
): SubscriptionStatus {
  if (result.spawnErrorCode === "ENOENT") {
    return connectionOnlyStatus(
      "unavailable",
      "Claude Code was not found on this computer.",
    );
  }
  if (result.timedOut) {
    return connectionOnlyStatus(
      "error",
      "Claude Code did not answer when asked whether it is signed in.",
    );
  }
  if (result.exitCode === null) {
    return connectionOnlyStatus(
      "error",
      "Fogbreak could not run Claude Code to check its sign-in.",
    );
  }
  const raw =
    result.exitCode === 0 || result.exitCode === 1
      ? parseAuthStatus(result.stdout)
      : null;
  // Signed in always exits 0, so exit 1 with loggedIn:true contradicts itself.
  if (
    !raw ||
    typeof raw.loggedIn !== "boolean" ||
    (raw.loggedIn && result.exitCode !== 0)
  ) {
    return connectionOnlyStatus(
      "error",
      "Claude Code answered, but its sign-in state could not be read.",
    );
  }
  const authMethod = stringValue(raw.authMethod);
  if (!raw.loggedIn) {
    return {
      schemaVersion: 1,
      providerId: "claude",
      connectionState: "needs-sign-in",
      authMethod,
      telemetry: connectionOnlyTelemetry(false),
    };
  }
  if (!claudeRunnerAcceptsLogin(raw)) {
    return {
      schemaVersion: 1,
      providerId: "claude",
      connectionState: "no-subscription",
      ...(authMethod ? { authMethod } : {}),
      connectionMessage: isClaudeSubscriptionAuthMethod(authMethod)
        ? "Claude is signed in, but not with a Claude subscription plan Fogbreak can use."
        : "Claude Code is signed in with an API key or console login, not a Claude subscription.",
      telemetry: connectionOnlyTelemetry(false),
    };
  }
  const planType = stringValue(raw.subscriptionType);
  return {
    schemaVersion: 1,
    providerId: "claude",
    connectionState: "connected",
    authMethod,
    ...(planType ? { plan: { type: planType } } : {}),
    telemetry: claudeLiveUsageUnsupportedTelemetry(Boolean(planType)),
  };
}

/** One `--version` or `auth status` run of the local CLI, as Electron main probes it. */
export interface ClaudeCliProbeRun {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: { code?: string | undefined; message: string } | undefined;
}

export interface LocalClaudeCliProbe {
  available: boolean;
  authenticated: boolean;
  /** Why an installed CLI cannot run; absent when the CLI is not installed. */
  runtimeState?: CodeAgentRuntimeState;
  error?: string;
}

/**
 * Classifies the local `claude` CLI for the app chat model list from its
 * `--version` and `auth status --json` runs. The sign-in answer comes from
 * `interpretClaudeAuthStatus`, which gates "connected" on
 * `claudeRunnerAcceptsLogin`, so this, the Settings subscription row and the
 * Multi-Frontier gate cannot disagree about what counts as signed in.
 */
export function classifyLocalClaudeCli(
  version: ClaudeCliProbeRun,
  status: ClaudeCliProbeRun | null,
): LocalClaudeCliProbe {
  if (version.error?.code === "ENOENT") {
    return {
      available: false,
      authenticated: false,
      error: "Claude Code CLI was not found.",
    };
  }
  if (version.error || !status) {
    return {
      available: true,
      authenticated: false,
      runtimeState: "unreadable",
      error: version.error?.message ?? "Claude Code could not be run.",
    };
  }
  const connection = interpretClaudeAuthStatus({
    exitCode: status.status,
    stdout: status.stdout,
    stderr: status.stderr,
    ...(status.error?.code ? { spawnErrorCode: status.error.code } : {}),
  });
  if (connection.connectionState === "connected") {
    return { available: true, authenticated: true, runtimeState: "signed-in" };
  }
  const runtimeState: CodeAgentRuntimeState =
    connection.connectionState === "needs-sign-in"
      ? "needs-sign-in"
      : connection.connectionState === "no-subscription"
        ? isClaudeSubscriptionAuthMethod(connection.authMethod)
          ? "no-plan"
          : "not-subscription"
        : "unreadable";
  return {
    available: true,
    authenticated: false,
    runtimeState,
    error: "Claude Code is not signed in with a Claude subscription.",
  };
}

/**
 * Probes the local CLI with `--version`, then `auth status --json` (skipped when
 * the CLI cannot run). The runner is injected so the whole chain is testable.
 */
export function probeLocalClaudeCli(
  run: (args: readonly string[]) => ClaudeCliProbeRun,
): LocalClaudeCliProbe {
  const version = run(["--version"]);
  return classifyLocalClaudeCli(
    version,
    version.error ? null : run(CLAUDE_AUTH_STATUS_ARGS),
  );
}

export async function probeLocalClaudeCliAsync(
  run: (args: readonly string[]) => Promise<ClaudeCliProbeRun>,
): Promise<LocalClaudeCliProbe> {
  const version = await run(["--version"]);
  return classifyLocalClaudeCli(
    version,
    version.error ? null : await run(CLAUDE_AUTH_STATUS_ARGS),
  );
}

export interface LocalClaudeCliStatus extends LocalClaudeCliProbe {
  label: string;
}

/** What `getLocalClaudeCliStatus` caches in Electron main: the probe plus its display label. */
export function readLocalClaudeCliStatus(
  run: (args: readonly string[]) => ClaudeCliProbeRun,
): LocalClaudeCliStatus {
  return { ...probeLocalClaudeCli(run), label: "Claude subscription" };
}

export async function readLocalClaudeCliStatusAsync(
  run: (args: readonly string[]) => Promise<ClaudeCliProbeRun>,
): Promise<LocalClaudeCliStatus> {
  return {
    ...(await probeLocalClaudeCliAsync(run)),
    label: "Claude subscription",
  };
}

export interface LocalClaudeCliRunners {
  sync: (args: readonly string[]) => ClaudeCliProbeRun;
  async: (args: readonly string[]) => Promise<ClaudeCliProbeRun>;
}

/** The status Electron main serves from its cache: first read probes synchronously, later reads refresh in the background. */
export function cachedLocalClaudeCliStatus(
  cache: CliStatusCache<LocalClaudeCliStatus>,
  runners: LocalClaudeCliRunners,
): LocalClaudeCliStatus {
  return cachedCliStatus(
    cache,
    () => readLocalClaudeCliStatus(runners.sync),
    () => readLocalClaudeCliStatusAsync(runners.async),
    Date.now,
    CLI_STATUS_TTL_MS,
  );
}

/**
 * Status for a caller that must see the CLI as it is now. `cachedCliStatus`
 * answers a refresh with the previous value while the re-probe runs, which is
 * the stale read a person gets right after signing in in Terminal, so a
 * refresh drops the cached value and waits for a fresh probe.
 */
export async function readLocalClaudeCliStatusFresh(
  cache: CliStatusCache<LocalClaudeCliStatus>,
  runners: LocalClaudeCliRunners,
  options: { refresh?: boolean } = {},
): Promise<LocalClaudeCliStatus> {
  if (!options.refresh) return cachedLocalClaudeCliStatus(cache, runners);
  invalidateCliStatusCache(cache);
  const generation = cache.generation;
  const status = await readLocalClaudeCliStatusAsync(runners.async);
  if (cache.generation === generation) {
    cache.value = status;
    cache.probedAt = Date.now();
  }
  return status;
}

/**
 * The login the code-agent runner accepts before a run. Mirrors
 * `assertClaudeCodeSubscription` in packages/core/src/cli/claude-code-participant.ts
 * (not exported there); `claude-subscription.spec.ts` pins the same cases.
 * "Signed in" in the picker must imply a run will start.
 */
export function claudeRunnerAcceptsLogin(
  raw: Record<string, unknown>,
): boolean {
  return (
    raw.loggedIn === true &&
    stringValue(raw.authMethod) === "claude.ai" &&
    stringValue(raw.apiProvider) === "firstParty" &&
    Boolean(stringValue(raw.subscriptionType))
  );
}

/** The model-list rows for the local Claude CLI; an uninstalled CLI has none. */
export function claudeCliModelOptions(input: {
  engine: string;
  supportedModels: readonly string[];
  probe: LocalClaudeCliProbe;
}): CodeAgentModelOption[] {
  if (!input.probe.available) return [];
  return input.supportedModels.map((model) => ({
    engine: input.engine,
    engineLabel: "Anthropic",
    model,
    label: model,
    description: "Run locally through your signed-in Claude subscription.",
    configured: input.probe.authenticated,
    ...(input.probe.authenticated
      ? { statusLabel: "Claude subscription", isSubscription: true }
      : {}),
    ...(input.probe.runtimeState
      ? { runtimeState: input.probe.runtimeState }
      : {}),
  }));
}

export function isClaudeSubscriptionStatus(
  status: SubscriptionStatus,
): boolean {
  return (
    status.providerId === "claude" &&
    status.connectionState === "connected" &&
    status.authMethod === "claude.ai" &&
    Boolean(status.plan?.type)
  );
}

export function getClaudeSubscriptionLoginLaunchSpec(
  platform: string,
  commandAvailable: CommandAvailable = () => true,
): ClaudeSubscriptionLoginLaunchSpec {
  if (platform === "darwin") {
    return {
      ok: true,
      command: "/usr/bin/osascript",
      args: [
        "-e",
        'tell application "Terminal" to do script "claude auth login --claudeai"',
        "-e",
        'tell application "Terminal" to activate',
      ],
    };
  }
  if (platform === "win32") {
    return {
      ok: true,
      command: "cmd.exe",
      args: ["/d", "/k", "claude auth login --claudeai"],
    };
  }
  if (platform === "linux") {
    const terminal = LINUX_TERMINAL_CANDIDATES.find((candidate) =>
      commandAvailable(candidate.command),
    );
    if (terminal) {
      return { ok: true, command: terminal.command, args: [...terminal.args] };
    }
    return {
      ok: false,
      error:
        "No supported terminal emulator was found. Install a terminal emulator and try again.",
    };
  }
  return {
    ok: false,
    error: `Opening a terminal is not supported on ${platform}.`,
  };
}

function connectionOnlyStatus(
  connectionState: "unavailable" | "error",
  connectionMessage: string,
): SubscriptionStatus {
  return {
    schemaVersion: 1,
    providerId: "claude",
    connectionState,
    connectionMessage,
    telemetry: connectionOnlyTelemetry(false),
  };
}

function connectionOnlyTelemetry(hasPlan: boolean): SubscriptionTelemetry {
  return {
    state: "unavailable",
    source: "connection-only",
    capabilities: {
      account: false,
      plan: hasPlan,
      rateLimits: false,
      modelTierRateLimits: false,
      contextWindow: false,
      credits: false,
      liveUpdates: false,
    },
    meters: [],
  };
}

function claudeLiveUsageUnsupportedTelemetry(
  hasPlan: boolean,
): SubscriptionTelemetry {
  return {
    ...connectionOnlyTelemetry(hasPlan),
    state: "unsupported",
    error: {
      message:
        "Claude Code does not expose live plan usage to non-interactive sessions.",
    },
  };
}

function parseAuthStatus(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function executeClaudeProcess(
  command: string,
  args: readonly string[],
  options: ClaudeProcessExecutorOptions,
  spawnProcess: SpawnClaudeProcess = (processCommand, processArgs) =>
    // Packaged macOS apps start with a bare PATH, so resolve claude in
    // ~/.local/bin etc. before spawning.
    spawn(
      resolveExecutable(processCommand, process.env) ?? processCommand,
      processArgs,
      {
        env: withResolvedExecutablePaths(process.env, [processCommand]),
        detached: false,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    ),
): Promise<ClaudeProcessResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;
    let terminationTimer: NodeJS.Timeout | undefined;
    let forceSettleTimer: NodeJS.Timeout | undefined;
    let child: ChildProcess | undefined;
    let failure: ClaudeProcessResult | undefined;
    const finish = (result: ClaudeProcessResult) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (terminationTimer) clearTimeout(terminationTimer);
      if (forceSettleTimer) clearTimeout(forceSettleTimer);
      resolve({ ...result, stdout, stderr });
    };
    const stop = (result: ClaudeProcessResult) => {
      if (settled || failure) return;
      failure = result;
      terminationTimer = setTimeout(() => {
        if (settled) return;
        forceSettleTimer = setTimeout(
          () => finish(failure ?? result),
          PROCESS_FORCE_SETTLE_MS,
        );
        child?.kill("SIGKILL");
      }, PROCESS_TERMINATION_GRACE_MS);
      child?.kill("SIGTERM");
    };
    try {
      child = spawnProcess(command, args);
      timeout = setTimeout(() => {
        timedOut = true;
        stop({ exitCode: null, stdout, stderr, timedOut: true });
      }, options.timeoutMs);
      child.stdout?.on("data", (chunk) => {
        stdout = appendBoundedOutput(stdout, chunk.toString());
      });
      child.stderr?.on("data", (chunk) => {
        stderr = appendBoundedOutput(stderr, chunk.toString());
      });
      child.stdout?.on("error", () => {
        stop({ exitCode: null, stdout, stderr, timedOut });
      });
      child.stderr?.on("error", () => {
        stop({ exitCode: null, stdout, stderr, timedOut });
      });
      child.on("error", (error: NodeJS.ErrnoException) => {
        stop({
          exitCode: null,
          stdout,
          stderr,
          timedOut,
          ...(typeof error.code === "string"
            ? { spawnErrorCode: error.code }
            : {}),
        });
      });
      child.once("close", (exitCode) => {
        finish(failure ?? { exitCode, stdout, stderr, timedOut });
      });
    } catch {
      finish({ exitCode: null, stdout, stderr });
    }
  });
}

function appendBoundedOutput(current: string, next: string): string {
  if (current.length >= MAX_STATUS_OUTPUT_CHARS) return current;
  return `${current}${next}`.slice(0, MAX_STATUS_OUTPUT_CHARS);
}
