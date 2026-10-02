import type { AppConfig } from "@agent-native/shared-app-config";

export const FOGBREAK_ORIGIN = "https://fogbreak.io";
export const FOGBREAK_SESSION_PARTITION = "persist:fogbreak-workspace";
export const FOGBREAK_APP_ID = "fogbreak";

export function isFogbreakHostedApp(
  app: Pick<AppConfig, "id" | "url" | "mode">,
): boolean {
  if (
    !["fogbreak", "content", "dispatch"].includes(app.id) ||
    app.mode === "dev"
  )
    return false;
  try {
    const url = new URL(app.url);
    return url.origin === FOGBREAK_ORIGIN && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function desktopAppSessionPartition(
  app: Pick<AppConfig, "id" | "url" | "mode">,
): string {
  return isFogbreakHostedApp(app)
    ? FOGBREAK_SESSION_PARTITION
    : `persist:app-${app.id}`;
}

export function resolveFogbreakOpenUrl(
  app: Pick<AppConfig, "id" | "url" | "mode">,
  path?: string,
): string | null {
  if (!isFogbreakHostedApp(app)) return null;
  if (!path) return app.url;
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(path) ||
    /^\/[a-z][a-z0-9+.-]*:/i.test(path)
  )
    return null;
  const target = new URL(path, FOGBREAK_ORIGIN);
  return target.origin === FOGBREAK_ORIGIN ? target.toString() : null;
}
