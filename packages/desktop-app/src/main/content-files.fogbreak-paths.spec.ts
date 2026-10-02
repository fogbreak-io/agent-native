import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";

// Exercise the existing main-process guards without booting Electron, running
// its scheduler, or granting a real user directory. Production code is unchanged.
const source = fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile(
  "index.ts",
  source,
  ts.ScriptTarget.Latest,
  true,
);
const names = [
  "normalizeContentSourcePath",
  "assertContentSourceTextSize",
  "assertInsideContentFolder",
  "assertUsableContentFolder",
  "assertNoContentSymlink",
  "noFollowOpenFlags",
  "readContentMarkdownFileWithoutSymlink",
  "assertInsideLocalFolder",
  "assertRealPathInsideLocalFolder",
];
const selected = ast.statements.filter(
  (node) =>
    ts.isFunctionDeclaration(node) &&
    node.name &&
    names.includes(node.name.text),
);
if (selected.length !== names.length)
  throw new Error(
    "Content guard source closure changed; update this regression fixture deliberately",
  );
const size = ast.statements.find(
  (node) =>
    ts.isVariableStatement(node) &&
    node.declarationList.declarations.some(
      (declaration) =>
        declaration.name.getText(ast) === "CONTENT_SOURCE_FILE_MAX_BYTES",
    ),
);
if (!size) throw new Error("Content size limit is missing");
const compiled = ts.transpileModule(
  [
    size.getText(ast),
    ...selected.map((node) => node.getText(ast)),
    `globalThis.guards = { ${names.join(", ")} };`,
  ].join("\n"),
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  },
).outputText;
const context = vm.createContext({ fs, path, Buffer });
vm.runInContext(compiled, context);
const guards = context.guards as {
  normalizeContentSourcePath: (path: string) => string | null;
  assertContentSourceTextSize: (file: string, content: string) => void;
  assertInsideContentFolder: (folder: string, target: string) => string;
  assertUsableContentFolder: (folder: string) => Promise<void>;
  assertNoContentSymlink: (file: string) => Promise<void>;
  readContentMarkdownFileWithoutSymlink: (file: string) => string | null;
  assertRealPathInsideLocalFolder: (folder: string, file: string) => string;
};
const directories: string[] = [];
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fogbreak-content-test-"));
  directories.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of directories.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("unchanged Content path and size boundaries", () => {
  it.each([
    "../private.md",
    "folder/../private.md",
    "folder/./note.md",
    "folder//note.md",
    "note\0.md",
  ])("rejects invalid relative path %s", (value) =>
    expect(guards.normalizeContentSourcePath(value)).toBeNull(),
  );
  it("rejects traversal and sibling-prefix paths", () => {
    const dir = fixture();
    expect(() =>
      guards.assertInsideContentFolder(dir, path.join(dir, "..", "private.md")),
    ).toThrow("escaped");
    expect(() =>
      guards.assertInsideContentFolder(dir, `${dir}-other/note.md`),
    ).toThrow("escaped");
  });
  it("rejects folder/file symlinks and realpath escapes", async () => {
    const dir = fixture();
    const outside = fixture();
    fs.writeFileSync(path.join(outside, "note.md"), "fixture only");
    const linked = path.join(dir, "linked");
    fs.symlinkSync(outside, linked);
    await expect(guards.assertUsableContentFolder(linked)).rejects.toThrow(
      "symlinks",
    );
    await expect(guards.assertNoContentSymlink(linked)).rejects.toThrow(
      "symlinked",
    );
    expect(() =>
      guards.assertRealPathInsideLocalFolder(dir, path.join(linked, "note.md")),
    ).toThrow("escaped");
    const fileLink = path.join(dir, "note.md");
    fs.symlinkSync(path.join(outside, "note.md"), fileLink);
    expect(guards.readContentMarkdownFileWithoutSymlink(fileLink)).toBeNull();
  });
  it("enforces the 2 MB byte limit for writes and reads", () => {
    const limit = 2 * 1024 * 1024;
    const dir = fixture();
    const file = path.join(dir, "note.md");
    expect(() =>
      guards.assertContentSourceTextSize(file, "a".repeat(limit)),
    ).not.toThrow();
    expect(() =>
      guards.assertContentSourceTextSize(file, "a".repeat(limit + 1)),
    ).toThrow("2 MB");
    expect(() =>
      guards.assertContentSourceTextSize(file, "é".repeat(limit)),
    ).toThrow("2 MB");
    fs.writeFileSync(file, "a".repeat(limit + 1));
    expect(guards.readContentMarkdownFileWithoutSymlink(file)).toBeNull();
    fs.writeFileSync(file, "fixture only");
    expect(guards.readContentMarkdownFileWithoutSymlink(file)).toBe(
      "fixture only",
    );
  });
});
