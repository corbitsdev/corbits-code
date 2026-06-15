export type AtState = {
  // The text the user has typed after the @ (may include path separators).
  prefix: string;
  // Index of the @ character in the full input string. Used for splice-completion.
  atStart: number;
};

// Pure function: returns non-null when the cursor is inside an @token — i.e.
// there is an @ somewhere before the cursor with no whitespace between it and
// the cursor. Handles @ at the start of the field and @ mid-sentence.
// Returns null when the cursor is not inside an @token (e.g. cursor is right
// after a completed, space-terminated path, or the input has no @ at all).
export function parseAtState(value: string, cursor: number): AtState | null {
  if (cursor === 0) return null;
  // Walk backwards from cursor-1 looking for @ with no intervening whitespace.
  for (let i = cursor - 1; i >= 0; i--) {
    const ch = value[i];
    if (ch === "@") {
      return { prefix: value.slice(i + 1, cursor), atStart: i };
    }
    // Any whitespace between the cursor and the candidate @ breaks the token.
    if (ch === " " || ch === "\t" || ch === "\n") return null;
  }
  return null;
}
