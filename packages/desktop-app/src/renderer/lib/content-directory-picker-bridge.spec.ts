import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

import type { DesktopContentFilesResult } from "../../../shared/ipc-channels.js";
import { buildContentDirectoryPickerBridgeScript } from "./content-directory-picker-bridge.js";

interface FileHandle {
  name: string;
  queryPermission(): Promise<PermissionState>;
  requestPermission(): Promise<PermissionState>;
  getFile(): Promise<File>;
}

interface DirectoryHandle {
  name: string;
  queryPermission(): Promise<PermissionState>;
  requestPermission(): Promise<PermissionState>;
  getDirectoryHandle(name: string): Promise<DirectoryHandle>;
  getFileHandle(name: string): Promise<FileHandle>;
}

function setup() {
  const grants = new Map([
    ["folder-a", { id: "folder-a", name: "Docs" }],
    ["folder-b", { id: "folder-b", name: "Other" }],
  ]);
  const bridge = {
    chooseFolder: vi.fn(
      async (): Promise<DesktopContentFilesResult> => ({
        ok: true,
        folder: grants.get("folder-a")!,
      }),
    ),
    getFolder: vi.fn(
      async ({
        folderId,
      }: {
        folderId: string;
      }): Promise<DesktopContentFilesResult> => {
        const folder = grants.get(folderId);
        return folder
          ? { ok: true, folder }
          : {
              ok: false,
              code: "unavailable",
              error: "No local folder is linked.",
            };
      },
    ),
    readFiles: vi.fn(
      async ({
        folderId,
      }: {
        folderId: string;
      }): Promise<DesktopContentFilesResult> => {
        const folder = grants.get(folderId);
        return folder
          ? {
              ok: true,
              folder,
              sources: { "nested/note.md": "Fixture document" },
              revisions: { "nested/note.md": "fixture-revision" },
            }
          : {
              ok: false,
              code: "unavailable",
              error: "No local folder is linked.",
            };
      },
    ),
  };
  const location = {
    pathname: "/content/local-files",
    search: "?workspace=fixture-workspace",
    hash: "#fixture-document",
  };
  const window = {
    agentNativeDesktop: { contentFiles: bridge },
    location,
    showDirectoryPicker: undefined as unknown as () => Promise<DirectoryHandle>,
  };
  runInNewContext(buildContentDirectoryPickerBridgeScript(), {
    window,
    DOMException,
    File,
    Blob,
    ArrayBuffer,
    TextDecoder,
  });
  return { bridge, grants, window, location };
}

describe("Content native directory picker permission state", () => {
  it("queries metadata for the exact chosen grant without reading folder contents", async () => {
    const { bridge, window } = setup();
    const handle = await window.showDirectoryPicker();
    expect(await handle.queryPermission()).toBe("granted");
    expect(bridge.getFolder).toHaveBeenCalledExactlyOnceWith({
      folderId: "folder-a",
    });
    expect(bridge.readFiles).not.toHaveBeenCalled();
  });

  it("returns denied after revoke without choosing again or adopting another folder", async () => {
    const { bridge, grants, window } = setup();
    const handle = await window.showDirectoryPicker();
    grants.delete("folder-a");
    expect(await handle.queryPermission()).toBe("denied");
    expect(await handle.requestPermission()).toBe("denied");
    expect(bridge.getFolder).toHaveBeenCalledTimes(2);
    expect(bridge.getFolder).toHaveBeenLastCalledWith({ folderId: "folder-a" });
    expect(bridge.chooseFolder).toHaveBeenCalledOnce();
    expect(bridge.readFiles).not.toHaveBeenCalled();
  });

  it("applies the same revoked-grant state to nested directories and files", async () => {
    const { grants, window } = setup();
    const root = await window.showDirectoryPicker();
    const directory = await root.getDirectoryHandle("nested");
    const file = await directory.getFileHandle("note.md");
    expect(await file.queryPermission()).toBe("granted");
    grants.delete("folder-a");
    expect(await directory.requestPermission()).toBe("denied");
    expect(await file.queryPermission()).toBe("denied");
    expect(await file.requestPermission()).toBe("denied");
    await expect(file.getFile()).rejects.toMatchObject({
      name: "InvalidStateError",
    });
  });

  it("keeps cancellation observable and retains the prior folder and workspace/object route", async () => {
    const { bridge, window, location } = setup();
    const before = { ...location };
    const handle = await window.showDirectoryPicker();
    bridge.chooseFolder.mockResolvedValueOnce({
      ok: false,
      canceled: true,
      error: "No folder selected.",
    });
    await expect(window.showDirectoryPicker()).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(await handle.queryPermission()).toBe("granted");
    expect(location).toEqual(before);
    expect(handle.name).toBe("Docs");
  });

  it("does not coerce a failed metadata read into a permission result", async () => {
    const { bridge, window } = setup();
    const handle = await window.showDirectoryPicker();
    const failure = new Error("IPC unavailable");
    bridge.getFolder.mockRejectedValueOnce(failure);
    await expect(handle.queryPermission()).rejects.toBe(failure);
  });

  it("preserves normal Content authorization denial", async () => {
    const { bridge, window } = setup();
    const handle = await window.showDirectoryPicker();
    bridge.getFolder.mockResolvedValueOnce({
      ok: false,
      code: "invalid-request",
      error: "Content access denied",
    });
    await expect(handle.requestPermission()).rejects.toMatchObject({
      name: "InvalidStateError",
    });
    expect(bridge.chooseFolder).toHaveBeenCalledOnce();
  });

  it("rejects a metadata result for a different grant", async () => {
    const { bridge, window } = setup();
    const handle = await window.showDirectoryPicker();
    bridge.getFolder.mockResolvedValueOnce({
      ok: true,
      folder: { id: "folder-b", name: "Other" },
    });
    await expect(handle.queryPermission()).rejects.toMatchObject({
      name: "InvalidStateError",
    });
  });

  it("rejects a file read bound to a different folder", async () => {
    const { bridge, window } = setup();
    const handle = await window.showDirectoryPicker();
    bridge.readFiles.mockResolvedValueOnce({
      ok: true,
      folder: { id: "folder-b", name: "Other" },
      sources: { "note.md": "Different folder" },
    });
    await expect(handle.getFileHandle("note.md")).rejects.toMatchObject({
      name: "InvalidStateError",
    });
  });

  it("keeps revoked handles denied after choosing another folder and retains the route", async () => {
    const { bridge, grants, window, location } = setup();
    const before = { ...location };
    const oldHandle = await window.showDirectoryPicker();
    grants.delete("folder-a");
    bridge.chooseFolder.mockResolvedValueOnce({
      ok: true,
      folder: grants.get("folder-b")!,
    });
    const newHandle = await window.showDirectoryPicker();
    expect(await oldHandle.requestPermission()).toBe("denied");
    expect(await newHandle.queryPermission()).toBe("granted");
    expect(bridge.getFolder).toHaveBeenNthCalledWith(1, {
      folderId: "folder-a",
    });
    expect(bridge.getFolder).toHaveBeenNthCalledWith(2, {
      folderId: "folder-b",
    });
    expect(location).toEqual(before);
  });

  it("rejects a chosen folder without its opaque grant ID", async () => {
    const { bridge, window } = setup();
    bridge.chooseFolder.mockResolvedValueOnce({
      ok: true,
      folder: { name: "Docs" },
    });
    await expect(window.showDirectoryPicker()).rejects.toMatchObject({
      name: "InvalidStateError",
    });
    expect(bridge.getFolder).not.toHaveBeenCalled();
    expect(bridge.readFiles).not.toHaveBeenCalled();
  });
});
