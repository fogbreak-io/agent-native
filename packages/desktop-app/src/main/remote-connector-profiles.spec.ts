import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FOGBREAK_SESSION_PARTITION } from "../../shared/fogbreak";
import {
  FOGBREAK_REMOTE_RELAY_URL,
  RemoteConnectorSupervisor,
  buildConnectorSpawn,
  chooseRelaySession,
  createRemoteConnectorProfileHandlers,
  isFogbreakRelayUrl,
  isPairableRelayUrl,
  parseProfileRequest,
  parseRemoteConnectorProfileId,
  readRemoteDeviceConfig,
  redactSecrets,
  relayEndpointUrl,
  resolveRemoteConnectorProfile,
  type ConnectorChild,
  type ConnectorSpawnSpec,
  type RelayRequest,
  type RelayResponse,
  type RemoteConnectorFileIo,
} from "./remote-connector-profiles";

const HOME = "/home/kean";
const AGENT_NATIVE_DIR = path.join(HOME, ".agent-native");
const HEADTRIP_FILE = path.join(AGENT_NATIVE_DIR, "remote-device.json");
const FOGBREAK_FILE = path.join(
  AGENT_NATIVE_DIR,
  "remote-device-fogbreak.json",
);
const CODE_AGENTS_HOME = path.join(AGENT_NATIVE_DIR, "code-agents");
const HEADTRIP_RELAY = "https://headtrip.example.workers.dev";
const HEADTRIP_TOKEN = "tok_headtrip_SECRET_0001";
const FOGBREAK_TOKEN = "tok_fogbreak_SECRET_0002";
const COOKIE = "an_session=COOKIE_SECRET_0003";
const SECRETS = [HEADTRIP_TOKEN, FOGBREAK_TOKEN, COOKIE, "COOKIE_SECRET_0003"];

function nth<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`No item at index ${index}`);
  return item;
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

class MemoryIo implements RemoteConnectorFileIo {
  files = new Map<string, string>();
  modes = new Map<string, number>();
  ops: Array<{ op: "read" | "write" | "remove"; path: string }> = [];
  readErrors = new Map<string, NodeJS.ErrnoException>();
  removeErrors = new Map<string, NodeJS.ErrnoException>();
  writeError: Error | null = null;

  readFile(filePath: string): string {
    this.ops.push({ op: "read", path: filePath });
    const failure = this.readErrors.get(filePath);
    if (failure) throw failure;
    const value = this.files.get(filePath);
    if (value === undefined) throw errno("ENOENT");
    return value;
  }

  writeJsonAtomic(
    filePath: string,
    value: unknown,
    options: { mode: number },
  ): void {
    this.ops.push({ op: "write", path: filePath });
    if (this.writeError) throw this.writeError;
    this.files.set(filePath, JSON.stringify(value));
    this.modes.set(filePath, options.mode);
  }

  removeFile(filePath: string): void {
    this.ops.push({ op: "remove", path: filePath });
    const failure = this.removeErrors.get(filePath);
    if (failure) throw failure;
    if (!this.files.delete(filePath)) throw errno("ENOENT");
  }

  opsOn(filePath: string) {
    return this.ops.filter((entry) => entry.path === filePath);
  }

  seed(filePath: string, value: unknown) {
    this.files.set(filePath, JSON.stringify(value));
  }
}

class FakeChild implements ConnectorChild {
  killed: NodeJS.Signals[] = [];
  private stdout: Array<(text: string) => void> = [];
  private stderr: Array<(text: string) => void> = [];
  private exits: Array<(code: number | null, signal: string | null) => void> =
    [];
  private errors: Array<(error: Error) => void> = [];
  constructor(
    readonly pid: number,
    readonly spec: ConnectorSpawnSpec,
  ) {}
  kill(signal: NodeJS.Signals) {
    this.killed.push(signal);
  }
  onStdout(listener: (text: string) => void) {
    this.stdout.push(listener);
  }
  onStderr(listener: (text: string) => void) {
    this.stderr.push(listener);
  }
  onExit(listener: (code: number | null, signal: string | null) => void) {
    this.exits.push(listener);
  }
  onError(listener: (error: Error) => void) {
    this.errors.push(listener);
  }
  emitStdout(text: string) {
    for (const listener of this.stdout) listener(text);
  }
  emitStderr(text: string) {
    for (const listener of this.stderr) listener(text);
  }
  emitExit(code: number | null, signal: string | null = null) {
    for (const listener of this.exits) listener(code, signal);
  }
  emitError(error: Error) {
    for (const listener of this.errors) listener(error);
  }
}

function response(body: unknown, status = 200): RelayResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

type RelayHandler = (
  profile: string,
  url: string,
  request: RelayRequest,
) => Promise<RelayResponse>;

interface HarnessOptions {
  ambientDevicePath?: string;
  relayHandler?: RelayHandler;
  deviceHandler?: (
    url: string,
    request: RelayRequest,
  ) => Promise<RelayResponse>;
  prepareComputer?: () => Promise<void>;
  spawnError?: Error;
}

