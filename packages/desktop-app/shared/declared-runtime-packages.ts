/**
 * Package names the packaged code-agent runner has bundled. Core reads them
 * from AGENT_NATIVE_BUILD_ENGINE_PACKAGES because `require.resolve` cannot see
 * a bundled package (core/src/agent/engine/registry.ts), the same marker
 * core's deploy build derives from a project's declared runtime dependencies.
 */
export function declaredRuntimePackageNames(manifest: {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}): string[] {
  return [
    ...new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
    ]),
  ].sort();
}

export const BUILD_ENGINE_PACKAGES_ENV = "AGENT_NATIVE_BUILD_ENGINE_PACKAGES";
