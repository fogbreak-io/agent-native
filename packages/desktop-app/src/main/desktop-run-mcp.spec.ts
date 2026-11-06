import { describe, expect, it, vi } from "vitest";

import {
  SONG_STUDIO_WAITING_MESSAGE,
  decideSpawnAfterPrepare,
  prepareRunMcp,
  releaseAbandonedRunStart,
  resolveWorkspaceAppMcpServers,
  snapshotRunForSpawn,
} from "./desktop-run-mcp.js";
import type { SongStudioReadyResult } from "./song-studio-local-session.js";

const readyEntry: SongStudioReadyResult = {
  state: "ready",
  entry: {
    type: "http",
    url: "http://127.0.0.1:8100/song-studio/mcp",
    headers: { Authorization: "Bearer tok-secret-123" },
  },
};

const APPS = [
  {
    id: "song-studio",
    name: "Song Studio",
    baseUrl: "http://127.0.0.1:8100/song-studio",
  },
  { id: "mail", name: "Mail", baseUrl: "https://mail.fogbreak.io" },
];

function workspace(
  boundAppId: string | undefined,
  song: SongStudioReadyResult = readyEntry,
) {
  const prepareSong = vi.fn(async () => song);
  const run = resolveWorkspaceAppMcpServers({
    apps: APPS,
    boundAppId,
    serverIdFor: (id) => `desktop_app_${id.replace(/-/g, "_")}`,
    mcpUrlFor: (base) => `${base}/mcp`,
    readCookieHeader: async (id) =>
      id === "mail" ? "sid=abc" : "an_session=x",
    prepareSong,
  });
  return { run, prepareSong };
}

const run = (status: string, extra: Record<string, unknown> = {}) => ({
  id: "run-1",
  status,
  phase: status,
  metadata: {},
  ...extra,
});

describe("the apps' MCP servers for one run", () => {
  it("makes a Song-bound run wait for Song once and keeps every healthy app", async () => {
    const { run: resolved, prepareSong } = workspace("song-studio");
    const result = await resolved;
    expect(prepareSong).toHaveBeenCalledTimes(1);
    expect(Object.keys(result.servers).sort()).toEqual([
      "desktop_app_mail",
      "desktop_app_song_studio",
    ]);
    expect(result.appIds.sort()).toEqual(["mail", "song-studio"]);
    expect(result.notices).toEqual([]);
  });

  it("tells a Song-bound run when Song was left out, and leaves the other apps in", async () => {
    const { run: resolved } = workspace("song-studio", {
      state: "unavailable",
      stage: "mint",
      reason: "timed-out",
    });
    const result = await resolved;
    expect(Object.keys(result.servers)).toEqual(["desktop_app_mail"]);
    expect(result.notices).toEqual([
      {
        serverId: "desktop_app_song_studio",
        reason: "timed-out",
        message: "Song tools unavailable: Song Studio is still starting",
      },
    ]);
  });

  it("gives a run bound to another app, or to none, no Song wait and no Song notice", async () => {
    for (const boundAppId of ["mail", "dispatch", undefined]) {
      const { run: resolved, prepareSong } = workspace(boundAppId, {
        state: "unavailable",
        stage: "mint",
        reason: "timed-out",
      });
      const result = await resolved;
      expect(prepareSong).not.toHaveBeenCalled();
      expect(result.notices).toEqual([]);
      expect(Object.keys(result.servers)).toEqual(["desktop_app_mail"]);
    }
  });
});

