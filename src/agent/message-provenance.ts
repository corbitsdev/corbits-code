/**
 * This flag means a human typed something at the prompt; nothing else may
 * set it.
 *
 * Earlier loop-protection rounds reset `turnsSinceUserMessage` on
 * conditions the model or the system itself could trigger. Denylisting
 * known synthetic senders only excludes the ones someone remembered; the
 * next synthetic send resets the counter again. This flag inverts that: an
 * allowlist set only at the genuine human-input submit sites (TUI prompt
 * submit, exec's initial task), so anything that does not explicitly claim
 * to be operator input — retries, nudges, resumes, compaction
 * continuations — is system-originated by default.
 */
export const OPERATOR_ORIGINATED_FLAG = "operator-originated";

export function isOperatorOriginated(
  flags: readonly string[] | undefined,
): boolean {
  return flags !== undefined && flags.includes(OPERATOR_ORIGINATED_FLAG);
}
