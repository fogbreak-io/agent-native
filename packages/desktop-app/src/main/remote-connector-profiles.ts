import path from "node:path";

import type {
  CodeAgentRemoteConnectorStatus,
  RemoteConnectorConfigProblem,
  RemoteConnectorErrorReason,
  RemoteConnectorProfileFailure,
  RemoteConnectorProfileId,
  RemoteConnectorProfileResult,
  RemoteConnectorProfileState,
  RemoteConnectorProfileStatus,
} from "../../shared/ipc-channels";

const DEVICE_PATH_ENV = "AGENT_NATIVE_REMOTE_DEVICE_PATH";
const CODE_AGENTS_HOME_ENV = "AGENT_NATIVE_CODE_AGENTS_HOME";
const REGISTER_ENDPOINT = "/_agent-native/integrations/remote/register";
const UNREGISTER_ENDPOINT = "/_agent-native/integrations/remote/unregister";
const INITIAL_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;
const MAX_LOGGED_OUTPUT_CHARS = 500;
const SAFE_LOG_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

export const REMOTE_CONNECTOR_PROFILE_IDS = ["headtrip", "fogbreak"] as const;

export const FOGBREAK_REMOTE_RELAY_URL = "https://fogbreak.io/dispatch";

export function parseRemoteConnectorProfileId(
  value: unknown,
): RemoteConnectorProfileId | null {
  return typeof value === "string" &&
    (REMOTE_CONNECTOR_PROFILE_IDS as readonly string[]).includes(value)
    ? (value as RemoteConnectorProfileId)
    : null;
}

export function normalizeRemoteRelayUrl(
  value: string | undefined,
): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    return `${url.origin}${url.pathname.replace(/\/+$/, "") || "/"}`;
    // coercion-ok: an unparseable URL is an absent relay candidate, not a failure.
  } catch {
    return undefined;
  }
}

/**
 * Joins a relay endpoint onto the relay's own base path. `new URL("/x", base)`
 * would drop a mounted path such as /dispatch and hit the origin root instead.
 */
export function relayEndpointUrl(relayUrl: string, endpoint: string): string {
  const base = new URL(relayUrl);
  return new URL(
    `${base.pathname.replace(/\/+$/, "")}${endpoint}`,
    base.origin,
  ).toString();
}

export interface RemoteConnectorProfile {
  id: RemoteConnectorProfileId;
  deviceConfigPath: string;
  /** Fixed relay for this profile, or null when the pairing file names it. */
  fixedRelayUrl: string | null;
  codeAgentsHome: string;
  computerRunId: string;
  unpairable: boolean;
}

export interface RemoteConnectorProfilePaths {
  homeDir: string;
  /** AGENT_NATIVE_REMOTE_DEVICE_PATH as set for Fogbreak.app; headtrip only. */
  ambientDevicePath?: string | undefined;
  codeAgentsHome: string;
}

/**
 * headtrip is the pairing Fogbreak.app has always used, so it keeps the
 * original device path, store and computer-control id. fogbreak never follows
 * the ambient device-path override and gets its own run store so a connector
 * never flushes the other relay's run transcripts.
 */
export function resolveRemoteConnectorProfile(
  id: RemoteConnectorProfileId,
  paths: RemoteConnectorProfilePaths,
): RemoteConnectorProfile {
  const agentNativeDir = path.join(paths.homeDir, ".agent-native");
  if (id === "headtrip") {
    return {
      id,
      deviceConfigPath: path.resolve(
        paths.ambientDevicePath ??
          path.join(agentNativeDir, "remote-device.json"),
      ),
      fixedRelayUrl: null,
      codeAgentsHome: paths.codeAgentsHome,
      computerRunId: "__remote_connector__",
      unpairable: false,
    };
  }
  return {
    id,
    deviceConfigPath: path.resolve(
      path.join(agentNativeDir, "remote-device-fogbreak.json"),
    ),
    fixedRelayUrl: FOGBREAK_REMOTE_RELAY_URL,
    codeAgentsHome: path.resolve(
      path.join(agentNativeDir, "code-agents-fogbreak"),
    ),
    computerRunId: "__remote_connector__:fogbreak",
    unpairable: true,
  };
}

export interface RemoteDeviceConfig {
  token: string;
  relayUrl?: string | undefined;
  deviceId?: string | undefined;
  deviceName?: string | undefined;
  workspacePath?: string | undefined;
}