function createHarness(options: HarnessOptions = {}) {
  const io = new MemoryIo();
  const children: FakeChild[] = [];
  const timers: Array<{
    id: number;
    callback: () => void;
    ms: number;
    cleared: boolean;
  }> = [];
  const logs = {
    info: [] as string[],
    warn: [] as string[],
    output: [] as string[],
  };
  const calls = {
    relay: [] as Array<{ profile: string; url: string; request: RelayRequest }>,
    device: [] as Array<{ url: string; request: RelayRequest }>,
    prepare: 0,
    revoked: [] as string[],
    computerEnvFor: [] as string[],
    persisted: [] as Array<{ profile: string; enabled: boolean }>,
  };
  let quitting = false;
  let nextPid = 4000;
  const supervisor = new RemoteConnectorSupervisor({
    paths: () => ({
      homeDir: HOME,
      ambientDevicePath: options.ambientDevicePath,
      codeAgentsHome: CODE_AGENTS_HOME,
    }),
    io,
    spawn: (spec) => {
      if (options.spawnError) throw options.spawnError;
      const child = new FakeChild(nextPid++, spec);
      children.push(child);
      return child;
    },
    resolveInvocation: () => ({
      command: "/app/electron",
      args: ["/app/core/dist/cli/index.js"],
      cwd: "/app/core/dist/cli",
      env: { ELECTRON_RUN_AS_NODE: "1" },
    }),
    baseEnv: () => ({
      PATH: "/usr/bin",
      AGENT_NATIVE_REMOTE_DEVICE_PATH: "/ambient/should-not-win.json",
      AGENT_NATIVE_CODE_AGENTS_HOME: "/ambient/should-not-win",
    }),
    prepareComputer: async () => {
      calls.prepare += 1;
      await options.prepareComputer?.();
    },
    computerEnv: (runId) => {
      calls.computerEnvFor.push(runId);
      return { AGENT_NATIVE_COMPUTER_BRIDGE_TOKEN: `bridge-for-${runId}` };
    },
    revokeComputer: (runId) => {
      calls.revoked.push(runId);
    },
    relayFetch: async (profile, url, request) => {
      calls.relay.push({ profile, url, request });
      if (options.relayHandler)
        return options.relayHandler(profile, url, request);
      return response({
        device: { id: "dev-fog-1", label: "Kean-Mac Desktop" },
        token: FOGBREAK_TOKEN,
      });
    },
    deviceFetch: async (url, request) => {
      calls.device.push({ url, request });
      return options.deviceHandler
        ? options.deviceHandler(url, request)
        : response({ ok: true });
    },
    persistEnabled: (profile, enabled) => {
      calls.persisted.push({ profile, enabled });
    },
    hostLabel: () => "Kean-Mac",
    defaultWorkspacePath: () => undefined,
    log: {
      info: (line) => logs.info.push(line),
      warn: (line) => logs.warn.push(line),
      childOutput: (stream, text) => logs.output.push(`${stream}:${text}`),
    },
    now: () => Date.UTC(2026, 10, 6, 12, 0, 0),
    setTimer: (callback, ms) => {
      const id = timers.length + 1;
      timers.push({ id, callback, ms, cleared: false });
      return id;
    },
    clearTimer: (handle) => {
      const timer = timers.find((entry) => entry.id === handle);
      if (timer) timer.cleared = true;
    },
    isQuitting: () => quitting,
  });
  const allLogLines = () => [...logs.info, ...logs.warn, ...logs.output];
  return {
    io,
    children,
    timers,
    logs,
    calls,
    supervisor,
    allLogLines,
    setQuitting: (value: boolean) => {
      quitting = value;
    },
    seedHeadtrip: () =>
      io.seed(HEADTRIP_FILE, {
        token: HEADTRIP_TOKEN,
        relayUrl: HEADTRIP_RELAY,
        deviceId: "dev-head-1",
        deviceName: "HEAD TRIP Mac",
        workspacePath: "/Users/kean/head-trip",
      }),
    seedFogbreak: () =>
      io.seed(FOGBREAK_FILE, {
        token: FOGBREAK_TOKEN,
        relayUrl: FOGBREAK_REMOTE_RELAY_URL,
        deviceId: "dev-fog-1",
        deviceName: "Kean-Mac Desktop",
      }),
  };
}

describe("remote connector profile paths", () => {
  const paths = { homeDir: HOME, codeAgentsHome: CODE_AGENTS_HOME };

  it("keeps the original pairing file, store and computer id for headtrip", () => {
    const profile = resolveRemoteConnectorProfile("headtrip", paths);
    expect(profile.deviceConfigPath).toBe(HEADTRIP_FILE);
    expect(profile.codeAgentsHome).toBe(CODE_AGENTS_HOME);
    expect(profile.computerRunId).toBe("__remote_connector__");
    expect(profile.fixedRelayUrl).toBeNull();
  });

  it("honours the ambient device-path override for headtrip only", () => {
    const ambient = "/somewhere/else/device.json";
    expect(
      resolveRemoteConnectorProfile("headtrip", {
        ...paths,
        ambientDevicePath: ambient,
      }).deviceConfigPath,
    ).toBe(ambient);
    expect(
      resolveRemoteConnectorProfile("fogbreak", {
        ...paths,
        ambientDevicePath: ambient,
      }).deviceConfigPath,
    ).toBe(FOGBREAK_FILE);
  });

  it("gives fogbreak its own file, run store, computer id and fixed relay", () => {
    const headtrip = resolveRemoteConnectorProfile("headtrip", paths);
    const fogbreak = resolveRemoteConnectorProfile("fogbreak", paths);
    expect(fogbreak.deviceConfigPath).toBe(FOGBREAK_FILE);
    expect(fogbreak.deviceConfigPath).not.toBe(headtrip.deviceConfigPath);
    expect(fogbreak.codeAgentsHome).not.toBe(headtrip.codeAgentsHome);
    expect(fogbreak.computerRunId).not.toBe(headtrip.computerRunId);
    expect(fogbreak.computerRunId.startsWith("__remote_connector__:")).toBe(
      true,
    );
    expect(fogbreak.fixedRelayUrl).toBe("https://fogbreak.io/dispatch");
  });

  it("joins relay endpoints under the relay's base path", () => {
    expect(
      relayEndpointUrl(
        "https://fogbreak.io/dispatch",
        "/_agent-native/integrations/remote/register",
      ),
    ).toBe(
      "https://fogbreak.io/dispatch/_agent-native/integrations/remote/register",
    );
    expect(
      relayEndpointUrl(
        "https://headtrip.example.workers.dev/",
        "/_agent-native/integrations/remote/register",
      ),
    ).toBe(
      "https://headtrip.example.workers.dev/_agent-native/integrations/remote/register",
    );
  });
});

