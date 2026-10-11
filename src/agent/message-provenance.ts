/**
 * Set only where a human actually typed at the prompt (TUI prompt submit,
 * exec's initial task). A denylist of known synthetic senders would miss the
 * next one; this allowlist means anything that does not explicitly claim
 * operator input — retries, nudges, resumes, compaction continuations — is
 * system-originated by default, so loop-protection counters reset only on
 * real human input.
 */
export const OPERATOR_ORIGINATED_FLAG = "operator-originated";

export function isOperatorOriginated(
  flags: readonly string[] | undefined,
): boolean {
  return flags !== undefined && flags.includes(OPERATOR_ORIGINATED_FLAG);
}
