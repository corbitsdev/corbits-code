// Shared shell tokenizer helpers used by both the permission gate
// (src/permission/command.ts) and the display layer (src/tui/command-display.ts).
// Keeping a single copy ensures both paths agree on what counts as a heredoc
// opener, what `&` means in redirect context, and that `<<<` (here-string) is
// never mistaken for a heredoc.

export function isRedirectAmpersand(next: string | undefined): boolean {
  return !(next === undefined || next === " " || next === "\t");
}

// Parses a heredoc opener (`<<` or `<<-`) starting at `command[i]` (which must
// be the first "<"). Returns the terminating marker text and the exclusive end
// index of the line that opened the heredoc, so the caller can copy the opening
// line verbatim and resume scanning the heredoc body from there.
// `<<<` (here-string) is explicitly rejected — it is not a heredoc opener.
export function parseHeredocOpener(
  command: string,
  i: number,
): { marker: string; lineEnd: number } | null {
  if (
    command[i] !== "<" ||
    command[i + 1] !== "<" ||
    command[i - 1] === "<" ||
    command[i + 2] === "<"
  ) {
    return null;
  }
  let j = i + 2;
  if (command[j] === "-") j++; // <<- strips leading tabs
  while (j < command.length && (command[j] === " " || command[j] === "\t")) j++;
  let markerQuote: string | null = null;
  if (command[j] === "'" || command[j] === '"') {
    markerQuote = command[j] as string;
    j++;
  }
  let marker = "";
  while (
    j < command.length &&
    command[j] !== "\n" &&
    command[j] !== markerQuote &&
    !(markerQuote === null && (command[j] === " " || command[j] === "\t"))
  ) {
    marker += command[j++];
  }
  if (markerQuote !== null && command[j] === markerQuote) j++;
  while (j < command.length && command[j] !== "\n") j++;
  return { marker, lineEnd: j };
}
