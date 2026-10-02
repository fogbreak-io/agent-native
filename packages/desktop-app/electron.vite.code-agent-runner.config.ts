import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, type Plugin } from "vite";

const configDirectory = path.dirname(fileURLToPath(import.meta.url));
const runnerOutDir = path.join(configDirectory, "out", "main");
const smokeEntry =
  process.env.AGENT_NATIVE_PACKAGED_MULTI_FRONTIER_SMOKE === "1";

function copyRunnerRuntimePackages(): Plugin {
  return {
    name: "agent-native:copy-code-agent-runner-runtime-packages",
    closeBundle() {
      // AJV emits runtime require strings; copy their full frozen dependency
      // closure. MCP v2 no longer installs the former sdk/package.json path.
      const copied = new Map<string, string>();
      function copyPackage(packageName: string, from: NodeRequire): void {
        const packagePath = from.resolve(`${packageName}/package.json`);
        const previous = copied.get(packageName);
        if (previous === packagePath) return;
        if (previous)
          throw new Error(
            `Conflicting packaged runtime dependency: ${packageName}`,
          );
        copied.set(packageName, packagePath);
        const destination = path.join(
          runnerOutDir,
          "node_modules",
          packageName,
        );
        fs.rmSync(destination, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.cpSync(path.dirname(packagePath), destination, { recursive: true });
        const metadata = JSON.parse(fs.readFileSync(packagePath, "utf8")) as {
          dependencies?: Record<string, string>;
        };
        const packageRequire = createRequire(packagePath);
        for (const dependency of Object.keys(metadata.dependencies ?? {}))
          copyPackage(dependency, packageRequire);
      }
      const coreRequire = createRequire(
        path.join(configDirectory, "..", "core", "package.json"),
      );
      const workspaceRequire = createRequire(
        path.join(configDirectory, "..", "..", "package.json"),
      );
      copyPackage("ajv", coreRequire);
      copyPackage("undici", coreRequire);
      copyPackage("ajv-formats", workspaceRequire);
    },
  };
}

export default defineConfig({
  ssr: { external: ["ink"], noExternal: true },
  plugins: [copyRunnerRuntimePackages()],
  build: {
    emptyOutDir: false,
    outDir: runnerOutDir,
    rollupOptions: {
      external: ["electron", /^electron\/.+/],
      input: path.join(
        configDirectory,
        "src",
        "main",
        smokeEntry
          ? "packaged-multi-frontier-smoke-entry.ts"
          : "code-agent-runner-entry.ts",
      ),
      output: {
        entryFileNames: smokeEntry
          ? "packaged-multi-frontier-smoke-entry.js"
          : "code-agent-runner-entry.js",
        format: "cjs",
        codeSplitting: false,
      },
    },
    ssr: true,
  },
});
