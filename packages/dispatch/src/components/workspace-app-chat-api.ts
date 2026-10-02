import { agentNativePath } from "@agent-native/core/client/api-path";
import { useCallback, useEffect, useMemo, useState } from "react";

import { workspaceAppChatProxyPath } from "../shared/workspace-app-chat";

async function readWorkspaceAppChatProxyError(
  response: Response,
): Promise<string> {
  let body: string;
  try {
    body = await response.text();
  } catch {
    // coercion-ok: an unreadable body is reported as such, not as an empty error.
    return `Agent chat proxy returned ${response.status} with an unreadable body.`;
  }
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    if (typeof parsed.error === "string" && parsed.error) return parsed.error;
  } catch {
    // coercion-ok: a non-JSON body is still reportable as the status line.
  }
  return body.trim() || `Agent chat proxy returned ${response.status}.`;
}

export function useWorkspaceAppChatApi(appId: string, enabled = true) {
  const apiUrl = useMemo(
    () => agentNativePath(workspaceAppChatProxyPath(appId)),
    [appId],
  );
  const [attempt, setAttempt] = useState(0);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    setUnavailable(false);
    if (!enabled) return;
    let cancelled = false;
    void fetch(`${apiUrl}/mode`, { credentials: "include" })
      .then(async (response) => {
        if (response.ok) return;
        throw new Error(await readWorkspaceAppChatProxyError(response));
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        console.warn(
          `[dispatch] app chat proxy unavailable for ${appId}`,
          cause,
        );
        setUnavailable(true);
      });
    return () => {
      cancelled = true;
    };
  }, [apiUrl, appId, attempt, enabled]);

  return {
    apiUrl,
    unavailable,
    retry: useCallback(() => setAttempt((value) => value + 1), []),
  };
}