export type RemoteDeviceConfigRead =
  | { kind: "absent" }
  | { kind: "unreadable"; problem: RemoteConnectorConfigProblem }
  | { kind: "ok"; config: RemoteDeviceConfig; relayUrl: string };

type ConfigOk = Extract<RemoteDeviceConfigRead, { kind: "ok" }>;

export interface RemoteConnectorFileIo {
  readFile(filePath: string): string;
  writeJsonAtomic(
    filePath: string,
    value: unknown,
    options: { mode: number },
  ): void;
  removeFile(filePath: string): void;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function isNotFound(error: unknown): boolean {
  return isObject(error) && error.code === "ENOENT";
}

function setIfDefined<T, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined,
): void {
  if (value !== undefined) target[key] = value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function readRemoteDeviceConfig(
  profile: RemoteConnectorProfile,
  io: RemoteConnectorFileIo,
): RemoteDeviceConfigRead {
  let text: string;
  try {
    text = io.readFile(profile.deviceConfigPath);
  } catch (error) {
    return isNotFound(error)
      ? { kind: "absent" }
      : { kind: "unreadable", problem: "io-error" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: "unreadable", problem: "invalid-json" };
  }
  if (!isObject(raw)) return { kind: "unreadable", problem: "invalid-shape" };
  const token = firstString(
    raw.token,
    raw.deviceToken,
    raw.relayToken,
    raw.accessToken,
    raw.bearerToken,
  );
  if (!token) return { kind: "unreadable", problem: "missing-token" };
  const config: RemoteDeviceConfig = {
    token,
    relayUrl: firstString(raw.relayUrl, raw.url, raw.baseUrl),
    deviceId: firstString(raw.deviceId, raw.id),
    deviceName: firstString(raw.deviceName, raw.name),
    workspacePath: firstString(
      raw.workspacePath,
      raw.workspace,
      raw.cwd,
      raw.projectPath,
    ),
  };
  const relayUrl = normalizeRemoteRelayUrl(config.relayUrl);
  if (!relayUrl) return { kind: "unreadable", problem: "missing-relay-url" };
  // A token only ever goes to the relay that minted it.
  if (profile.fixedRelayUrl && relayUrl !== profile.fixedRelayUrl) {
    return { kind: "unreadable", problem: "relay-mismatch" };
  }
  return { kind: "ok", config, relayUrl };
}

export function writeRemoteDeviceConfig(
  profile: RemoteConnectorProfile,
  io: RemoteConnectorFileIo,
  config: RemoteDeviceConfig & { relayUrl: string },
): void {
  io.writeJsonAtomic(
    profile.deviceConfigPath,
    {
      token: config.token,
      relayUrl: config.relayUrl,
      deviceId: config.deviceId,
      deviceName: config.deviceName,
      workspacePath: config.workspacePath,
    },
    { mode: 0o600 },
  );
}

export interface ConnectorInvocation {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export interface ConnectorSpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export function buildConnectorSpawn(input: {
  profile: RemoteConnectorProfile;
  relayUrl: string;
  invocation: ConnectorInvocation;
  baseEnv: NodeJS.ProcessEnv;
  computerEnv: NodeJS.ProcessEnv;
}): ConnectorSpawnSpec {
  const { profile, relayUrl, invocation } = input;
  return {
    command: invocation.command,
    args: [...invocation.args, "code", "serve", "--relay-url", relayUrl],
    cwd: invocation.cwd,
    env: {
      ...input.baseEnv,
      ...invocation.env,
      ...input.computerEnv,
      [CODE_AGENTS_HOME_ENV]: profile.codeAgentsHome,
      [DEVICE_PATH_ENV]: profile.deviceConfigPath,
    },
  };
}

export function redactSecrets(
  text: string,
  secrets: readonly string[],
): string {
  let redacted = text
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(
      /\b([\w.-]*(?:session|token|secret|cookie|auth)[\w.-]*)=[^\s;,"']+/gi,
      "$1=[redacted]",
    );
  for (const secret of secrets) {
    if (secret) redacted = redacted.split(secret).join("[redacted]");
  }
  return redacted;
}

function relayHostOf(relayUrl: string | undefined | null): string {
  if (!relayUrl) return "unknown";
  try {
    return new URL(relayUrl).host;
  } catch {
    return "unknown";
  }
}

function safeLogValue(value: string | undefined): string {
  if (!value) return "none";
  return SAFE_LOG_VALUE.test(value) ? value : "invalid";
}

export interface ConnectorChild {
  readonly pid: number | undefined;
  kill(signal: NodeJS.Signals): void;
  onStdout(listener: (text: string) => void): void;
  onStderr(listener: (text: string) => void): void;
  onExit(listener: (code: number | null, signal: string | null) => void): void;
  onError(listener: (error: Error) => void): void;
}

export interface RelayResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export interface RelayRequest {
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

export interface RemoteConnectorLog {
  info(line: string): void;
  warn(line: string): void;
  /** headtrip child output, kept under the original `[remote-code-agent]` prefix. */
  childOutput(stream: "stdout" | "stderr", text: string): void;
}

export interface RemoteConnectorSupervisorDeps {
  paths: () => RemoteConnectorProfilePaths;
  io: RemoteConnectorFileIo;
  spawn: (spec: ConnectorSpawnSpec) => ConnectorChild;
  resolveInvocation: () => ConnectorInvocation;
  baseEnv: () => NodeJS.ProcessEnv;
  prepareComputer: () => Promise<void>;
  computerEnv: (runId: string) => NodeJS.ProcessEnv;
  revokeComputer: (runId: string) => void;
  /** Session-cookie request to the relay; used to register this computer. */
  relayFetch: (
    profile: RemoteConnectorProfileId,
    url: string,
    request: RelayRequest,
  ) => Promise<RelayResponse>;
  /** Device-token request to the relay; used to unregister this computer. */
  deviceFetch: (url: string, request: RelayRequest) => Promise<RelayResponse>;
  persistEnabled: (profile: RemoteConnectorProfileId, enabled: boolean) => void;
  hostLabel: () => string;
  defaultWorkspacePath: () => string | undefined;
  log: RemoteConnectorLog;
  now: () => number;
  setTimer: (callback: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  isQuitting: () => boolean;
}

interface ProfileRuntime {
  enabled: boolean;
  child: ConnectorChild | null;
  startPromise: Promise<void> | null;
  pairPromise: Promise<RemoteConnectorProfileResult> | null;
  restartTimer: unknown;
  restartCount: number;
  startedAt?: string | undefined;
  lastExitAt?: string | undefined;
  lastExitCode?: number | null | undefined;
  lastExitSignal?: string | null | undefined;
  nextRestartAt?: string | undefined;
  error?: { reason: RemoteConnectorErrorReason; message: string } | undefined;
}

export interface PairRequest {
  /** headtrip only: fogbreak always uses its fixed relay. */
  relayUrl?: string | undefined;
  label?: string | undefined;
  workspacePath?: string | undefined;
  /** Register a fresh device even when this profile is already paired. */
  repair?: boolean | undefined;
}

const CONFIG_PROBLEM_MESSAGE: Record<RemoteConnectorConfigProblem, string> = {
  "io-error": "The pairing file could not be read.",
  "invalid-json": "The pairing file is not valid JSON.",
  "invalid-shape": "The pairing file is not a JSON object.",
  "missing-token": "The pairing file has no device token.",
  "missing-relay-url": "Remote device config is missing relayUrl.",
  "relay-mismatch": "The pairing file belongs to a different relay.",
};

class ConnectorStartError extends Error {
  constructor(
    readonly reason: RemoteConnectorErrorReason,
    message: string,
  ) {
    super(message);
  }
}

/**
 * One connector child per profile. Each profile owns its own enabled flag,
 * process handle, restart timer, backoff and status, so one profile failing,
 * stopping or unpairing never touches another.
 */
export class RemoteConnectorSupervisor {
  private readonly runtimes = new Map<
    RemoteConnectorProfileId,
    ProfileRuntime
  >();

  constructor(private readonly deps: RemoteConnectorSupervisorDeps) {
    for (const id of REMOTE_CONNECTOR_PROFILE_IDS) {
      this.runtimes.set(id, {
        enabled: false,
        child: null,
        startPromise: null,
        pairPromise: null,
        restartTimer: null,
        restartCount: 0,
      });
    }
  }

  profile(id: RemoteConnectorProfileId): RemoteConnectorProfile {
    return resolveRemoteConnectorProfile(id, this.deps.paths());
  }

  readConfig(id: RemoteConnectorProfileId): RemoteDeviceConfigRead {
    return readRemoteDeviceConfig(this.profile(id), this.deps.io);
  }

  /** Marks every profile disabled without touching a process; used at launch. */
  resetEnabled(): void {
    for (const runtime of this.runtimes.values()) runtime.enabled = false;
  }

  status(id: RemoteConnectorProfileId): RemoteConnectorProfileStatus {
    const runtime = this.runtime(id);
    const read = this.readConfig(id);
    const ok = read.kind === "ok" ? read : null;
    let state: RemoteConnectorProfileState = "stopped";
    let errorReason = runtime.error?.reason;
    let error = runtime.error?.message;
    if (!runtime.enabled) state = "disabled";
    else if (read.kind === "absent") state = "unconfigured";
    else if (read.kind === "unreadable") {
      state = "error";
      errorReason = "config-unreadable";
      error = CONFIG_PROBLEM_MESSAGE[read.problem];
    } else if (runtime.child?.pid) state = "running";
    else if (runtime.nextRestartAt || runtime.startPromise) state = "starting";
    else if (runtime.error) state = "error";
    if (error && ok) error = redactSecrets(error, [ok.config.token]);
    return {
      profile: id,
      state,
      enabled: runtime.enabled,
      config: read.kind === "ok" ? "configured" : read.kind,
      ...(read.kind === "unreadable" ? { configProblem: read.problem } : {}),
      relayUrl: ok?.relayUrl,
      relayHost: ok ? relayHostOf(ok.relayUrl) : undefined,
      deviceId: ok?.config.deviceId,
      pid: runtime.child?.pid,
      startedAt: runtime.startedAt,
      lastExitAt: runtime.lastExitAt,
      lastExitCode: runtime.lastExitCode,
      lastExitSignal: runtime.lastExitSignal,
      restartCount: runtime.restartCount,
      nextRestartAt: runtime.nextRestartAt,
      errorReason,
      error,
    };
  }

  /** The original single-connector status shape, for the original profile. */
  legacyStatus(): CodeAgentRemoteConnectorStatus {
    const status = this.status("headtrip");
    const read = this.readConfig("headtrip");
    const legacy: CodeAgentRemoteConnectorStatus = {
      state:
        status.state === "error" && status.config === "unreadable"
          ? "unconfigured"
          : status.state,
      enabled: status.enabled,
      configured: read.kind === "ok",
      configPath: this.profile("headtrip").deviceConfigPath,
      restartCount: status.restartCount,
    };
    if (read.kind === "ok") {
      setIfDefined(legacy, "relayUrl", read.relayUrl);
      setIfDefined(legacy, "workspacePath", read.config.workspacePath);
    }
    setIfDefined(legacy, "pid", status.pid);
    setIfDefined(legacy, "startedAt", status.startedAt);
    setIfDefined(legacy, "lastExitAt", status.lastExitAt);
    setIfDefined(legacy, "lastExitCode", status.lastExitCode);
    setIfDefined(legacy, "lastExitSignal", status.lastExitSignal);
    setIfDefined(legacy, "nextRestartAt", status.nextRestartAt);
    setIfDefined(legacy, "error", status.error);
    return legacy;
  }

  async setEnabled(
    id: RemoteConnectorProfileId,
    enabled: boolean,
  ): Promise<RemoteConnectorProfileStatus> {
    const runtime = this.runtime(id);
    runtime.enabled = enabled;
    try {
      this.deps.persistEnabled(id, enabled);
    } catch (error) {
      runtime.error = {
        reason: "settings-save-failed",
        message: errorMessage(error),
      };
    }
    runtime.restartCount = 0;
    if (!enabled) {
      this.stopProcess(id, runtime);
      this.logState(id, "stopped");
      return this.status(id);
    }
    await this.start(id);
    return this.status(id);
  }

  async restart(
    id: RemoteConnectorProfileId,
  ): Promise<RemoteConnectorProfileResult> {
    const runtime = this.runtime(id);
    if (!runtime.enabled) {
      return {
        ok: false,
        reason: "disabled",
        error: "Turn the connector on before restarting it.",
        status: this.status(id),
      };
    }
    this.stopProcess(id, runtime);
    runtime.restartCount = 0;
    await this.start(id);
    return { ok: true, status: this.status(id) };
  }

  start(id: RemoteConnectorProfileId): Promise<void> {
    const runtime = this.runtime(id);
    if (runtime.startPromise) return runtime.startPromise;
    const startPromise = this.startInternal(id, runtime);
    runtime.startPromise = startPromise;
    return startPromise.finally(() => {
      if (runtime.startPromise === startPromise) runtime.startPromise = null;
    });
  }

  /** Stops every connector process and timer; used when the app quits. */
  stopAll(): void {
    for (const id of REMOTE_CONNECTOR_PROFILE_IDS) {
      const runtime = this.runtime(id);
      this.clearRestartTimer(runtime);
      runtime.child?.kill("SIGTERM");
      runtime.child = null;
    }
  }

  pair(
    id: RemoteConnectorProfileId,
    request: PairRequest,
  ): Promise<RemoteConnectorProfileResult> {
    const runtime = this.runtime(id);
    if (runtime.pairPromise) return runtime.pairPromise;
    const pairPromise = this.pairInternal(id, runtime, request);
    runtime.pairPromise = pairPromise;
    return pairPromise.finally(() => {
      if (runtime.pairPromise === pairPromise) runtime.pairPromise = null;
    });
  }

  /** Removes only this profile's pairing file after stopping its connector. */
  async unpair(
    id: RemoteConnectorProfileId,
  ): Promise<RemoteConnectorProfileResult> {
    const profile = this.profile(id);
    const runtime = this.runtime(id);
    if (!profile.unpairable) {
      return {
        ok: false,
        reason: "profile-protected",
        error: "This pairing cannot be removed from here.",
        status: this.status(id),
      };
    }
    const read = this.readConfig(id);
    runtime.enabled = false;
    this.stopProcess(id, runtime);
    runtime.restartCount = 0;
    runtime.error = undefined;
    const remoteRevoked =
      read.kind === "ok" ? await this.unregisterDevice(read) : undefined;
    if (read.kind !== "absent") {
      try {
        this.deps.io.removeFile(profile.deviceConfigPath);
      } catch (error) {
        if (!isNotFound(error)) {
          return {
            ok: false,
            reason: "write-failed",
            error: "The pairing file could not be removed.",
            status: this.status(id),
            remoteRevoked,
          };
        }
      }
    }
    this.logState(id, "unpaired", {
      deviceId: read.kind === "ok" ? read.config.deviceId : undefined,
      relayUrl: read.kind === "ok" ? read.relayUrl : undefined,
    });
    return { ok: true, status: this.status(id), remoteRevoked };
  }

  // Read through a method so a caller can re-check after an await without the
  // compiler remembering the value it narrowed before the await.
  private isEnabled(runtime: ProfileRuntime): boolean {
    return runtime.enabled;
  }

  private runtime(id: RemoteConnectorProfileId): ProfileRuntime {
    const runtime = this.runtimes.get(id);
    if (!runtime) throw new Error(`Unknown remote connector profile: ${id}`);
    return runtime;
  }

  private async unregisterDevice(read: ConfigOk): Promise<boolean> {
    try {
      const response = await this.deps.deviceFetch(
        relayEndpointUrl(read.relayUrl, UNREGISTER_ENDPOINT),
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${read.config.token}`,
            "x-agent-native-device-token": read.config.token,
            "content-type": "application/json",
          },
          body: "{}",
        },
      );
      return response.ok;
      // coercion-ok: the caller reports remoteRevoked=false; removing the local file does not depend on it.
    } catch {
      return false;
    }
  }

  private async startInternal(
    id: RemoteConnectorProfileId,
    runtime: ProfileRuntime,
  ): Promise<void> {
    if (!runtime.enabled || this.deps.isQuitting()) return;
    if (runtime.child) return;
    const profile = this.profile(id);
    const read = readRemoteDeviceConfig(profile, this.deps.io);
    if (read.kind === "absent") return;
    if (read.kind === "unreadable") {
      runtime.error = {
        reason: "config-unreadable",
        message: CONFIG_PROBLEM_MESSAGE[read.problem],
      };
      this.logState(id, "error", { reason: "config-unreadable" });
      return;
    }
    this.clearRestartTimer(runtime);
    runtime.nextRestartAt = undefined;
    runtime.error = undefined;

    try {
      try {
        await this.deps.prepareComputer();
      } catch (error) {
        throw new ConnectorStartError(
          "computer-bridge-unavailable",
          errorMessage(error),
        );
      }
      if (!this.isEnabled(runtime) || this.deps.isQuitting()) return;
      const spec = buildConnectorSpawn({
        profile,
        relayUrl: read.relayUrl,
        invocation: this.deps.resolveInvocation(),
        baseEnv: this.deps.baseEnv(),
        computerEnv: this.deps.computerEnv(profile.computerRunId),
      });
      let child: ConnectorChild;
      try {
        child = this.deps.spawn(spec);
      } catch (error) {
        throw new ConnectorStartError("spawn-failed", errorMessage(error));
      }
      this.attachChild(id, runtime, profile, read, child);
    } catch (error) {
      this.deps.revokeComputer(profile.computerRunId);
      const reason =
        error instanceof ConnectorStartError ? error.reason : "spawn-failed";
      runtime.error = { reason, message: errorMessage(error) };
      this.logState(id, "error", { reason, read });
      this.scheduleRestart(id, runtime);
    }
  }

  private attachChild(
    id: RemoteConnectorProfileId,
    runtime: ProfileRuntime,
    profile: RemoteConnectorProfile,
    read: ConfigOk,
    child: ConnectorChild,
  ): void {
    runtime.child = child;
    runtime.startedAt = new Date(this.deps.now()).toISOString();
    const secrets = [read.config.token];
    const forward = (stream: "stdout" | "stderr") => (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const safe = redactSecrets(trimmed, secrets);
      if (id === "headtrip") {
        this.deps.log.childOutput(stream, safe);
        return;
      }
      this.deps.log.info(
        `${this.logPrefix(id, read.relayUrl, read.config.deviceId)} output=${JSON.stringify(
          safe.slice(0, MAX_LOGGED_OUTPUT_CHARS),
        )}`,
      );
    };
    child.onStdout(forward("stdout"));
    child.onStderr(forward("stderr"));
    child.onExit((code, signal) => {
      runtime.lastExitAt = new Date(this.deps.now()).toISOString();
      runtime.lastExitCode = code;
      runtime.lastExitSignal = signal;
      // A superseded child (stopped, repaired or restarted) must not revoke
      // the new child's computer registration or schedule a second restart.
      if (runtime.child !== child) return;
      runtime.child = null;
      this.deps.revokeComputer(profile.computerRunId);
      const restart = !this.deps.isQuitting() && runtime.enabled;
      this.logState(id, restart ? "starting" : "stopped", {
        read,
        exitCode: code,
      });
      if (restart) this.scheduleRestart(id, runtime);
    });
    child.onError((error) => {
      if (runtime.child !== child) return;
      runtime.child = null;
      this.deps.revokeComputer(profile.computerRunId);
      runtime.error = { reason: "spawn-failed", message: errorMessage(error) };
      this.logState(id, "error", { reason: "spawn-failed", read });
      if (!this.deps.isQuitting() && runtime.enabled) {
        this.scheduleRestart(id, runtime);
      }
    });
    this.logState(id, "running", { read });
  }

  private scheduleRestart(
    id: RemoteConnectorProfileId,
    runtime: ProfileRuntime,
  ): void {
    if (runtime.restartTimer || !runtime.enabled || this.deps.isQuitting()) {
      return;
    }
    const delay = Math.min(
      INITIAL_BACKOFF_MS * Math.max(1, 2 ** runtime.restartCount),
      MAX_BACKOFF_MS,
    );
    runtime.restartCount += 1;
    runtime.nextRestartAt = new Date(this.deps.now() + delay).toISOString();
    runtime.restartTimer = this.deps.setTimer(() => {
      runtime.restartTimer = null;
      runtime.nextRestartAt = undefined;
      void this.start(id);
    }, delay);
  }

  private clearRestartTimer(runtime: ProfileRuntime): void {
    if (runtime.restartTimer) {
      this.deps.clearTimer(runtime.restartTimer);
      runtime.restartTimer = null;
    }
  }

  private stopProcess(
    id: RemoteConnectorProfileId,
    runtime: ProfileRuntime,
  ): void {
    this.clearRestartTimer(runtime);
    runtime.nextRestartAt = undefined;
    const child = runtime.child;
    runtime.child = null;
    if (!child) return;
    this.deps.revokeComputer(this.profile(id).computerRunId);
    try {
      child.kill("SIGTERM");
    } catch (error) {
      runtime.error = { reason: "spawn-failed", message: errorMessage(error) };
    }
  }

  private async pairInternal(
    id: RemoteConnectorProfileId,
    runtime: ProfileRuntime,
    request: PairRequest,
  ): Promise<RemoteConnectorProfileResult> {
    const profile = this.profile(id);
    const relayUrl = normalizeRemoteRelayUrl(
      profile.fixedRelayUrl ?? request.relayUrl,
    );
    if (!relayUrl) {
      return this.pairFailure(
        id,
        "invalid-relay-url",
        "Enter a valid Agent-Native app URL to pair remote control.",
      );
    }
    if (id === "headtrip" && relayUrl === FOGBREAK_REMOTE_RELAY_URL) {
      return this.pairFailure(
        id,
        "use-profile-channel",
        "Pair the Fogbreak relay from its own row.",
      );
    }
    const existing = readRemoteDeviceConfig(profile, this.deps.io);
    if (existing.kind === "ok" && id === "fogbreak" && !request.repair) {
      runtime.enabled = true;
      runtime.error = undefined;
      runtime.restartCount = 0;
      await this.start(id);
      return {
        ok: true,
        status: this.status(id),
        deviceId: existing.config.deviceId,
        message: "Already paired.",
      };
    }

    let response: RelayResponse;
    try {
      response = await this.deps.relayFetch(
        id,
        relayEndpointUrl(relayUrl, REGISTER_ENDPOINT),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            label: request.label ?? `${this.deps.hostLabel()} Desktop`,
          }),
        },
      );
    } catch (error) {
      runtime.error = {
        reason: "pairing-failed",
        message: errorMessage(error),
      };
      this.logState(id, "error", { reason: "pairing-failed", relayUrl });
      return {
        ok: false,
        reason: "relay-unreachable",
        error: errorMessage(error),
        status: this.status(id),
      };
    }

    let payload: unknown;
    try {
      const text = await response.text();
      payload = text ? (JSON.parse(text) as unknown) : null;
    } catch {
      return this.pairFailure(
        id,
        "relay-invalid-response",
        `Remote pairing returned an unreadable response from ${relayHostOf(relayUrl)}.`,
      );
    }
    if (!response.ok || !isObject(payload)) {
      const message = isObject(payload)
        ? firstString(payload.error, payload.message)
        : undefined;
      return this.pairFailure(
        id,
        response.status === 401 || response.status === 403
          ? "signed-out"
          : "relay-rejected",
        message ??
          `Remote pairing returned ${response.status} from ${relayHostOf(relayUrl)}.`,
      );
    }

    const device = isObject(payload.device) ? payload.device : {};
    const token = firstString(
      payload.token,
      payload.deviceToken,
      payload.relayToken,
      payload.accessToken,
    );
    if (!token) {
      return this.pairFailure(
        id,
        "no-token",
        firstString(payload.error, payload.message) ??
          "The app did not return a remote device token.",
      );
    }
    const deviceId = firstString(payload.deviceId, device.id);
    const deviceName = firstString(
      payload.deviceName,
      payload.label,
      device.label,
      device.name,
    );
    const workspacePath =
      request.workspacePath ??
      (existing.kind === "ok" ? existing.config.workspacePath : undefined) ??
      this.deps.defaultWorkspacePath();
    try {
      writeRemoteDeviceConfig(profile, this.deps.io, {
        token,
        relayUrl,
        deviceId,
        deviceName,
        workspacePath,
      });
    } catch {
      return this.pairFailure(
        id,
        "write-failed",
        "The pairing file could not be saved.",
      );
    }

    runtime.enabled = true;
    runtime.error = undefined;
    try {
      this.deps.persistEnabled(id, true);
    } catch (error) {
      runtime.error = {
        reason: "settings-save-failed",
        message: errorMessage(error),
      };
    }
    runtime.restartCount = 0;
    this.stopProcess(id, runtime);
    this.logState(id, "paired", { deviceId, relayUrl });
    await this.start(id);
    return {
      ok: true,
      status: this.status(id),
      deviceId,
      message: "Remote control paired.",
    };
  }

  private pairFailure(
    id: RemoteConnectorProfileId,
    reason: RemoteConnectorProfileFailure,
    error: string,
  ): RemoteConnectorProfileResult {
    this.logState(id, "pair-failed", { failure: reason });
    return { ok: false, reason, error, status: this.status(id) };
  }

  private logPrefix(
    id: RemoteConnectorProfileId,
    relayUrl: string | undefined | null,
    deviceId: string | undefined,
  ): string {
    return `[remote-connector] profile=${id} relay=${relayHostOf(relayUrl)} deviceId=${safeLogValue(deviceId)}`;
  }

  private logState(
    id: RemoteConnectorProfileId,
    state: string,
    detail: {
      read?: ConfigOk | undefined;
      relayUrl?: string | undefined;
      deviceId?: string | undefined;
      reason?: RemoteConnectorErrorReason | undefined;
      failure?: RemoteConnectorProfileFailure | undefined;
      exitCode?: number | null | undefined;
    } = {},
  ): void {
    const relayUrl =
      detail.read?.relayUrl ??
      detail.relayUrl ??
      this.profile(id).fixedRelayUrl;
    const deviceId = detail.deviceId ?? detail.read?.config.deviceId;
    const line = [
      this.logPrefix(id, relayUrl, deviceId),
      `state=${state}`,
      ...(detail.reason ? [`reason=${detail.reason}`] : []),
      ...(detail.failure ? [`failure=${detail.failure}`] : []),
      ...(detail.exitCode !== undefined ? [`exitCode=${detail.exitCode}`] : []),
    ].join(" ");
    if (state === "error" || state === "pair-failed") this.deps.log.warn(line);
    else this.deps.log.info(line);
  }
}

export interface ParsedProfileRequest {
  profile: RemoteConnectorProfileId;
  enabled?: boolean | undefined;
  repair: boolean;
}

/** Renderer input is intent only: a profile id and booleans, nothing else. */
export function parseProfileRequest(
  input: unknown,
):
  | { ok: true; request: ParsedProfileRequest }
  | { ok: false; result: RemoteConnectorProfileResult } {
  if (!isObject(input)) {
    return {
      ok: false,
      result: {
        ok: false,
        reason: "invalid-request",
        error: "Expected a profile request.",
      },
    };
  }
  const profile = parseRemoteConnectorProfileId(
    Object.hasOwn(input, "profile") ? input.profile : undefined,
  );
  if (!profile) {
    return {
      ok: false,
      result: {
        ok: false,
        reason: "invalid-profile",
        error: "Unknown remote connector profile.",
      },
    };
  }
  return {
    ok: true,
    request: {
      profile,
      enabled: typeof input.enabled === "boolean" ? input.enabled : undefined,
      repair: input.repair === true,
    },
  };
}

export interface RemoteConnectorProfileHandlers {
  getStatus(input: unknown): RemoteConnectorProfileResult;
  setEnabled(input: unknown): Promise<RemoteConnectorProfileResult>;
  pair(input: unknown): Promise<RemoteConnectorProfileResult>;
  restart(input: unknown): Promise<RemoteConnectorProfileResult>;
  unpair(input: unknown): Promise<RemoteConnectorProfileResult>;
}

export function createRemoteConnectorProfileHandlers(
  supervisor: RemoteConnectorSupervisor,
): RemoteConnectorProfileHandlers {
  return {
    getStatus(input) {
      const parsed = parseProfileRequest(input);
      if (!parsed.ok) return parsed.result;
      return { ok: true, status: supervisor.status(parsed.request.profile) };
    },
    async setEnabled(input) {
      const parsed = parseProfileRequest(input);
      if (!parsed.ok) return parsed.result;
      if (parsed.request.enabled === undefined) {
        return {
          ok: false,
          reason: "invalid-request",
          error: "Expected enabled to be true or false.",
        };
      }
      const status = await supervisor.setEnabled(
        parsed.request.profile,
        parsed.request.enabled,
      );
      return { ok: true, status };
    },
    async pair(input) {
      const parsed = parseProfileRequest(input);
      if (!parsed.ok) return parsed.result;
      if (parsed.request.profile === "headtrip") {
        return {
          ok: false,
          reason: "profile-protected",
          error: "The original pairing is managed from its own settings row.",
          status: supervisor.status("headtrip"),
        };
      }
      return supervisor.pair(parsed.request.profile, {
        repair: parsed.request.repair,
      });
    },
    async restart(input) {
      const parsed = parseProfileRequest(input);
      if (!parsed.ok) return parsed.result;
      return supervisor.restart(parsed.request.profile);
    },
    async unpair(input) {
      const parsed = parseProfileRequest(input);
      if (!parsed.ok) return parsed.result;
      return supervisor.unpair(parsed.request.profile);
    },
  };
}
