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
 * live controllers). fogbreak.io and every other app stay denied.
 *
 * The shipped Electron (43.4.0) asks its request handler for "midiSysex" even
 * when the page calls requestMIDIAccess() without { sysex: true } (main.log
 * 2026-11-05 12:55:14: check "midi" allowed, request "midiSysex" denied, page got
 * NotAllowedError). So both are granted, to the Song Studio origin only.
 */
const SONG_STUDIO_ONLY_WEBVIEW_PERMISSIONS = new Set(["midi", "midiSysex"]);

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
