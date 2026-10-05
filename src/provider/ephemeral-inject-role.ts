import {
  OPENCODE_GO_MESSAGES_PROVIDER,
  ZEN_MESSAGES_PROVIDER,
} from "./anthropic-session-adapter.js";

const ANTHROPIC_MESSAGES_PROVIDERS: ReadonlySet<string> = new Set([
  "anthropic",
  ZEN_MESSAGES_PROVIDER,
  OPENCODE_GO_MESSAGES_PROVIDER,
]);

const MID_CONVERSATION_SYSTEM_MODELS: readonly string[] = [
  "fable",
  "mythos",
  "opus-4-8",
  "opus-5",
];

function normalizeModel(model: string): string {
  return model.toLowerCase().replaceAll(".", "-");
}

/**
 * True when the provider/model pair is known to accept a system prompt
 * mid-conversation (past the head of the request). Provider and model must
 * both match: the Anthropic-messages wire shape on one side, a model new
 * enough to honor a mid-list system block on the other.
 */
export function midConversationSystemSupported(
  provider: string,
  model: string,
): boolean {
  if (!ANTHROPIC_MESSAGES_PROVIDERS.has(provider)) return false;
  const normalized = normalizeModel(model);
  return MID_CONVERSATION_SYSTEM_MODELS.some((fragment) =>
    normalized.includes(fragment),
  );
}

/**
 * False until a vendor adapter carries a mid-conversation system turn
 * through to the wire in position. The builtin Anthropic adapter hoists
 * every system-role turn into the head `system` block — and drops the
 * turn content entirely when `systemPrompt` is set — so a system-role
 * inject would either move to the head or vanish.
 */
export function adapterPreservesMidSystem(): false {
  return false;
}

// mailbox = work, ephemeral = inject: the durable transcript carries the
// working conversation, while ephemeral turns ride exactly one inference.
// An inject must never take the system role — the wire would hoist or drop
// it — so this stays "user" until adapterPreservesMidSystem() flips.
export function ephemeralInjectRole(
  provider: string,
  model: string,
): "user" | "system" {
  if (
    adapterPreservesMidSystem() &&
    midConversationSystemSupported(provider, model)
  ) {
    return "system";
  }
  return "user";
}
