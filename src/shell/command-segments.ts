// Split a shell command into the individual commands it chains together, so each
// can be classified for security. The operator still approves the full command
// as one block (see buildRequests / gate). Operators recognised: && || | ; and a
// newline. Splitting is quote-aware — operators inside '...', "..." or `...` are
// part of an argument, not a separator. Heredoc bodies (<< 'MARKER' ... MARKER)
// are treated as atomic — newlines inside them are not chain boundaries.
// Parentheses group: operators inside a subshell or command substitution never
// split, and a segment that is exactly one `( ... )` group is unwrapped and its
// inner chain split recursively — so `(cd a && b)` yields `cd a` and `b`, not
// the fragment `(cd a`. `<<` inside `(( ... ))` / `$(( ... ))` arithmetic is the
// left-shift operator and a top-level `#` starts a comment — neither opens a
// heredoc (see isArithmeticOpener / isCommentStart).
export function splitChainedCommand(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | "`" | null = null;
  let heredocMarker: string | null = null;
  let heredocStripTabs = false;
  let parenDepth = 0;
  let arithDepth = 0;
  let commentToEOL = false;
  // Inside a top-level `#`-to-EOL comment: suppresses only the `<<` heredoc
  // opener below. Chain operators after `#` still split, so
  // `# note && rm -rf /` surfaces `rm -rf /` as its own segment.

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
    // A second `<<` down here is payload, never a nested opener.
    if (heredocMarker !== null) {
      current += ch;
      if (ch === "\n") {
        // Check whether the line just completed is the marker.
        const lines = current.split("\n");
        const lastLine = lines[lines.length - 2] ?? "";
        if (isHeredocTerminator(lastLine, heredocMarker, heredocStripTabs)) {
          heredocMarker = null;
          heredocStripTabs = false;
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
    // A top-level `#` starts a comment through end of line: a `<<` down there
    // (e.g. `# example: cat <<EOF`) documents rather than opens. Only the
    // opener is suppressed — the comment text flows through the normal scan
    // below, so chain operators after `#` still split.
    if (ch === "\n") commentToEOL = false;
    if (!commentToEOL && arithDepth === 0 && isCommentStart(command, i)) {
      commentToEOL = true;
    }
    if (
      !commentToEOL &&
      arithDepth === 0 &&
      ch === "<" &&
      command[i + 1] === "<"
    ) {
      const opener = parseHeredocOpener(command, i);
      if (opener !== null) {
        current += command.slice(i, opener.lineEnd);
        i = opener.lineEnd - 1;
        heredocMarker = opener.marker;
        heredocStripTabs = opener.stripTabs;
        continue;
      }
    }

    if (ch === "(" && !commentToEOL) {
      // `((` / `$((` opens arithmetic, where `<<` shifts instead of opening a
      // heredoc (see the `<<` guard above). Bare `(` subshells still detect
      // heredocs — e.g. `(cat <<EOF ...)` is genuine.
      if (isArithmeticOpener(command, i)) arithDepth++;
      parenDepth++;
      current += ch;
      continue;
    }
    if (ch === ")" && !commentToEOL) {
      if (isArithmeticCloser(command, i) && arithDepth > 0) arithDepth--;
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
    // `&` is redirect-bound only by its neighbours: a preceding `>`/`<`
    // (fd duplication: `2>&1`, `>&2`, `<&-`) or an immediately following `>`
    // (combined redirect: `&>file`, `&>>file`). Any other `&` — including one
    // with no trailing space (`a &b`) — is the background operator and must
    // split the chain; otherwise `bun run build 2>&1` fragments into a real
    // command and a stray `1`, and the operator gets a separate approval
    // prompt for "1".
    if (ch === "&" && isRedirectAmpersand(previousNonSpace(current), next)) {
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

// Whether text[i] opens an arithmetic context (`((` or `$((`): inside it `<<`
// is the left-shift operator, never a heredoc opener. Keyed on the doubled
// paren — a bare `( ... )` subshell can still contain a genuine heredoc.
// Deliberately not a full arithmetic evaluator: callers only track depth.
export function isArithmeticOpener(text: string, i: number): boolean {
  return text[i] === "(" && text[i + 1] === "(";
}

// Whether text[i] closes one arithmetic-context level (`))`).
export function isArithmeticCloser(text: string, i: number): boolean {
  return text[i] === ")" && text[i + 1] === ")";
}

// Whether text[i] starts a `#`-to-EOL comment: at the very start of the input
// or right after whitespace, a newline, or a command separator (`;`, `&`,
// `|`, `(`). A `#` glued to a word (`foo#bar`, `$#`, `${a#b}`) is data.
export function isCommentStart(text: string, i: number): boolean {
  if (text[i] !== "#") return false;
  if (i === 0) return true;
  const prev = text[i - 1] as string;
  return (
    prev === " " ||
    prev === "\t" ||
    prev === "\r" ||
    prev === "\n" ||
    prev === ";" ||
    prev === "&" ||
    prev === "|" ||
    prev === "("
  );
}

// Parses a heredoc opener (`<<` or `<<-`) starting at `command[i]` (which must
// be the first "<"). Returns the terminating marker text, the exclusive end
// index of the line that opened the heredoc, and whether the opener was `<<-`
// (which strips leading tabs from the closing line) — so the caller can copy
// the opening line verbatim and resume scanning the heredoc body from there.
// Shared by splitChainedCommand and stripCommentLines so both stay in sync on
// what counts as heredoc syntax.
export function parseHeredocOpener(
  command: string,
  i: number,
): { marker: string; lineEnd: number; stripTabs: boolean } | null {
  if (command[i] !== "<" || command[i + 1] !== "<") return null;
  // `<<<` is a here-string, not a heredoc: its word is an inline argument,
  // so there is no marker line to wait for.
  if (command[i + 2] === "<") return null;
  // A `<<` opener cannot start in the middle of a `<` run: when the scan
  // reaches the second `<` of a `<<<` here-string, the character ahead is no
  // longer `<`, so only this backward guard stops it from parsing the
  // here-string word as a heredoc marker and swallowing the rest of the
  // command as body.
  if (command[i - 1] === "<") return null;
  let j = i + 2;
  const stripTabs = command[j] === "-";
  if (stripTabs) j++; // <<- strips leading tabs
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
  // A CRLF opener line leaves a trailing \r on a bare marker word; the
  // terminator line carries the same \r, so drop it here and compare
  // CR-stripped lines at close time.
  if (marker.endsWith("\r")) marker = marker.slice(0, -1);
  // Advance j to the end of the line that opened the heredoc.
  while (j < command.length && command[j] !== "\n") j++;
  return { marker, lineEnd: j, stripTabs };
}

// Whether a completed body line closes a heredoc: an exact match against the
// marker, ignoring one trailing CR from CRLF input and leading tabs only when
// the opener was `<<-`. A space-indented close never terminates a plain `<<`
// heredoc — it stays body, exactly like a real shell.
export function isHeredocTerminator(
  line: string,
  marker: string,
  stripTabs: boolean,
): boolean {
  const noCR = line.endsWith("\r") ? line.slice(0, -1) : line;
  const candidate = stripTabs ? noCR.replace(/^\t+/, "") : noCR;
  return candidate === marker;
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
      if (depth === 0)
        return i === segment.length - 1 ? segment.slice(1, -1) : null;
    }
  }
  return null;
}

// The closest non-space character already scanned into the current segment,
// or undefined at the start of a segment. `&` consults this (not the
// following character) to decide whether it is redirect-bound.
function previousNonSpace(current: string): string | undefined {
  const trimmed = current.trimEnd();
  return trimmed.length > 0 ? trimmed[trimmed.length - 1] : undefined;
}

// `&` is redirect-bound only when the previous non-space character is `>` or
// `<` (fd duplication or close: `2>&1`, `>&2`, `<&-`), or when `&` is
// immediately followed by `>` (combined redirect: `&>file`, `&>>file`).
// Everything else is the background operator — a chain boundary.
function isRedirectAmpersand(
  prev: string | undefined,
  next: string | undefined,
): boolean {
  if (next === ">") return true;
  return prev === ">" || prev === "<";
}