describe("remote device config reads", () => {
  const fogbreak = resolveRemoteConnectorProfile("fogbreak", {
    homeDir: HOME,
    codeAgentsHome: CODE_AGENTS_HOME,
  });
  const headtrip = resolveRemoteConnectorProfile("headtrip", {
    homeDir: HOME,
    codeAgentsHome: CODE_AGENTS_HOME,
  });

  it("tells an absent file apart from an unreadable one", () => {
    const io = new MemoryIo();
    expect(readRemoteDeviceConfig(fogbreak, io)).toEqual({ kind: "absent" });

    io.readErrors.set(FOGBREAK_FILE, errno("EACCES"));
    expect(readRemoteDeviceConfig(fogbreak, io)).toEqual({
      kind: "unreadable",
      problem: "io-error",
    });
    io.readErrors.clear();

    io.files.set(FOGBREAK_FILE, "{not json");
    expect(readRemoteDeviceConfig(fogbreak, io)).toEqual({
      kind: "unreadable",
      problem: "invalid-json",
    });
    io.files.set(FOGBREAK_FILE, "[]");
    expect(readRemoteDeviceConfig(fogbreak, io)).toEqual({
      kind: "unreadable",
      problem: "invalid-shape",
    });
    io.seed(FOGBREAK_FILE, { relayUrl: FOGBREAK_REMOTE_RELAY_URL });
    expect(readRemoteDeviceConfig(fogbreak, io)).toEqual({
      kind: "unreadable",
      problem: "missing-token",
    });
    io.seed(FOGBREAK_FILE, { token: FOGBREAK_TOKEN });
    expect(readRemoteDeviceConfig(fogbreak, io)).toEqual({
      kind: "unreadable",
      problem: "missing-relay-url",
    });
  });

  it("refuses to use a fogbreak token for any other relay", () => {
    const io = new MemoryIo();
    io.seed(FOGBREAK_FILE, {
      token: FOGBREAK_TOKEN,
      relayUrl: "https://evil.example/dispatch",
    });
    expect(readRemoteDeviceConfig(fogbreak, io)).toEqual({
      kind: "unreadable",
      problem: "relay-mismatch",
    });
  });

  it("reads the headtrip relay from its own file", () => {
    const io = new MemoryIo();
    io.seed(HEADTRIP_FILE, { token: HEADTRIP_TOKEN, relayUrl: HEADTRIP_RELAY });
    const read = readRemoteDeviceConfig(headtrip, io);
    expect(read.kind).toBe("ok");
    if (read.kind === "ok") expect(read.relayUrl).toBe(`${HEADTRIP_RELAY}/`);
  });
});

describe("pairing the fogbreak relay", () => {
  it("never reads, writes or removes the original pairing file", async () => {
    const h = createHarness();
    h.seedHeadtrip();
    const before = h.io.files.get(HEADTRIP_FILE);

    const result = await h.supervisor.pair("fogbreak", {});

    expect(result.ok).toBe(true);
    expect(result.deviceId).toBe("dev-fog-1");
    expect(h.io.opsOn(HEADTRIP_FILE)).toEqual([]);
    expect(h.io.files.get(HEADTRIP_FILE)).toBe(before);
    expect(h.io.modes.get(FOGBREAK_FILE)).toBe(0o600);
    expect(JSON.parse(h.io.files.get(FOGBREAK_FILE) ?? "{}")).toMatchObject({
      token: FOGBREAK_TOKEN,
      relayUrl: "https://fogbreak.io/dispatch",
      deviceId: "dev-fog-1",
    });
  });

  it("registers against the relay's base path with the fogbreak session", async () => {
    const h = createHarness();
    await h.supervisor.pair("fogbreak", {});
    expect(h.calls.relay).toHaveLength(1);
    expect(nth(h.calls.relay, 0).profile).toBe("fogbreak");
    expect(nth(h.calls.relay, 0).url).toBe(
      "https://fogbreak.io/dispatch/_agent-native/integrations/remote/register",
    );
    expect(nth(h.calls.relay, 0).request.headers["content-type"]).toBe(
      "application/json",
    );
    expect(JSON.parse(nth(h.calls.relay, 0).request.body)).toEqual({
      label: "Kean-Mac Desktop",
    });
  });

  it("does not return the token to the caller", async () => {
    const h = createHarness();
    const result = await h.supervisor.pair("fogbreak", {});
    expect(JSON.stringify(result)).not.toContain(FOGBREAK_TOKEN);
    expect(JSON.stringify(h.supervisor.status("fogbreak"))).not.toContain(
      FOGBREAK_TOKEN,
    );
  });

  it("does not register a second device when already paired unless asked", async () => {
    const h = createHarness();
    h.seedFogbreak();
    const result = await h.supervisor.pair("fogbreak", {});
    expect(result).toMatchObject({ ok: true, message: "Already paired." });
    expect(h.calls.relay).toHaveLength(0);

    await h.supervisor.pair("fogbreak", { repair: true });
    expect(h.calls.relay).toHaveLength(1);
  });

  it("types the failures and leaves the file alone", async () => {
    const cases: Array<[RelayHandler, string]> = [
      [async () => response({ error: "unauthorized" }, 401), "signed-out"],
      [async () => response({ error: "nope" }, 500), "relay-rejected"],
      [async () => response("<html>"), "relay-invalid-response"],
      [async () => response({ device: { id: "x" } }), "no-token"],
      [
        async () => {
          throw new Error("connect ECONNREFUSED");
        },
        "relay-unreachable",
      ],
    ];
    for (const [relayHandler, reason] of cases) {
      const h = createHarness({ relayHandler });
      const result = await h.supervisor.pair("fogbreak", {});
      expect(result.ok).toBe(false);
      expect(result.reason).toBe(reason);
      expect(h.io.opsOn(FOGBREAK_FILE).filter((o) => o.op !== "read")).toEqual(
        [],
      );
    }
  });

  it("reports a failed write without starting a connector", async () => {
    const h = createHarness();
    h.io.writeError = new Error("EROFS");
    const result = await h.supervisor.pair("fogbreak", {});
    expect(result).toMatchObject({ ok: false, reason: "write-failed" });
    expect(h.children).toHaveLength(0);
  });

  it("starts only the fogbreak connector after pairing", async () => {
    const h = createHarness();
    h.seedHeadtrip();
    await h.supervisor.pair("fogbreak", {});
    expect(h.children).toHaveLength(1);
    expect(h.supervisor.status("fogbreak").state).toBe("running");
    expect(h.supervisor.status("headtrip").state).toBe("disabled");
  });

  it.each([
    "https://fogbreak.io/dispatch/",
    "https://fogbreak.io",
    "https://fogbreak.io/",
    "http://fogbreak.io/dispatch",
    "https://fogbreak.io/some/other/path",
    "https://fogbreak.io:8443/dispatch",
    "https://FOGBREAK.IO/dispatch",
    "https://fogbreak.io./dispatch",
    "https://www.fogbreak.io",
    "https://app.staging.fogbreak.io/dispatch",
    "http://beta.fogbreak.io/x",
  ])(
    "rejects the fogbreak relay %s through the original pair path",
    async (relayUrl) => {
      const h = createHarness();
      h.seedHeadtrip();
      const result = await h.supervisor.pair("headtrip", { relayUrl });
      expect(result).toMatchObject({
        ok: false,
        reason: "use-profile-channel",
      });
      expect(h.calls.relay).toHaveLength(0);
      expect(h.io.ops.filter((o) => o.op !== "read")).toEqual([]);
    },
  );

  it("does not mistake look-alike hosts for fogbreak", () => {
    for (const url of [
      "https://notfogbreak.io/dispatch",
      "https://fogbreak.io.evil.example/dispatch",
      "https://fogbreak.com/dispatch",
      "https://evil.example/fogbreak.io",
    ]) {
      expect(isFogbreakRelayUrl(url)).toBe(false);
    }
    expect(isFogbreakRelayUrl("https://fogbreak.io")).toBe(true);
    expect(isFogbreakRelayUrl("https://a.b.fogbreak.io")).toBe(true);
  });

  it.each([
    "http://relay.example.com",
    "http://headtrip.dev-ae8.workers.dev",
    "http://192.168.1.20:8100",
    "http://localhost.evil.example",
  ])("refuses to pair over plain http to %s", async (relayUrl) => {
    const h = createHarness();
    h.seedHeadtrip();
    const result = await h.supervisor.pair("headtrip", { relayUrl });
    expect(result).toMatchObject({ ok: false, reason: "invalid-relay-url" });
    expect(h.calls.relay).toHaveLength(0);
    expect(h.io.ops.filter((o) => o.op !== "read")).toEqual([]);
  });

  it.each([
    "http://localhost:8100",
    "http://127.0.0.1:8100/dispatch",
    "http://[::1]:8100",
    "https://relay.example.com",
  ])("still pairs %s", async (relayUrl) => {
    const h = createHarness({
      relayHandler: async () =>
        response({ device: { id: "dev-ok-1" }, token: HEADTRIP_TOKEN }),
    });
    const result = await h.supervisor.pair("headtrip", { relayUrl });
    expect(result.ok).toBe(true);
    expect(h.calls.relay).toHaveLength(1);
  });

  it("recognises only https or loopback relays as pairable", () => {
    expect(isPairableRelayUrl("https://relay.example.com")).toBe(true);
    expect(isPairableRelayUrl("http://localhost:3000")).toBe(true);
    expect(isPairableRelayUrl("http://127.0.0.1")).toBe(true);
    expect(isPairableRelayUrl("http://[::1]:1")).toBe(true);
    expect(isPairableRelayUrl("http://relay.example.com")).toBe(false);
    expect(isPairableRelayUrl("ftp://relay.example.com")).toBe(false);
    expect(isPairableRelayUrl("not a url")).toBe(false);
  });

  it("does not tighten reading an existing pairing over http", () => {
    const io = new MemoryIo();
    io.seed(HEADTRIP_FILE, {
      token: HEADTRIP_TOKEN,
      relayUrl: "http://relay.example.com",
    });
    const read = readRemoteDeviceConfig(
      resolveRemoteConnectorProfile("headtrip", {
        homeDir: HOME,
        codeAgentsHome: CODE_AGENTS_HOME,
      }),
      io,
    );
    expect(read.kind).toBe("ok");
    if (read.kind === "ok")
      expect(read.relayUrl).toBe("http://relay.example.com/");
  });

  it("keeps the original pair flow for headtrip", async () => {
    const h = createHarness({
      relayHandler: async () =>
        response({ device: { id: "dev-head-2" }, token: HEADTRIP_TOKEN }),
    });
    const result = await h.supervisor.pair("headtrip", {
      relayUrl: HEADTRIP_RELAY,
      workspacePath: "/Users/kean/head-trip",
    });
    expect(result.ok).toBe(true);
    expect(nth(h.calls.relay, 0).url).toBe(
      `${HEADTRIP_RELAY}/_agent-native/integrations/remote/register`,
    );
    expect(JSON.parse(h.io.files.get(HEADTRIP_FILE) ?? "{}")).toMatchObject({
      token: HEADTRIP_TOKEN,
      relayUrl: `${HEADTRIP_RELAY}/`,
      deviceId: "dev-head-2",
      workspacePath: "/Users/kean/head-trip",
    });
    expect(h.io.opsOn(FOGBREAK_FILE)).toEqual([]);
    expect(h.calls.persisted).toContainEqual({
      profile: "headtrip",
      enabled: true,
    });
  });
});

