import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { builtinModules, createRequire, isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const desktop = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(desktop, "out");
const builtin = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
  "electron",
]);
const failures: string[] = [];
let checked = 0;
const optionalInterfaces = new Set<string>();
function isOptionalAgentsBundle(node: ts.Node, specifier: string): boolean {
  if (specifier !== "virtual:agents-bundle") return false;
  let guarded = false;
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isTryStatement(parent) && parent.catchClause) guarded = true;
    if (ts.isFunctionDeclaration(parent))
      return guarded && parent.name?.text === "loadAgentsBundle";
  }
  return false;
}
function visitFile(file: string) {
  const code = readFileSync(file, "utf8");
  const ast = ts.createSourceFile(
    file,
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const require = createRequire(file);
  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          ["require", "__require"].includes(node.expression.text))) &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      const specifier = node.arguments[0].text;
      // Core deliberately probes this Vite-only virtual module inside a catch
      // before its filesystem loader. It is not a required desktop dependency.
      if (isOptionalAgentsBundle(node, specifier)) {
        optionalInterfaces.add(specifier);
        return;
      }
      if (
        !isBuiltin(specifier) &&
        !builtin.has(specifier) &&
        !specifier.startsWith("electron/")
      ) {
        checked++;
        try {
          const resolved = realpathSync(require.resolve(specifier));
          const packagedPty =
            specifier === "node-pty" &&
            resolved.startsWith(
              realpathSync(path.join(desktop, "node_modules/node-pty")) +
                path.sep,
            );
          if (!resolved.startsWith(output + path.sep) && !packagedPty)
            failures.push(
              `${path.relative(output, file)}: ${specifier} resolves outside packaged files`,
            );
        } catch {
          failures.push(
            `${path.relative(output, file)}: ${specifier} is unresolved`,
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
}
function walk(directory: string) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (entry.name.endsWith(".js")) visitFile(file);
  }
}
for (const name of [
  "main/index.js",
  "preload/index.js",
  "preload/webview.js",
  "preload/webview-chat.js",
]) {
  if (!existsSync(path.join(output, name)))
    throw new Error(`Missing build output: ${name}`);
}
walk(path.join(output, "main"));
walk(path.join(output, "preload"));
// These runtime modules are named in AJV-generated code strings, not ordinary
// require AST nodes. Resolve the frozen copied graph without a workspace fallback.
const packagedRequire = createRequire(path.join(output, "main/index.js"));
const checkedPackages = new Set<string>();
function checkRuntimePackage(name: string, from: NodeRequire): void {
  const metadataPath = from.resolve(`${name}/package.json`);
  if (!realpathSync(metadataPath).startsWith(output + path.sep))
    throw new Error(`Runtime dependency escaped packaged output: ${name}`);
  if (checkedPackages.has(metadataPath)) return;
  checkedPackages.add(metadataPath);
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  for (const dependency of Object.keys(metadata.dependencies ?? {}))
    checkRuntimePackage(dependency, createRequire(metadataPath));
}
for (const name of ["ajv", "ajv-formats", "undici"])
  checkRuntimePackage(name, packagedRequire);
for (const specifier of [
  "ajv/dist/runtime/equal",
  "ajv/dist/runtime/uri",
  "ajv/dist/runtime/ucs2length",
  "ajv/dist/runtime/validation_error",
  "ajv-formats/dist/formats",
]) {
  const target = packagedRequire.resolve(specifier);
  if (!realpathSync(target).startsWith(output + path.sep))
    throw new Error(
      `Generated runtime require escaped packaged output: ${specifier}`,
    );
  packagedRequire(specifier);
}
if (failures.length)
  throw new Error(
    `Packaged dependency closure failed:\n${[...new Set(failures)].join("\n")}`,
  );
console.log(
  `Fogbreak main/preload static dependency closure passed (${checked} static nonbuiltin requires; ${checkedPackages.size} generated-runtime packages). Archive/native dynamic loading still requires macOS packaging smoke.`,
);

console.log(
  `Optional upstream runtime probes: ${[...optionalInterfaces].join(", ") || "none"}`,
);
