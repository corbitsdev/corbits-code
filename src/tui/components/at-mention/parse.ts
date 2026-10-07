export interface AtState {
  // The text the user has typed after the @ (may include path separators).
  prefix: string;
  // Index of the @ character in the full input string. Used for splice-completion.
  atStart: number;
}

// Non-null when the cursor is inside an @token: an @ before the cursor with
// no whitespace between them (@ at field start or mid-sentence). Null after
// a completed, space-terminated path or when the input has no @ at all.
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
