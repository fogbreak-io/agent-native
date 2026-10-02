const DESKTOP_SSO_CANARY_VERSION = /-desktop-sso-canary\.\d+$/;

export function isDesktopSsoCanaryVersion(version: string): boolean {
  return DESKTOP_SSO_CANARY_VERSION.test(version);
}

export function resolveDesktopUserDataDirectoryName(
  isPackaged: boolean,
  version: string,
): string | null {
  if (!isPackaged) return "Fogbreak Dev";
  if (isDesktopSsoCanaryVersion(version)) return "Fogbreak SSO Canary";
  return version.includes("-nightly.") ? "Fogbreak Nightly" : "Fogbreak";
}

export type DesktopUpdateSupport =
  | { supported: true }
  | { supported: false; reason: string };

export function resolveDesktopUpdateSupport(
  isPackaged: boolean,
  version: string,
  buildChannel = "release",
): DesktopUpdateSupport {
  if (!isPackaged) {
    return {
      supported: false,
      reason: "Auto-update is unavailable for local development builds",
    };
  }

  if (buildChannel === "dev") {
    return {
      supported: false,
      reason: "Auto-update is unavailable for local packaged builds",
    };
  }

  if (buildChannel !== "dev" && buildChannel !== "release") {
    return {
      supported: false,
      reason: "Auto-update is unavailable for this Desktop build channel",
    };
  }

  if (isDesktopSsoCanaryVersion(version)) {
    return {
      supported: false,
      reason: "Auto-update is disabled for this Desktop SSO canary build",
    };
  }

  return {
    supported: false,
    reason:
      "Auto-update is unavailable until Fogbreak configures an owned update service",
  };
}