describe("which session carries the pairing cookie", () => {
  it("gives the fogbreak profile only the fogbreak partition", () => {
    expect(chooseRelaySession("fogbreak", FOGBREAK_REMOTE_RELAY_URL)).toEqual({
      kind: "partition",
      partition: FOGBREAK_SESSION_PARTITION,
    });
    expect(
      chooseRelaySession(
        "fogbreak",
        "https://fogbreak.io/dispatch/_agent-native/integrations/remote/register",
      ),
    ).toEqual({ kind: "partition", partition: FOGBREAK_SESSION_PARTITION });
  });

  it.each([
    "https://evil.example/dispatch",
    "https://fogbreak.io.evil.example/dispatch",
    "http://fogbreak.io/dispatch",
    "https://headtrip.dev-ae8.workers.dev",
    "not a url",
  ])("refuses the fogbreak profile toward %s", (url) => {
    expect(chooseRelaySession("fogbreak", url).kind).toBe("refused");
  });

  it("never gives another profile the fogbreak partition or a fogbreak host", () => {
    expect(
      chooseRelaySession("headtrip", "https://headtrip.dev-ae8.workers.dev"),
    ).toEqual({ kind: "relay-session" });
    for (const url of [
      FOGBREAK_REMOTE_RELAY_URL,
      "https://fogbreak.io",
      "http://www.fogbreak.io/x",
    ]) {
      expect(chooseRelaySession("headtrip", url).kind).toBe("refused");
    }
  });

  it("hands the relay request to the session the choice names", async () => {
    const asked: Array<{ profile: string; url: string }> = [];
    const h = createHarness({
      relayHandler: async (profile, url) => {
        asked.push({ profile, url });
        return response({ device: { id: "dev-fog-1" }, token: FOGBREAK_TOKEN });
      },
    });
    h.seedHeadtrip();
    await h.supervisor.pair("fogbreak", {});
    expect(asked).toEqual([
      {
        profile: "fogbreak",
        url: "https://fogbreak.io/dispatch/_agent-native/integrations/remote/register",
      },
    ]);
    expect(
      chooseRelaySession(nth(asked, 0).profile as "fogbreak", nth(asked, 0).url)
        .kind,
    ).toBe("partition");
  });
});

