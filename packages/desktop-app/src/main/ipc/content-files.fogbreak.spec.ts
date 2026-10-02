import { IPC } from "@shared/ipc-channels";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  contentFilesWebviewDenialReason,
  type ContentFilesWebviewAccessInput,
} from "../content-files-webview-access.js";

const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => any>());
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: any[]) => any) =>
      handlers.set(channel, handler),
  },
}));
import {
  registerContentFilesIpc,
  type ContentFilesIpcDeps,
} from "./content-files.js";

const content: ContentFilesWebviewAccessInput = {
  senderType: "webview",
  senderId: 42,
  senderUrl: "https://fogbreak.io/content",
  activeAppId: "content",
  activeWebviewContentsId: 42,
  contentAppAvailable: true,
  trustedOrigins: ["https://fogbreak.io"],
  developmentOrigins: [],
  development: false,
};
function setup(input = content) {
  const denied = { ok: false as const, error: "Content access denied" };
  const deps = {
    requireContentFilesWebviewAccess: vi.fn(() =>
      contentFilesWebviewDenialReason(input) ? denied : null,
    ),
    getContentFilesGrants: vi.fn(() => []),
    getContentFilesGrant: vi.fn(() => null),
    contentFilesFolderInfo: vi.fn(),
    contentFilesFoldersInfo: vi.fn(() => []),
    chooseContentFilesFolder: vi.fn(async () => ({
      ok: false as const,
      canceled: true,
      error: "No folder selected.",
    })),
    associateContentFilesSource: vi.fn(),
    writeContentFilesForRequest: vi.fn(),
    writeContentFileForRequest: vi.fn(),
    deleteContentFileForRequest: vi.fn(),
    readContentFilesForRequest: vi.fn(),
    revealContentFileForRequest: vi.fn(),
    clearContentFilesGrant: vi.fn(() => ({
      ok: true as const,
      folder: { id: "fixture-folder", name: "Fixture" },
    })),
    subscribeContentFilesChanges: vi.fn(),
    unsubscribeContentFilesChanges: vi.fn(),
  } satisfies ContentFilesIpcDeps;
  registerContentFilesIpc(deps);
  return { deps, denied };
}
beforeEach(() => handlers.clear());
describe("Fogbreak Content IPC authorization", () => {
  it.each([
    { activeAppId: "fogbreak" },
    { activeAppId: "dispatch" },
    { activeWebviewContentsId: undefined },
    { senderId: 7 },
    { senderType: "window" },
    { senderUrl: "https://evil.example/content" },
    { senderUrl: "invalid" },
  ])(
    "denies every folder operation before invoking filesystem dependencies",
    async (override) => {
      const { deps, denied } = setup({ ...content, ...override });
      for (const handler of handlers.values())
        expect(await handler({}, {})).toEqual(denied);
      for (const [name, operation] of Object.entries(deps))
        if (name !== "requireContentFilesWebviewAccess")
          expect(operation).not.toHaveBeenCalled();
    },
  );
  it("preserves chooser cancellation without synthesizing a grant", async () => {
    const { deps } = setup();
    expect(await handlers.get(IPC.CONTENT_FILES_CHOOSE_FOLDER)!({})).toEqual({
      ok: false as const,
      canceled: true,
      error: "No folder selected.",
    });
    expect(deps.chooseContentFilesFolder).toHaveBeenCalledOnce();
    expect(deps.writeContentFilesForRequest).not.toHaveBeenCalled();
  });
  it("passes explicit revoke through the same access check", () => {
    const { deps } = setup();
    expect(
      handlers.get(IPC.CONTENT_FILES_CLEAR_FOLDER)!(
        {},
        { folderId: "fixture-folder" },
      ),
    ).toEqual({ ok: true, folder: { id: "fixture-folder", name: "Fixture" } });
    expect(deps.clearContentFilesGrant).toHaveBeenCalledExactlyOnceWith(
      "fixture-folder",
    );
  });
});
