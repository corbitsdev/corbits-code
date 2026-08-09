/**
 * This flag means a human typed something at the prompt; nothing else may
 * set it.
 *
 * Round 1-4 of the tool-only loop-protection backstop each reset
 * `turnsSinceUserMessage` on a condition the model or the system itself
 * could trigger (consecutive-identical fingerprints, narrated text,
 * any `message.received` event including synthetic compaction
 * continuations). Denylisting known synthetic senders only excludes the
 * ones someone remembered; the next synthetic send silently resets the
 * counter again. This flag inverts that: it is an allowlist set only at
 * the genuine human-input submit sites (TUI prompt submit, exec's initial
 * task), so anything that does not explicitly claim to be operator input
 * — retries, nudges, resumes, compaction continuations, future director
 * continuations — is system-originated by default and cannot accidentally
 * qualify.
 */
export const OPERATOR_ORIGINATED_FLAG = "operator-originated";

export function isOperatorOriginated(flags: readonly string[] | undefined): boolean {
  return flags !== undefined && flags.includes(OPERATOR_ORIGINATED_FLAG);
}
