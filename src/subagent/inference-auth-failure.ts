import { CodexAuthError } from "../auth/codex/session.js";
import { XaiAuthError } from "../auth/xai/session.js";

export type SubAgentAuthFailureKind = "codex" | "xai";

export function classifySubAgentInferenceAuthFailure(err: unknown): SubAgentAuthFailureKind | null {
  if (err instanceof CodexAuthError) return "codex";
  if (err instanceof XaiAuthError) return "xai";
  return null;
}

/** Actionable spawn_agent error when OAuth refresh or inference auth fails for a sub-agent. */
export function formatSubAgentSpawnAuthFailureMessage(
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
  // No "Error:" prefix — SessionStore.fail and tool-result surfaces add their own.
  return (
    `sub-agent "${description}" could not run inference (${providerLabel} profile "${profile}"). ` +
    `${detailSentence} Re-authenticate the profile from /model (Alt+A to Connect) and retry spawn_agent.`
  );
}
