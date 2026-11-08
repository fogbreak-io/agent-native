import {
  SONG_STUDIO_APP_ID,
  boundAppIdFromRunMetadata,
  resolveDesktopAppMcpServer,
  type DesktopAppMcpServer,
  type DesktopMcpNotice,
} from "./desktop-app-mcp-servers.js";
import type { SongStudioReadyResult } from "./song-studio-local-session.js";

export const SONG_STUDIO_WAITING_MESSAGE = "Waiting for Song Studio to start";

export interface DesktopWorkspaceApp {
  id: string;
  name: string;
  baseUrl: string;
}

export interface WorkspaceAppMcpServers {
  servers: Record<string, DesktopAppMcpServer>;
  appIds: string[];
  notices: DesktopMcpNotice[];
}

/** What each enabled workspace app contributes to one run's MCP servers. */
export async function resolveWorkspaceAppMcpServers(input: {
  apps: DesktopWorkspaceApp[];
  boundAppId?: string | undefined;
  serverIdFor: (appId: string) => string;
  mcpUrlFor: (baseUrl: string) => string;
  readCookieHeader: (appId: string, mcpUrl: string) => Promise<string>;
  prepareSong: (baseUrl: string) => Promise<SongStudioReadyResult>;
}): Promise<WorkspaceAppMcpServers> {
  const result: WorkspaceAppMcpServers = {
    servers: {},
    appIds: [],
    notices: [],
  };
  for (const app of input.apps) {
    const serverId = input.serverIdFor(app.id);
    const mcpUrl = input.mcpUrlFor(app.baseUrl);
    const resolution = await resolveDesktopAppMcpServer({
      app: { id: app.id, name: app.name },
      serverId,
      mcpUrl,
      boundAppId: input.boundAppId,
      cookieHeader: await input.readCookieHeader(app.id, mcpUrl),
      songStudio: { prepare: () => input.prepareSong(app.baseUrl) },
    });
    if (resolution.state === "omitted") {
      if (resolution.notice) result.notices.push(resolution.notice);
      continue;
    }
    result.servers[serverId] = resolution.server;
    result.appIds.push(app.id);
  }
  return result;
}

/** The parts of a run record that say whether someone stopped it meanwhile. */
export interface RunSpawnSnapshot {
  status: string | undefined;
  phase: string | undefined;
  stoppedAt: string | undefined;
}

function stringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

export function snapshotRunForSpawn(
  record: Record<string, unknown> | null,
): RunSpawnSnapshot | null {
  if (!record) return null;
  const metadata = record.metadata;
  const stoppedAt =
    typeof metadata === "object" && metadata !== null
      ? (metadata as { runnerStoppedAt?: unknown }).runnerStoppedAt
      : undefined;
  return {
    status: stringField(record, "status"),
    phase: stringField(record, "phase"),
    stoppedAt: typeof stoppedAt === "string" ? stoppedAt : undefined,
  };
}

const STARTABLE_STATUSES: ReadonlySet<string | undefined> = new Set([
  "queued",
  "running",
]);

export type SpawnDecision =
  | { action: "spawn" }
  | { action: "abandon"; reason: "record-gone" | "stopped-while-preparing" };

/**
 * A resume spawns a run that is already paused, so "not startable" alone is
 * not a stop; it is a stop when the record moved into that state, or was
 * stopped again, while the runner was being prepared.
 */
export function decideSpawnAfterPrepare(
  before: RunSpawnSnapshot | null,
  after: RunSpawnSnapshot | null,
): SpawnDecision {
  if (!after) return { action: "abandon", reason: "record-gone" };
  if (STARTABLE_STATUSES.has(after.status)) return { action: "spawn" };
  const changed =
    !before ||
    before.status !== after.status ||
    before.phase !== after.phase ||
    before.stoppedAt !== after.stoppedAt;
  return changed
    ? { action: "abandon", reason: "stopped-while-preparing" }
    : { action: "spawn" };
}

export type PreparedRunMcp<T> =
  | { state: "ready"; mcp: T }
  | {
      state: "abandoned";
      reason: Extract<SpawnDecision, { action: "abandon" }>["reason"];
    };

/**
 * Builds a run's MCP environment, which for a run opened from Song waits for
 * Song to be ready, and says so first. If the run was stopped or removed
 * during that wait it is released instead of started; otherwise any notices
 * are written to the run.
 */
export async function prepareRunMcp<
  T extends { notices: DesktopMcpNotice[] },
>(input: {
  runMetadata: unknown;
  readRecord: () => Record<string, unknown> | null;
  build: (boundAppId: string | undefined) => Promise<T>;
  announce: (message: string, metadata: Record<string, unknown>) => void;
  release: (after: Record<string, unknown> | null) => void;
}): Promise<PreparedRunMcp<T>> {
  const boundAppId = boundAppIdFromRunMetadata(input.runMetadata);
  const before = snapshotRunForSpawn(input.readRecord());
  if (boundAppId === SONG_STUDIO_APP_ID) {
    input.announce(SONG_STUDIO_WAITING_MESSAGE, {
      source: "desktop-mcp-config",
      serverId: "desktop_app_song_studio",
      reason: "waiting",
    });
  }
  const mcp = await input.build(boundAppId);
  const afterRecord = input.readRecord();
  const decision = decideSpawnAfterPrepare(
    before,
    snapshotRunForSpawn(afterRecord),
  );
  if (decision.action === "abandon") {
    input.release(afterRecord);
    return { state: "abandoned", reason: decision.reason };
  }
  for (const notice of mcp.notices) {
    input.announce(notice.message, {
      source: "desktop-mcp-config",
      serverId: notice.serverId,
      reason: notice.reason,
    });
  }
  return { state: "ready", mcp };
}

/**
 * Gives back what a run holds when it is not started after all: its place in
 * the set of runs being started, and its worktree lease. A stopped run's
 * record is terminal and its worktree is reclaimed as for any finished run; a
 * removed or otherwise non-terminal one has its lease released directly.
 */
export function releaseAbandonedRunStart(input: {
  runId: string;
  worktreeId: string | undefined;
  record: Record<string, unknown> | null;
  startingRuns: { delete: (runId: string) => unknown };
  isTerminal: (record: Record<string, unknown>) => boolean;
  reclaimTerminal: (record: Record<string, unknown>) => void;
  releaseLease: (worktreeId: string) => void;
}): void {
  input.startingRuns.delete(input.runId);
  if (input.record && input.isTerminal(input.record)) {
    input.reclaimTerminal(input.record);
    return;
  }
  if (input.worktreeId) input.releaseLease(input.worktreeId);
}
