/**
 * Narrowing for the `@` path popup (pure).
 *
 * The suggestion source lists one directory at a time, so the token the
 * operator has typed is split into the directory to list and the fragment used
 * to narrow that listing. Narrowing happens here rather than in the source so
 * it can be case-insensitive and match anywhere in the entry name — typing
 * `@ses` is a search for `session.ts`, not a claim that the name begins `ses`.
 */

export type MentionToken = {
  /** Directory portion to list, with its trailing slash (empty = cwd). */
  readonly dir: string
  /** Text after the last slash — what the listing is narrowed against. */
  readonly fragment: string
}

export function splitMentionToken(prefix: string): MentionToken {
  const lastSlash = prefix.lastIndexOf("/")
  if (lastSlash === -1) return { dir: "", fragment: prefix }
  return {
    dir: prefix.slice(0, lastSlash + 1),
    fragment: prefix.slice(lastSlash + 1),
  }
}

function entryName(suggestion: string): string {
  const bare = suggestion.endsWith("/") ? suggestion.slice(0, -1) : suggestion
  const lastSlash = bare.lastIndexOf("/")
  return lastSlash === -1 ? bare : bare.slice(lastSlash + 1)
}

/**
 * Keep suggestions whose entry name contains `fragment`, case-insensitively,
 * with earlier matches first so a true prefix still sorts above an interior hit.
 */
export function filterMentionSuggestions(
  suggestions: readonly string[],
  fragment: string,
): readonly string[] {
  const needle = fragment.toLowerCase()
  if (needle.length === 0) return [...suggestions]
  return suggestions
    .map((suggestion, order) => ({
      suggestion,
      order,
      at: entryName(suggestion).toLowerCase().indexOf(needle),
    }))
    .filter((hit) => hit.at >= 0)
    .sort((a, b) => a.at - b.at || a.order - b.order)
    .map((hit) => hit.suggestion)
}
