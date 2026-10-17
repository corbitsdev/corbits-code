/**
 * Shared director runtime primitives for the two Corbits directors
 * (ChatDirector and SubAgentDirector). Both extend the vendored
 * DefaultDirector; their duplicate nudge-turn plumbing lives here so the
 * ephemeral-nudge wire shape has one definition.
 */

import type {
  ReactorCapabilities,
  ReactorAction,
  ConversationTurn,
} from "@intx/types/runtime";
import type { ExtendedInferenceOptions } from "@intx/inference";

/**
 * Tail-appended discipline rules keep the prompt-cache hit; the base director
 * composes before super() for the same reason.
 */
export function composeDirectedPrompt(
  systemPrompt: string,
  disciplineRules: string | undefined,
): string {
  return disciplineRules !== undefined && disciplineRules.length > 0
    ? `${systemPrompt}\n\n${disciplineRules}`
    : systemPrompt;
}

function ephemeralNudgeTurn(text: string): ConversationTurn {
  return {
    role: "user",
    // Trim caller padding so the nudge matches the cached literal exactly.
    content: [{ type: "text", text: text.trim() }],
    timestamp: Date.now(),
  };
}

/**
 * Attach an armed nudge to an existing infer instead of building a fresh one
 * — a tool_use turn must be followed by tool_result, never a bare user turn,
 * so the nudge rides the infer that follows the pending tool calls.
 */
export function withEphemeralNudge(
  options: ExtendedInferenceOptions | undefined,
  text: string,
): ExtendedInferenceOptions {
  const turn = ephemeralNudgeTurn(text);
  const existing = options?.ephemeralTurns;
  if (existing === undefined || existing.length === 0) {
    return { ...(options ?? {}), ephemeralTurns: [turn] };
  }
  return { ...(options ?? {}), ephemeralTurns: [...existing, turn] };
}

export function inferWithEphemeralNudge(
  capabilities: ReactorCapabilities,
  text: string,
  options?: ExtendedInferenceOptions,
): ReactorAction {
  return capabilities.infer(withEphemeralNudge(options ?? {}, text));
}