describe("connector spawn per profile", () => {
  it("builds the relay arg and device path from the profile", () => {
    const profile = resolveRemoteConnectorProfile("fogbreak", {
      homeDir: HOME,
      codeAgentsHome: CODE_AGENTS_HOME,
    });
    const spec = buildConnectorSpawn({
      profile,
      relayUrl: "https://fogbreak.io/dispatch",
      invocation: { command: "node", args: ["cli.js"], cwd: "/cwd" },
      baseEnv: { AGENT_NATIVE_REMOTE_DEVICE_PATH: "/ambient.json" },
      computerEnv: {},
    });
    expect(spec.args).toEqual([
      "cli.js",
      "code",
      "serve",
      "--relay-url",
      "https://fogbreak.io/dispatch",
    ]);
    expect(spec.env.AGENT_NATIVE_REMOTE_DEVICE_PATH).toBe(FOGBREAK_FILE);
  });

  it("spawns each profile with its own relay arg, device file and store", async () => {
    const h = createHarness();
    h.seedHeadtrip();
    h.seedFogbreak();
    await h.supervisor.setEnabled("headtrip", true);
    await h.supervisor.setEnabled("fogbreak", true);

    expect(h.children).toHaveLength(2);
    const headtrip = nth(h.children, 0).spec;
    const fogbreak = nth(h.children, 1).spec;
    expect(headtrip.args.slice(-4)).toEqual([
      "code",
      "serve",
      "--relay-url",
      `${HEADTRIP_RELAY}/`,
    ]);
    expect(fogbreak.args.slice(-4)).toEqual([
      "code",
      "serve",
      "--relay-url",
      "https://fogbreak.io/dispatch",
    ]);
    expect(headtrip.env.AGENT_NATIVE_REMOTE_DEVICE_PATH).toBe(HEADTRIP_FILE);
    expect(fogbreak.env.AGENT_NATIVE_REMOTE_DEVICE_PATH).toBe(FOGBREAK_FILE);
    expect(headtrip.env.AGENT_NATIVE_CODE_AGENTS_HOME).toBe(CODE_AGENTS_HOME);
    expect(fogbreak.env.AGENT_NATIVE_CODE_AGENTS_HOME).toBe(
      path.join(AGENT_NATIVE_DIR, "code-agents-fogbreak"),
    );
    expect(headtrip.env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(h.calls.computerEnvFor).toEqual([
      "__remote_connector__",
      "__remote_connector__:fogbreak",
    ]);
    expect(headtrip.env.AGENT_NATIVE_COMPUTER_BRIDGE_TOKEN).not.toBe(
      fogbreak.env.AGENT_NATIVE_COMPUTER_BRIDGE_TOKEN,
    );
  });

  it("does not prepare the computer bridge until a connector starts", async () => {
    const h = createHarness();
    h.seedHeadtrip();
    h.supervisor.status("headtrip");
    h.supervisor.legacyStatus();
    expect(h.calls.prepare).toBe(0);
    await h.supervisor.setEnabled("headtrip", true);
    expect(h.calls.prepare).toBe(1);
  });

  it("does not start an unpaired profile", async () => {
    const h = createHarness();
    await h.supervisor.setEnabled("fogbreak", true);
    expect(h.children).toHaveLength(0);
    expect(h.supervisor.status("fogbreak")).toMatchObject({
      state: "unconfigured",
      config: "absent",
    });
  });
});

describe("per-profile process handles", () => {
  async function bothRunning() {
    const h = createHarness();
    h.seedHeadtrip();
    h.seedFogbreak();
    await h.supervisor.setEnabled("headtrip", true);
    await h.supervisor.setEnabled("fogbreak", true);
    return { h, headtrip: nth(h.children, 0), fogbreak: nth(h.children, 1) };
  }

  it("keeps headtrip running when the fogbreak connector crashes", async () => {
    const { h, headtrip, fogbreak } = await bothRunning();
    fogbreak.emitExit(1);

    expect(h.supervisor.status("headtrip").state).toBe("running");
    expect(headtrip.killed).toEqual([]);
    const crashed = h.supervisor.status("fogbreak");
    expect(crashed.state).toBe("starting");
    expect(crashed.lastExitCode).toBe(1);
    expect(crashed.restartCount).toBe(1);
    expect(h.supervisor.status("headtrip").restartCount).toBe(0);
    expect(h.timers.filter((timer) => !timer.cleared)).toHaveLength(1);
    expect(h.calls.revoked).toEqual(["__remote_connector__:fogbreak"]);
  });

  it("keeps fogbreak running when the headtrip connector crashes", async () => {
    const { h, headtrip } = await bothRunning();
    headtrip.emitExit(null, "SIGKILL");
    expect(h.supervisor.status("fogbreak").state).toBe("running");
    expect(h.supervisor.status("headtrip").lastExitSignal).toBe("SIGKILL");
    expect(h.calls.revoked).toEqual(["__remote_connector__"]);
  });

  it("restarts a crashed profile with its own backoff", async () => {
    const { h, fogbreak } = await bothRunning();
    fogbreak.emitExit(1);
    const timer = h.timers.find((entry) => !entry.cleared);
    expect(timer?.ms).toBe(2_000);
    timer?.callback();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.children).toHaveLength(3);
    expect(nth(h.children, 2).spec.env.AGENT_NATIVE_REMOTE_DEVICE_PATH).toBe(
      FOGBREAK_FILE,
    );
    expect(h.supervisor.status("fogbreak").state).toBe("running");
  });

  it("stops only the profile that is turned off", async () => {
    const { h, headtrip, fogbreak } = await bothRunning();
    await h.supervisor.setEnabled("fogbreak", false);

    expect(fogbreak.killed).toEqual(["SIGTERM"]);
    expect(headtrip.killed).toEqual([]);
    expect(h.supervisor.status("fogbreak").state).toBe("disabled");
    expect(h.supervisor.status("headtrip").state).toBe("running");
    expect(h.calls.persisted).toContainEqual({
      profile: "fogbreak",
      enabled: false,
    });
  });

  it("does not let a stopped child's late exit revoke a restarted child", async () => {
    const { h, fogbreak } = await bothRunning();
    await h.supervisor.restart("fogbreak");
    const revokedBefore = h.calls.revoked.length;
    fogbreak.emitExit(null, "SIGTERM");
    expect(h.calls.revoked).toHaveLength(revokedBefore);
    expect(h.supervisor.status("fogbreak").state).toBe("running");
    expect(h.timers.filter((timer) => !timer.cleared)).toHaveLength(0);
  });

  it("restarts only the requested profile", async () => {
    const { h, headtrip, fogbreak } = await bothRunning();
    const result = await h.supervisor.restart("fogbreak");
    expect(result.ok).toBe(true);
    expect(fogbreak.killed).toEqual(["SIGTERM"]);
    expect(headtrip.killed).toEqual([]);
    expect(h.children).toHaveLength(3);
  });

  it("refuses to restart a disabled profile", async () => {
    const h = createHarness();
    h.seedFogbreak();
    const result = await h.supervisor.restart("fogbreak");
    expect(result).toMatchObject({ ok: false, reason: "disabled" });
    expect(h.children).toHaveLength(0);
  });

  it("stops every connector when the app quits", async () => {
    const { h, headtrip, fogbreak } = await bothRunning();
    h.setQuitting(true);
    h.supervisor.stopAll();
    expect(headtrip.killed).toEqual(["SIGTERM"]);
    expect(fogbreak.killed).toEqual(["SIGTERM"]);
    headtrip.emitExit(null, "SIGTERM");
    expect(h.timers).toHaveLength(0);
  });

  it("shares one start across concurrent callers of a profile", async () => {
    const h = createHarness();
    h.seedFogbreak();
    await h.supervisor.setEnabled("fogbreak", true);
    await Promise.all([
      h.supervisor.start("fogbreak"),
      h.supervisor.start("fogbreak"),
    ]);
    expect(h.children).toHaveLength(1);
  });
});