describe("deciding whether a prepared run still starts", () => {
  const snap = (record: Record<string, unknown> | null) =>
    snapshotRunForSpawn(record);

  it("reads status, phase and the stop time from a record", () => {
    expect(
      snap(run("paused", { metadata: { runnerStoppedAt: "t1" } })),
    ).toEqual({ status: "paused", phase: "paused", stoppedAt: "t1" });
    expect(snap(null)).toBeNull();
  });

  it("abandons a run whose record is gone", () => {
    expect(decideSpawnAfterPrepare(snap(run("queued")), null)).toEqual({
      action: "abandon",
      reason: "record-gone",
    });
  });

  it("abandons a run stopped while it was being prepared", () => {
    for (const before of ["queued", "running"]) {
      expect(
        decideSpawnAfterPrepare(snap(run(before)), snap(run("paused"))),
      ).toEqual({ action: "abandon", reason: "stopped-while-preparing" });
    }
    for (const after of ["errored", "completed", "needs-approval"]) {
      expect(
        decideSpawnAfterPrepare(snap(run("running")), snap(run(after))).action,
      ).toBe("abandon");
    }
  });

  it("starts a run that is still queued or running", () => {
    expect(
      decideSpawnAfterPrepare(snap(run("queued")), snap(run("running"))),
    ).toEqual({ action: "spawn" });
    expect(
      decideSpawnAfterPrepare(snap(run("running")), snap(run("running"))),
    ).toEqual({ action: "spawn" });
  });

  it("starts a resumed run that was paused before and is unchanged", () => {
    const paused = run("paused", { metadata: { runnerStoppedAt: "t1" } });
    expect(decideSpawnAfterPrepare(snap(paused), snap(paused))).toEqual({
      action: "spawn",
    });
  });

  it("abandons a resumed run that was stopped again meanwhile", () => {
    expect(
      decideSpawnAfterPrepare(
        snap(run("paused", { metadata: { runnerStoppedAt: "t1" } })),
        snap(run("paused", { metadata: { runnerStoppedAt: "t2" } })),
      ),
    ).toEqual({ action: "abandon", reason: "stopped-while-preparing" });
  });
});

describe("preparing a run's MCP environment", () => {
  function harness(options: {
    metadata: unknown;
    records: Array<Record<string, unknown> | null>;
    notices?: Array<{ serverId: string; reason: string; message: string }>;
  }) {
    const records = [...options.records];
    const events: Array<{
      message: string;
      metadata: Record<string, unknown>;
    }> = [];
    const order: string[] = [];
    const build = vi.fn(async (boundAppId: string | undefined) => {
      order.push(`build:${boundAppId ?? "none"}`);
      return { notices: options.notices ?? [] };
    });
    const release = vi.fn();
    const input = {
      runMetadata: options.metadata,
      readRecord: () => records.shift() ?? null,
      build,
      announce: (message: string, metadata: Record<string, unknown>) => {
        order.push(`announce:${message}`);
        events.push({ message, metadata });
      },
      release,
    };
    return { input, events, build, release, order };
  }

  it("says 'Waiting for Song Studio to start' before it waits, for a Song-bound run only", async () => {
    const song = harness({
      metadata: { appId: "song-studio" },
      records: [run("running"), run("running")],
    });
    expect((await prepareRunMcp(song.input)).state).toBe("ready");
    expect(song.order).toEqual([
      `announce:${SONG_STUDIO_WAITING_MESSAGE}`,
      "build:song-studio",
    ]);
    expect(SONG_STUDIO_WAITING_MESSAGE).toBe(
      "Waiting for Song Studio to start",
    );

    const other = harness({
      metadata: { appId: "mail" },
      records: [run("running"), run("running")],
    });
    await prepareRunMcp(other.input);
    expect(other.order).toEqual(["build:mail"]);
    expect(other.events).toEqual([]);
  });

  it("writes the notices to the run when it goes on to start", async () => {
    const notice = {
      serverId: "desktop_app_song_studio",
      reason: "timed-out",
      message: "Song tools unavailable: Song Studio is still starting",
    };
    const { input, events } = harness({
      metadata: { appId: "song-studio" },
      records: [run("running"), run("running")],
      notices: [notice],
    });
    await prepareRunMcp(input);
    expect(events.map((event) => event.message)).toEqual([
      SONG_STUDIO_WAITING_MESSAGE,
      notice.message,
    ]);
    expect(events[1]?.metadata).toMatchObject({
      serverId: "desktop_app_song_studio",
      reason: "timed-out",
    });
  });

  it("does not start, and releases the run, when it was stopped during the wait", async () => {
    const stopped = run("paused", {
      metadata: { runnerStoppedAt: "2026-11-06T12:00:00.000Z" },
    });
    const { input, release, events } = harness({
      metadata: { appId: "song-studio" },
      records: [run("running"), stopped],
      notices: [
        {
          serverId: "s",
          reason: "timed-out",
          message: "should not be written",
        },
      ],
    });
    expect(await prepareRunMcp(input)).toEqual({
      state: "abandoned",
      reason: "stopped-while-preparing",
    });
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(stopped);
    expect(events.map((event) => event.message)).toEqual([
      SONG_STUDIO_WAITING_MESSAGE,
    ]);
  });

  it("does not start, and releases the run, when its record is gone", async () => {
    const { input, release } = harness({
      metadata: { appId: "song-studio" },
      records: [run("running"), null],
    });
    expect(await prepareRunMcp(input)).toEqual({
      state: "abandoned",
      reason: "record-gone",
    });
    expect(release).toHaveBeenCalledWith(null);
  });

  it("starts, without releasing, a run that is still running", async () => {
    const { input, release } = harness({
      metadata: { appId: "song-studio" },
      records: [run("queued"), run("running")],
    });
    expect((await prepareRunMcp(input)).state).toBe("ready");
    expect(release).not.toHaveBeenCalled();
  });
});

