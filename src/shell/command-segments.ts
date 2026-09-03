// Split a shell command into the individual commands it chains together, so each
// can be classified for security. The operator still approves the full command
// as one block (see buildRequests / gate). Operators recognised: && || | ; and a
// newline. Splitting is quote-aware — operators inside '...', "..." or `...` are
// part of an argument, not a separator. Heredoc bodies (<< 'MARKER' ... MARKER)
// are treated as atomic — newlines inside them are not chain boundaries.
// Parentheses group: operators inside a subshell or command substitution never
// split, and a segment that is exactly one `( ... )` group is unwrapped and its
// inner chain split recursively — so `(cd a && b)` yields `cd a` and `b`, not
// the fragment `(cd a`.
export function splitChainedCommand(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | "`" | null = null;
  let heredocMarker: string | null = null;
  let parenDepth = 0;

  const push = (): void => {
    const trimmed = current.trim();
    current = "";
    if (trimmed.length === 0) return;
    const inner = unwrapGroup(trimmed);
    if (inner !== null) {
      segments.push(...splitChainedCommand(inner));
      return;
    }
    segments.push(trimmed);
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string;

    // Inside a heredoc body: scan for the terminating marker on its own line.
    if (heredocMarker !== null) {
      current += ch;
      if (ch === "\n") {
        // Check whether the line just completed is the marker.
        const lines = current.split("\n");
        const lastLine = lines[lines.length - 2] ?? "";
        if (lastLine.trim() === heredocMarker) {
          heredocMarker = null;
        }
      }
      continue;
    }

    if (quote !== null) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }

    // Shell line continuation: a backslash immediately before a newline is
    // consumed by the shell (elides the newline for chaining purposes). Do not
    // append the \ or split the segment; this prevents fragments like "\" from
    // becoming approval subjects when agents emit continued commands.
    if (ch === "\\") {
      const after = command[i + 1];
      if (after === "\n" || after === "\r") {
        i += 1;
        if (after === "\r" && command[i + 1] === "\n") i += 1;
        continue;
      }
    }

    // Detect heredoc redirect: << or <<-
    if (ch === "<" && command[i + 1] === "<") {
      const opener = parseHeredocOpener(command, i);
      if (opener !== null) {
        current += command.slice(i, opener.lineEnd);
        i = opener.lineEnd - 1;
        heredocMarker = opener.marker;
        continue;
      }
    }

    if (ch === "(") {
      parenDepth++;
      current += ch;
      continue;
    }
    if (ch === ")") {
      if (parenDepth > 0) parenDepth--;
      current += ch;
      continue;
    }
    if (parenDepth > 0) {
      current += ch;
      continue;
    }

    const next = command[i + 1];
    // A chain operator immediately following a dangling redirect operator
    // (`>`, `<`, `>&`, `<&` with no target yet) does not start a new command —
    // the target got separated from its redirect, most often by a stray
    // separator a model inserted mid-redirect (e.g. "cmd 2>& ; 1" meaning
    // "cmd 2>&1"). Treat the operator as whitespace so the target rejoins the
    // command it belongs to, instead of surfacing as its own "Run shell
    // command" approval. A well-formed chain ("sleep 5 ; -1 ; echo end") has
    // no dangling redirect before the separator, so it is never affected.
    if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
      if (endsWithDanglingRedirect(current)) {
        current = `${current.trimEnd()} `;
        i++;
        continue;
      }
      push();
      i++;
      continue;
    }
    // `&` participates in a redirect when it opens a bash combined redirect
    // (`&>file`) or duplicates a fd after `>`/`<` (`2>&1`, `<&-`). In those
    // positions it is not a background operator and must not split the chain —
    // otherwise `bun run build 2>&1` fragments into a real command and a stray
    // `1`, and the operator gets a separate approval prompt for "1".
    if (ch === "&" && isRedirectAmpersand(next)) {
      current += ch;
      continue;
    }
    // A lone "&" backgrounds the preceding command and starts a new one, so it
    // is a chain boundary. Without this, "ls & rm -rf foo" is treated as a
    // single segment and the approval scope is derived from the benign head.
    if (ch === "|" || ch === ";" || ch === "\n" || ch === "&") {
      if (endsWithDanglingRedirect(current)) {
        current = `${current.trimEnd()} `;
        continue;
      }
      push();
      continue;
    }
    current += ch;
  }
  push();
  return segments;
}

// Parses a heredoc opener (`<<` or `<<-`) starting at `command[i]` (which must
// be the first "<"). Returns the terminating marker text and the exclusive end
// index of the line that opened the heredoc, so the caller can copy the
// opening line verbatim and resume scanning the heredoc body from there.
// Shared by splitChainedCommand and stripCommentLines so both stay in sync on
// what counts as heredoc syntax.
export function parseHeredocOpener(
  command: string,
  i: number,
): { marker: string; lineEnd: number } | null {
  if (command[i] !== "<" || command[i + 1] !== "<") return null;
  let j = i + 2;
  if (command[j] === "-") j++; // <<- strips leading tabs
  // Skip whitespace between << and the marker word.
  while (j < command.length && (command[j] === " " || command[j] === "\t")) j++;
  // The marker may be quoted ('EOF', "EOF", or bare EOF).
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
    // A bare (unquoted) marker is a single word; stop at whitespace so a
    // trailing redirect like `<<EOF > out.txt` is not folded into the
    // marker (which would leave the heredoc unterminated).
    !(markerQuote === null && (command[j] === " " || command[j] === "\t"))
  ) {
    marker += command[j++];
  }
  if (markerQuote !== null && command[j] === markerQuote) j++;
  // Advance j to the end of the line that opened the heredoc.
  while (j < command.length && command[j] !== "\n") j++;
  return { marker, lineEnd: j };
}

// Whether `text` ends (ignoring trailing whitespace) in a redirect operator
// that has not yet received its target: a bare `>`/`<`, or a fd-duplication
// opener `>&`/`<&` awaiting the fd number.
const DANGLING_REDIRECT = /(?:>&|<&|>|<)$/;

function endsWithDanglingRedirect(text: string): boolean {
  return DANGLING_REDIRECT.test(text.trimEnd());
}

// The inner chain of a segment that is exactly one parenthesised group, or null
// when the segment is not a bare group (trailing redirects like `(a && b) 2>&1`
// keep the segment atomic). Quote-aware so a `)` inside quotes does not close
// the group early.
function unwrapGroup(segment: string): string | null {
  if (segment[0] !== "(" || segment[segment.length - 1] !== ")") return null;
  let quote: '"' | "'" | "`" | null = null;
  let depth = 0;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i] as string;
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(") depth++;
    if (ch === ")") {
      depth--;
      if (depth === 0) return i === segment.length - 1 ? segment.slice(1, -1) : null;
    }
  }
  return null;
}

// `&` is the background operator when it stands alone as a word — followed by
// whitespace or end of input. Anywhere else it is part of a redirect token:
// `2>&1`, `<&-`, `&>file`.
function isRedirectAmpersand(next: string | undefined): boolean {
  return !(next === undefined || next === " " || next === "\t");
}
