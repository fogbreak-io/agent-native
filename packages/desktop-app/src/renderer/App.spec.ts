import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
describe("Fogbreak hosted desktop shell", () => {
  it("composes the existing sandboxed AppWebview without launching a provider shell", () => {
    expect(source).toContain("<AppWebview");
    expect(source).toContain("sourceUrl={views[app.id].url}");
    expect(source).toContain("partitionKey={FOGBREAK_SESSION_PARTITION}");
    expect(source).toContain("syncTheme={false}");
    expect(source).toContain("syncAppChatSidebar={false}");
    expect(source).not.toContain("CodeAgentsHub");
    expect(source).not.toContain("createDesktopAppFromPrompt");
    expect(source).not.toContain('embedded: "1"');
  });
  it("retains the identity gate and follows the SSO-off idle path", () => {
    expect(source).toContain("<DesktopIdentityGate");
    expect(source).toContain('appName="Fogbreak"');
    expect(source).toMatch(/identity\s*\.getStatus\(\)/);
    expect(source).not.toContain("desktopIdentityGateDismissed");
    expect(source).toContain("key={settingsTab}");
    expect(source).toContain("initialTab={settingsTab}");
  });
  it("keeps unavailable inventory observable and prevents stale refreshes", () => {
    expect(source).toContain("generation === inventoryGeneration.current");
    expect(source).toContain("workspaceAppList?.unavailable");
    expect(source).toContain('role="status"');
  });
  it("keeps Content a genuine explicit app selection rather than impersonating it on root navigation", () => {
    expect(source).toContain("resolveFogbreakOpenUrl(target, request.path)");
    expect(source).toContain("setActiveAppId(appId)");
    expect(source).toContain("app={toAppDefinition(app)}");
    expect(source).not.toContain('app={{ id: "content"');
  });
});
