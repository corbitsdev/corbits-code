import { errorMessage } from "../src/agent/error-message.js";
import { formatSubAgentSpawnAuthFailureMessage } from "../src/subagent/inference-auth-failure.js";

/**
 * Serializes every diagnostic projection a caught auth failure can take: the
 * error itself, the reactor retry/terminal event payloads, the log line, and
 * the sub-agent spawn guidance. Credential-leak tests assert the stored secret
 * never appears in any of them.
 */
export function authFailureSurface(auth: Error): string {
  return JSON.stringify({
    auth: String(auth),
    retry: {
      type: "inference.retry",
      data: { previousError: { message: auth.message } },
    },
    terminal: {
      type: "inference.error",
      data: { error: { message: auth.message } },
    },
    log: errorMessage(auth),
    guidance: formatSubAgentSpawnAuthFailureMessage("auth task", auth),
  });
}