describe("profile status typing", () => {
  it("separates absent, unreadable, disabled, starting, running and error", async () => {
    const h = createHarness();
    expect(h.supervisor.status("fogbreak")).toMatchObject({
      state: "disabled",
      config: "absent",
    });

    await h.supervisor.setEnabled("fogbreak", true);
    expect(h.supervisor.status("fogbreak")).toMatchObject({
      state: "unconfigured",
      config: "absent",
    });

    h.io.files.set(FOGBREAK_FILE, "{broken");
    const unreadable = h.supervisor.status("fogbreak");
    expect(unreadable).toMatchObject({
      state: "error",
      config: "unreadable",
      configProblem: "invalid-json",
      errorReason: "config-unreadable",
    });

    h.seedFogbreak();
    await h.supervisor.restart("fogbreak");
    expect(h.supervisor.status("fogbreak")).toMatchObject({
      state: "running",
      config: "configured",
      relayHost: "fogbreak.io",
      deviceId: "dev-fog-1",
      pid: nth(h.children, 0).pid,
    });
    nth(h.children, 0).emitExit(2);
    expect(h.supervisor.status("fogbreak")).toMatchObject({
      state: "starting",
      lastExitCode: 2,
    });
  });

  it("reports a spawn failure with a typed reason and retries", async () => {
    const h = createHarness({ spawnError: new Error("spawn ENOENT") });
    h.seedFogbreak();
    await h.supervisor.setEnabled("fogbreak", true);
    expect(h.supervisor.status("fogbreak")).toMatchObject({
      state: "starting",
      errorReason: "spawn-failed",
    });
    expect(h.timers).toHaveLength(1);
    expect(h.calls.revoked).toEqual(["__remote_connector__:fogbreak"]);
  });

  it("reports a missing computer bridge with a typed reason", async () => {
    const h = createHarness({
      prepareComputer: async () => {
        throw new Error("bridge down");
      },
    });
    h.seedFogbreak();
    await h.supervisor.setEnabled("fogbreak", true);
    expect(h.supervisor.status("fogbreak").errorReason).toBe(
      "computer-bridge-unavailable",
    );
    expect(h.children).toHaveLength(0);
  });

  it("surfaces a child error event as a spawn failure", async () => {
    const h = createHarness();
    h.seedFogbreak();
    await h.supervisor.setEnabled("fogbreak", true);
    nth(h.children, 0).emitError(new Error("EPERM"));
    expect(h.supervisor.status("fogbreak").errorReason).toBe("spawn-failed");
  });

  it("does not let one profile's error show on the other", async () => {
    const h = createHarness();
    h.seedHeadtrip();
    h.io.files.set(FOGBREAK_FILE, "{broken");
    await h.supervisor.setEnabled("headtrip", true);
    await h.supervisor.setEnabled("fogbreak", true);
    expect(h.supervisor.status("headtrip")).toMatchObject({
      state: "running",
      config: "configured",
    });
    expect(h.supervisor.status("fogbreak").state).toBe("error");
  });

  it("keeps the original status shape for headtrip", async () => {
    const h = createHarness();
    h.seedHeadtrip();
    expect(h.supervisor.legacyStatus()).toMatchObject({
      state: "disabled",
      enabled: false,
      configured: true,
      configPath: HEADTRIP_FILE,
      relayUrl: `${HEADTRIP_RELAY}/`,
      workspacePath: "/Users/kean/head-trip",
      restartCount: 0,
    });
    await h.supervisor.setEnabled("headtrip", true);
    expect(h.supervisor.legacyStatus()).toMatchObject({
      state: "running",
      pid: nth(h.children, 0).pid,
    });
    h.io.files.set(HEADTRIP_FILE, "{broken");
    expect(h.supervisor.legacyStatus()).toMatchObject({
      state: "unconfigured",
      configured: false,
    });
  });

  it("redacts the device token from an error message in status", async () => {
    const h = createHarness({
      spawnError: new Error(`spawn failed for ${FOGBREAK_TOKEN}`),
    });
    h.seedFogbreak();
    await h.supervisor.setEnabled("fogbreak", true);
    const status = h.supervisor.status("fogbreak");
    expect(status.error).toContain("[redacted]");
    expect(JSON.stringify(status)).not.toContain(FOGBREAK_TOKEN);
  });
});

