import { Button } from "@agent-native/toolkit/ui/button";

export type ClaudeSignInState =
  | { status: "idle" }
  | { status: "opening" }
  | { status: "opened" }
  | { status: "not-yet" }
  | { status: "recheck-failed" }
  | { status: "failed"; message: string };

export interface DesktopRuntimeNoticeProps {
  /** Why Claude Code cannot run, from `desktopLocalRuntimeNotice`. */
  message?: string;
  canSignIn: boolean;
  signIn: ClaudeSignInState;
  onSignIn: () => void;
  onRetry: () => void;
  /** The model list could not be read: offer the same re-check as after a failed sign-in look. */
  canRetry: boolean;
  retryBusy: boolean;
}

/** Plain-words Claude Code state with one sign-in button, shown above the composer so it stays visible once the thread has messages. */
export default function DesktopRuntimeNotice({
  message,
  canSignIn,
  signIn,
  onSignIn,
  onRetry,
  canRetry,
  retryBusy,
}: DesktopRuntimeNoticeProps) {
  const text =
    signIn.status === "failed"
      ? signIn.message
      : signIn.status === "opening"
        ? "Opening Terminal for Claude sign-in…"
        : signIn.status === "opened"
          ? "Finish signing in to Claude in Terminal. This panel updates when you come back."
          : signIn.status === "not-yet"
            ? "Claude isn't signed in yet. This panel looks again when you come back."
            : signIn.status === "recheck-failed"
              ? "Fogbreak couldn't re-check the Claude sign-in. Try again, or switch back here and it will look again."
              : message;
  if (!text) return null;
  const retry = canRetry || signIn.status === "recheck-failed";
  return (
    <div
      role={signIn.status === "failed" ? "alert" : "status"}
      className="mx-3 mb-2 flex items-center justify-between gap-2 rounded-lg border border-border/70 bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
    >
      <p className="min-w-0 flex-1">{text}</p>
      {retry ? (
        <Button
          size="sm"
          variant="outline"
          className="shrink-0"
          disabled={retryBusy}
          onClick={onRetry}
        >
          Try again
        </Button>
      ) : canSignIn ? (
        <Button
          size="sm"
          variant="outline"
          className="shrink-0"
          disabled={signIn.status === "opening"}
          onClick={onSignIn}
        >
          Sign in to Claude
        </Button>
      ) : null}
    </div>
  );
}
