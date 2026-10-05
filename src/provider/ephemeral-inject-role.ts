// Mailbox is for work; ephemeralTurns are for inject.
//
// Adapter hoist blocks `role: "system"` on the wire today: vendor
// `buildRequest` lifts every system turn into `body.system`, then drops
// those turns when `options.systemPrompt` is set. Until the adapter keeps
// mid-conversation system in `messages` under a system-prompt override,
// inject as `"user"`.
//
// Intended support (models that *could* keep mid-conversation system once
// the adapter preserves it): anthropic / zen-messages / opencode-go-messages
// with model-id substrings fable, mythos, opus-4.8, opus-4-8, opus-5.

import {
  OPENCODE_GO_MESSAGES_PROVIDER,
  ZEN_MESSAGES_PROVIDER,
} from "./anthropic-session-adapter.js";

const ANTHROPIC_PROTOCOL_PROVIDERS: ReadonlySet<string> = new Set([
  "anthropic",
  ZEN_MESSAGES_PROVIDER,
  OPENCODE_GO_MESSAGES_PROVIDER,
]);

const MID_CONVERSATION_SYSTEM_MODEL_MARKERS = [
  "fable",
  "mythos",
  "opus-4.8",
  "opus-4-8",
  "opus-5",
] as const;

export function midConversationSystemSupported(
  provider: string,
  model: string,
): boolean {
  if (!ANTHROPIC_PROTOCOL_PROVIDERS.has(provider)) return false;
  const id = model.toLowerCase();
  return MID_CONVERSATION_SYSTEM_MODEL_MARKERS.some((marker) =>
    id.includes(marker),
  );
}

function adapterPreservesMidSystem(): boolean {
  return false;
}

export function ephemeralInjectRole(
  provider: string,
  model: string,
): "system" | "user" {
  return midConversationSystemSupported(provider, model) &&
    adapterPreservesMidSystem()
    ? "system"
    : "user";
}