describe("connector logging", () => {
  it("names the relay host and device id for fogbreak state changes", async () => {
    const h = createHarness();
    await h.supervisor.pair("fogbreak", {});
    expect(h.logs.info).toContain(
      "[remote-connector] profile=fogbreak relay=fogbreak.io deviceId=dev-fog-1 state=running",
    );
    expect(h.logs.info).toContain(
      "[remote-connector] profile=fogbreak relay=fogbreak.io deviceId=dev-fog-1 state=paired",
    );
  });

  it("never logs a token or cookie from output, errors or pairing", async () => {
    const h = createHarness({
      relayHandler: async () =>
        response({
          device: { id: "dev-fog-1" },
          token: FOGBREAK_TOKEN,
          error: COOKIE,
        }),
    });
    h.seedHeadtrip();
    await h.supervisor.setEnabled("headtrip", true);
    await h.supervisor.pair("fogbreak", {});
    const headtrip = nth(h.children, 0);
    const fogbreak = nth(h.children, 1);

    for (const [child, token] of [
      [headtrip, HEADTRIP_TOKEN],
      [fogbreak, FOGBREAK_TOKEN],
    ] as const) {
      child.emitStdout(`serving with Bearer ${token} ${token} ${COOKIE}`);
      child.emitStderr(`poll failed: ${token}`);
    }
    fogbreak.emitError(new Error(`EPERM ${FOGBREAK_TOKEN}`));
    headtrip.emitExit(1);
    await h.supervisor.restart("headtrip");
    await h.supervisor.unpair("fogbreak");

    const lines = h.allLogLines();
    expect(lines.length).toBeGreaterThan(5);
    for (const line of lines) {
      for (const secret of SECRETS) expect(line).not.toContain(secret);
    }
    expect(h.logs.output.some((line) => line.includes("[redacted]"))).toBe(
      true,
    );
  });

  it("never logs the pairing file paths", async () => {
    const h = createHarness();
    h.seedHeadtrip();
    await h.supervisor.setEnabled("headtrip", true);
    await h.supervisor.pair("fogbreak", {});
    for (const line of h.allLogLines()) {
      expect(line).not.toContain(HOME);
    }
  });

  it("keeps the original child-output prefix for headtrip", async () => {
    const h = createHarness();
    h.seedHeadtrip();
    await h.supervisor.setEnabled("headtrip", true);
    nth(h.children, 0).emitStdout("  serving  \n");
    expect(h.logs.output).toEqual(["stdout:serving"]);
  });

  it("sanitizes a hostile device id before logging it", async () => {
    const h = createHarness({
      relayHandler: async () =>
        response({
          device: { id: `evil id ${FOGBREAK_TOKEN}\nforged=1` },
          token: FOGBREAK_TOKEN,
        }),
    });
    await h.supervisor.pair("fogbreak", {});
    for (const line of h.allLogLines()) {
      expect(line).not.toContain("\n");
      expect(line).not.toContain(FOGBREAK_TOKEN);
    }
    expect(h.logs.info.some((line) => line.includes("deviceId=invalid"))).toBe(
      true,
    );
  });

  it("redacts bearer tokens and known secrets", () => {
    expect(redactSecrets("Bearer abc.def and tok123 end", ["tok123"])).toBe(
      "Bearer [redacted] and [redacted] end",
    );
    expect(redactSecrets("cookie an_session=abc123; path=/", [])).toBe(
      "cookie an_session=[redacted]; path=/",
    );
  });
});

describe("unpairing a profile", () => {
  it("removes only the fogbreak file and leaves the original intact", async () => {
    const h = createHarness();
    h.seedHeadtrip();
    h.seedFogbreak();
    const headtripBefore = h.io.files.get(HEADTRIP_FILE);
    await h.supervisor.setEnabled("headtrip", true);
    await h.supervisor.setEnabled("fogbreak", true);

    const result = await h.supervisor.unpair("fogbreak");

    expect(result.ok).toBe(true);
    expect(result.remoteRevoked).toBe(true);
    expect(h.io.files.has(FOGBREAK_FILE)).toBe(false);
    expect(h.io.files.get(HEADTRIP_FILE)).toBe(headtripBefore);
    expect(h.io.opsOn(HEADTRIP_FILE).filter((o) => o.op !== "read")).toEqual(
      [],
    );
    expect(nth(h.children, 1).killed).toEqual(["SIGTERM"]);
    expect(nth(h.children, 0).killed).toEqual([]);
    expect(h.supervisor.status("headtrip").state).toBe("running");
    expect(h.supervisor.status("fogbreak")).toMatchObject({
      state: "disabled",
      config: "absent",
    });
  });

  it("unregisters the device on its own relay with its own token", async () => {
    const h = createHarness();
    h.seedFogbreak();
    await h.supervisor.unpair("fogbreak");
    expect(h.calls.device).toHaveLength(1);
    expect(nth(h.calls.device, 0).url).toBe(
      "https://fogbreak.io/dispatch/_agent-native/integrations/remote/unregister",
    );
    expect(nth(h.calls.device, 0).request.headers.authorization).toBe(
      `Bearer ${FOGBREAK_TOKEN}`,
    );
  });

  it("still removes the file when the relay cannot revoke the device", async () => {
    const h = createHarness({
      deviceHandler: async () => {
        throw new Error("offline");
      },
    });
    h.seedFogbreak();
    const result = await h.supervisor.unpair("fogbreak");
    expect(result).toMatchObject({ ok: true, remoteRevoked: false });
    expect(h.io.files.has(FOGBREAK_FILE)).toBe(false);
  });

  it("removes an unreadable fogbreak file without sending its contents", async () => {
    const h = createHarness();
    h.io.files.set(FOGBREAK_FILE, "{broken");
    const result = await h.supervisor.unpair("fogbreak");
    expect(result.ok).toBe(true);
    expect(h.calls.device).toHaveLength(0);
    expect(h.io.files.has(FOGBREAK_FILE)).toBe(false);
  });

  it("reports a file that cannot be removed", async () => {
    const h = createHarness();
    h.seedFogbreak();
    h.io.removeErrors.set(FOGBREAK_FILE, errno("EACCES"));
    const result = await h.supervisor.unpair("fogbreak");
    expect(result).toMatchObject({ ok: false, reason: "write-failed" });
  });

  it("never removes the original pairing", async () => {
    const h = createHarness();
    h.seedHeadtrip();
    const result = await h.supervisor.unpair("headtrip");
    expect(result).toMatchObject({ ok: false, reason: "profile-protected" });
    expect(h.io.files.has(HEADTRIP_FILE)).toBe(true);
    expect(h.io.ops.filter((o) => o.op === "remove")).toEqual([]);
    expect(h.calls.device).toHaveLength(0);
  });
});

