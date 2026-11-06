import { describe, expect, it } from "vitest";

import desktopPackage from "../package.json";
import { declaredRuntimePackageNames } from "./declared-runtime-packages";

describe("declaredRuntimePackageNames", () => {
  it("lists dependencies and optionalDependencies once, sorted, never devDependencies", () => {
    expect(
      declaredRuntimePackageNames({
        dependencies: { zod: "^4", ai: "^6" },
        optionalDependencies: { ai: "^6", "@ai-sdk/google": "^3" },
      }),
    ).toEqual(["@ai-sdk/google", "ai", "zod"]);
  });

  it("is empty when nothing is declared", () => {
    expect(declaredRuntimePackageNames({})).toEqual([]);
  });

  it("ships the packages the built-in Gemini and OpenAI engines need", () => {
    const declared = declaredRuntimePackageNames(desktopPackage);
    for (const name of ["ai", "@ai-sdk/google", "@ai-sdk/openai"]) {
      expect(declared).toContain(name);
    }
    expect(declared).not.toContain("vitest");
  });
});
