/** Permissions any trusted app webview may use (own origin only; see isTrustedPermissionRequest). */
export const ALLOWED_WEBVIEW_PERMISSIONS = new Set([
  "clipboard-read",
  "clipboard-sanitized-write",
  "display-capture",
  "fullscreen",
  "media",
  "notifications",
]);

/**
 * Web MIDI is for the local Song Studio only (the HEAD TRIP remote and other
 * live controllers). fogbreak.io and every other app stay denied. SysEx is not
 * granted: requestMIDIAccess() without { sysex: true } asks for "midi" alone.
 */
const SONG_STUDIO_ONLY_WEBVIEW_PERMISSIONS = new Set(["midi"]);

export function isAllowedWebviewPermission(
  permission: string,
  targetAppId?: string | null,
): boolean {
  if (ALLOWED_WEBVIEW_PERMISSIONS.has(permission)) return true;
  return (
    targetAppId === "song-studio" &&
    SONG_STUDIO_ONLY_WEBVIEW_PERMISSIONS.has(permission)
  );
}
