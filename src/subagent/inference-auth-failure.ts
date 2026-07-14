import { CodexAuthError } from "../auth/codex/session.js";
import { XaiAuthError } from "../auth/xai/session.js";

export type SubAgentAuthFailureKind = "codex" | "xai";

export function classifySubAgentInferenceAuthFailure(
  err: unknown,
): SubAgentAuthFailureKind | null {
  if (err instanceof CodexAuthError) return "codex";
  if (err instanceof XaiAuthError) return "xai";
  return null;
}

/** Actionable task-tool error when OAuth refresh or inference auth fails for a sub-agent. */
export function formatSubAgentTaskAuthFailureMessage(
  description: string,
  err: unknown,
): string | null {
  const kind = classifySubAgentInferenceAuthFailure(err);
  if (kind === null) return null;
  const profile =
    err instanceof CodexAuthError || err instanceof XaiAuthError ? err.profile : "default";
  const detail = err instanceof Error ? err.message : String(err);
  const detailSentence = detail.endsWith(".") ? detail : `${detail}.`;
  const providerLabel = kind === "codex" ? "Codex" : "xAI";
  return (
    `Error: sub-agent "${description}" could not run inference (${providerLabel} profile "${profile}"). ` +
    `${detailSentence} Re-authenticate the profile (login modal or /login) and retry the task.`
  );
}