describe("profile IPC input", () => {
  it("accepts only the two known profile ids", () => {
    expect(parseRemoteConnectorProfileId("headtrip")).toBe("headtrip");
    expect(parseRemoteConnectorProfileId("fogbreak")).toBe("fogbreak");
    for (const hostile of [
      "",
      "FOGBREAK",
      "../remote-device",
      "/etc/passwd",
      "https://evil.example",
      "__proto__",
      "constructor",
      "toString",
      null,
      undefined,
      1,
      ["fogbreak"],
      { toString: () => "fogbreak" },
    ]) {
      expect(parseRemoteConnectorProfileId(hostile)).toBeNull();
    }
  });

  it("rejects hostile request shapes with a typed reason", () => {
    for (const input of [null, undefined, "fogbreak", 7, ["fogbreak"]]) {
      expect(parseProfileRequest(input)).toMatchObject({
        ok: false,
        result: { reason: "invalid-request" },
      });
    }
    for (const input of [
      {},
      { profile: "../x" },
      { profile: "__proto__" },
      Object.create({ profile: "fogbreak" }),
    ]) {
      expect(parseProfileRequest(input)).toMatchObject({
        ok: false,
        result: { reason: "invalid-profile" },
      });
    }
  });

  it("ignores any path or url the renderer sends", async () => {
    const h = createHarness();
    h.seedHeadtrip();
    const handlers = createRemoteConnectorProfileHandlers(h.supervisor);
    const result = await handlers.pair({
      profile: "fogbreak",
      relayUrl: "https://evil.example",
      url: "https://evil.example",
      path: HEADTRIP_FILE,
      devicePath: HEADTRIP_FILE,
      workspacePath: "/etc",
      repair: true,
    });
    expect(result.ok).toBe(true);
    expect(h.calls.relay.map((call) => call.url)).toEqual([
      "https://fogbreak.io/dispatch/_agent-native/integrations/remote/register",
    ]);
    expect(h.io.opsOn(HEADTRIP_FILE)).toEqual([]);
    const written = JSON.parse(h.io.files.get(FOGBREAK_FILE) ?? "{}");
    expect(written.relayUrl).toBe("https://fogbreak.io/dispatch");
    expect(written.workspacePath).toBeUndefined();
  });

  it("does not pair or unpair the original profile over the profile channel", async () => {
    const h = createHarness();
    h.seedHeadtrip();
    const handlers = createRemoteConnectorProfileHandlers(h.supervisor);
    expect(await handlers.pair({ profile: "headtrip" })).toMatchObject({
      ok: false,
      reason: "profile-protected",
    });
    expect(await handlers.unpair({ profile: "headtrip" })).toMatchObject({
      ok: false,
      reason: "profile-protected",
    });
    expect(h.calls.relay).toHaveLength(0);
    expect(h.io.ops.filter((o) => o.op !== "read")).toEqual([]);
  });

  it("requires a boolean to change enabled", async () => {
    const h = createHarness();
    h.seedFogbreak();
    const handlers = createRemoteConnectorProfileHandlers(h.supervisor);
    for (const enabled of ["true", 1, null, undefined]) {
      expect(
        await handlers.setEnabled({ profile: "fogbreak", enabled }),
      ).toMatchObject({ ok: false, reason: "invalid-request" });
    }
    expect(h.children).toHaveLength(0);
    const on = await handlers.setEnabled({
      profile: "fogbreak",
      enabled: true,
    });
    expect(on.status?.state).toBe("running");
  });

  it("reads status for a profile", () => {
    const h = createHarness();
    const handlers = createRemoteConnectorProfileHandlers(h.supervisor);
    expect(handlers.getStatus({ profile: "fogbreak" })).toMatchObject({
      ok: true,
      status: { profile: "fogbreak", config: "absent" },
    });
    expect(handlers.getStatus({ profile: "nope" })).toMatchObject({
      ok: false,
      reason: "invalid-profile",
    });
  });
});

describe("registering against a local fake relay", () => {
  interface Seen {
    method: string | undefined;
    url: string | undefined;
    contentType: string | undefined;
    body: string;
  }
  const servers: http.Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map(
          (server) =>
            new Promise<void>((resolve) => server.close(() => resolve())),
        ),
    );
  });

  async function startRelay(
    reply: (seen: Seen) => { status: number; body: string },
  ) {
    const seen: Seen[] = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const entry: Seen = {
          method: req.method,
          url: req.url,
          contentType: req.headers["content-type"],
          body: Buffer.concat(chunks).toString("utf-8"),
        };
        seen.push(entry);
        const result = reply(entry);
        res.writeHead(result.status, { "content-type": "application/json" });
        res.end(result.body);
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    servers.push(server);
    return { seen, port: (server.address() as AddressInfo).port };
  }

  function harnessAgainst(port: number) {
    return createHarness({
      relayHandler: async (_profile, url, request) => {
        const target = new URL(url);
        const res = await fetch(`http://127.0.0.1:${port}${target.pathname}`, {
          method: request.method,
          headers: { ...request.headers },
          body: request.body,
          redirect: "manual",
        });
        return {
          ok: res.ok,
          status: res.status,
          text: () => res.text(),
        };
      },
    });
  }

  it("posts the registration under /dispatch and stores the returned device", async () => {
    const relay = await startRelay(() => ({
      status: 200,
      body: JSON.stringify({
        device: { id: "dev-live-1", label: "Kean-Mac Desktop" },
        token: FOGBREAK_TOKEN,
      }),
    }));
    const h = harnessAgainst(relay.port);
    h.seedHeadtrip();

    const result = await h.supervisor.pair("fogbreak", {});

    expect(result).toMatchObject({ ok: true, deviceId: "dev-live-1" });
    expect(relay.seen).toHaveLength(1);
    expect(nth(relay.seen, 0)).toMatchObject({
      method: "POST",
      url: "/dispatch/_agent-native/integrations/remote/register",
      contentType: "application/json",
    });
    expect(JSON.parse(nth(relay.seen, 0).body)).toEqual({
      label: "Kean-Mac Desktop",
    });
    expect(h.io.opsOn(HEADTRIP_FILE)).toEqual([]);
    expect(JSON.parse(h.io.files.get(FOGBREAK_FILE) ?? "{}")).toMatchObject({
      token: FOGBREAK_TOKEN,
      deviceId: "dev-live-1",
    });
    expect(h.children).toHaveLength(1);
    expect(nth(h.children, 0).spec.args.slice(-1)).toEqual([
      "https://fogbreak.io/dispatch",
    ]);
  });

  it("reports signed-out when the relay answers 401", async () => {
    const relay = await startRelay(() => ({
      status: 401,
      body: JSON.stringify({ error: "unauthorized" }),
    }));
    const h = harnessAgainst(relay.port);
    const result = await h.supervisor.pair("fogbreak", {});
    expect(result).toMatchObject({ ok: false, reason: "signed-out" });
    expect(h.io.files.has(FOGBREAK_FILE)).toBe(false);
    expect(h.children).toHaveLength(0);
  });
});
