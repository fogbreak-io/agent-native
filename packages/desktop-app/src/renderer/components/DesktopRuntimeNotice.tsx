import { Button } from "@agent-native/toolkit/ui/button";

export type ClaudeSignInState =
  | { status: "idle" }
  | { status: "opening" }
  | { status: "opened" }
  | { status: "failed"; message: string };

export interface DesktopRuntimeNoticeProps {
  /** Why Claude Code cannot run, from `desktopLocalRuntimeNotice`. */
  message?: string;
  canSignIn: boolean;
  signIn: ClaudeSignInState;
  onSignIn: () => void;
}

/** Plain-words Claude Code state with one sign-in button, shown in an empty app chat. */
export default function DesktopRuntimeNotice({
  message,
  canSignIn,
  signIn,
  onSignIn,
}: DesktopRuntimeNoticeProps) {
  const text =
    signIn.status === "failed"
      ? signIn.message
      : signIn.status === "opening"
        ? "Opening Terminal for Claude sign-in…"
        : signIn.status === "opened"
          ? "Finish signing in to Claude in Terminal. This panel updates when you come back."
          : message;
  if (!text) return null;
  return (
    <div
      role={signIn.status === "failed" ? "alert" : "status"}
      className="flex max-w-[30rem] flex-col items-center gap-2 px-4 text-center text-sm text-muted-foreground"
    >
      <p>{text}</p>
      {canSignIn ? (
        <Button
          size="sm"
          variant="outline"
          disabled={signIn.status === "opening"}
          onClick={onSignIn}
        >
          Sign in to Claude
        </Button>
      ) : null}
    </div>
  );
}