describe("giving back what an abandoned run holds", () => {
  function held(withWorktree = true) {
    const worktreeId = withWorktree ? "wt-1" : undefined;
    const startingRuns = new Set(["run-1", "run-2"]);
    const reclaimTerminal = vi.fn();
    const releaseLease = vi.fn();
    const release = (record: Record<string, unknown> | null) =>
      releaseAbandonedRunStart({
        runId: "run-1",
        worktreeId,
        record,
        startingRuns,
        isTerminal: (candidate) => candidate.status === "paused",
        reclaimTerminal,
        releaseLease,
      });
    return { startingRuns, reclaimTerminal, releaseLease, release };
  }

  it("a stop during the wait frees the starting slot and reclaims the stopped run's worktree", () => {
    const { startingRuns, reclaimTerminal, releaseLease, release } = held();
    const stopped = run("paused");
    release(stopped);
    expect([...startingRuns]).toEqual(["run-2"]);
    expect(reclaimTerminal).toHaveBeenCalledWith(stopped);
    expect(releaseLease).not.toHaveBeenCalled();
  });

  it("a removed record frees the starting slot and releases the lease directly", () => {
    const { startingRuns, reclaimTerminal, releaseLease, release } = held();
    release(null);
    expect([...startingRuns]).toEqual(["run-2"]);
    expect(releaseLease).toHaveBeenCalledWith("wt-1");
    expect(reclaimTerminal).not.toHaveBeenCalled();
  });

  it("a run with no worktree only frees its starting slot", () => {
    const { startingRuns, releaseLease, release } = held(false);
    release(null);
    expect([...startingRuns]).toEqual(["run-2"]);
    expect(releaseLease).not.toHaveBeenCalled();
  });

  it("stop during the Song wait: no spawn, run stays stopped, slot and lease released", async () => {
    const { startingRuns, reclaimTerminal, release } = held();
    const stopped = run("paused", {
      metadata: { runnerStoppedAt: "2026-11-06T12:00:00.000Z" },
    });
    const records = [run("running"), stopped];
    const prepared = await prepareRunMcp({
      runMetadata: { appId: "song-studio" },
      readRecord: () => records.shift() ?? null,
      build: async () => ({ notices: [] }),
      announce: () => undefined,
      release,
    });
    expect(prepared.state).toBe("abandoned");
    expect(startingRuns.has("run-1")).toBe(false);
    expect(reclaimTerminal).toHaveBeenCalledWith(stopped);
  });
});
