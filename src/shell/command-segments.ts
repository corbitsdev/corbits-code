// Split a command into the commands it chains (&& || | ; newline) so each can
// be classified for security; the operator still approves the whole command.
// Quote-aware (operators inside '...', "..." or `...` are arguments); heredoc
// bodies are atomic; a segment that is exactly one `( ... )` group is unwrapped
// and its inner chain split recursively (`(cd a && b)` → `cd a`, `b`). `<<`
// inside `(( ... ))` arithmetic is left-shift, and a top-level `#` starts a
// comment — neither opens a heredoc.
export function splitChainedCommand(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | "`" | null = null;
  let heredocMarker: string | null = null;
  let heredocStripTabs = false;
  let parenDepth = 0;
  let arithDepth = 0;
  let commentToEOL = false;
  // A `#`-to-EOL comment suppresses only the `<<` opener; chain operators
  // after it still split (`# note && rm -rf /` → `rm -rf /`).

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

    // Heredoc body: scan for the terminating marker on its own line; a second
    // `<<` here is payload, never a nested opener.
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

    // Backslash-newline is line continuation: elide both so a trailing `\`
    // never becomes a fragment, let alone an approval subject.
    if (ch === "\\") {
      const after = command[i + 1];
      if (after === "\n" || after === "\r") {
        i += 1;
        if (after === "\r" && command[i + 1] === "\n") i += 1;
        continue;
      }
    }

    // Heredoc redirect: << or <<-. A `<<` inside a `#` comment (e.g.
    // `# example: cat <<EOF`) documents rather than opens.
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
      // heredoc; bare `(` subshells still detect heredocs (`(cat <<EOF ...)`).
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
    // A chain operator after a dangling redirect (`>`, `<`, `>&`, `<&` with
    // no target yet) does not start a new command — the target was separated
    // from its redirect ("cmd 2>& ; 1" = "cmd 2>&1"). Treat the operator as
    // whitespace so the target rejoins its command.
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
    // `&` is redirect-bound only next to `>`/`<` (fd duplication `2>&1`,
    // combined redirect `&>file`). Any other `&` — even `a &b` — is the
    // background operator and splits the chain; otherwise `bun run build 2>&1`
    // fragments into a command and a stray `1` approval.
    if (ch === "&" && isRedirectAmpersand(previousNonSpace(current), next)) {
      current += ch;
      continue;
    }
    // A lone `&` backgrounds the preceding command and starts a new one;
    // otherwise "ls & rm -rf foo" is one segment scoped by the benign head.
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

// Whether text[i] opens arithmetic (`((` / `$((`), where `<<` is left-shift,
// never a heredoc opener. Bare `( ... )` subshells can still hold a heredoc;
// callers only track depth.
export function isArithmeticOpener(text: string, i: number): boolean {
  return text[i] === "(" && text[i + 1] === "(";
}

// Whether text[i] closes one arithmetic-context level (`))`).
export function isArithmeticCloser(text: string, i: number): boolean {
  return text[i] === ")" && text[i + 1] === ")";
}

// Whether text[i] starts a `#`-to-EOL comment: at input start or after
// whitespace, newline, or a separator (`;`, `&`, `|`, `(`). A `#` glued to a
// word (`foo#bar`, `${a#b}`) is data.
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

// Parse a heredoc opener (`<<` / `<<-`) at command[i]: the marker, the
// exclusive end of the opening line, and whether `<<-` strips tabs, so the
// caller copies the line verbatim and resumes scanning the body. Shared with
// stripCommentLines so both agree on heredoc syntax.
export function parseHeredocOpener(
  command: string,
  i: number,
): { marker: string; lineEnd: number; stripTabs: boolean } | null {
  if (command[i] !== "<" || command[i + 1] !== "<") return null;
  // `<<<` is a here-string: its word is an inline argument, no marker line.
  if (command[i + 2] === "<") return null;
  // A `<<` opener cannot start mid-`<` run: at the second `<` of a `<<<` the
  // forward guard passes, so this backward guard stops the here-string word
  // from being parsed as a marker.
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
    // A bare marker is a single word; stop at whitespace so `<<EOF > out.txt`
    // does not fold the redirect into the marker.
    !(markerQuote === null && (command[j] === " " || command[j] === "\t"))
  ) {
    marker += command[j++];
  }
  if (markerQuote !== null && command[j] === markerQuote) j++;
  // A CRLF opener leaves a trailing \r on the marker; the terminator carries
  // the same \r, so drop it and compare CR-stripped lines at close time.
  if (marker.endsWith("\r")) marker = marker.slice(0, -1);
  // Advance j to the end of the line that opened the heredoc.
  while (j < command.length && command[j] !== "\n") j++;
  return { marker, lineEnd: j, stripTabs };
}

// Whether a completed body line closes a heredoc: exact marker match, ignoring
// one trailing CR and (for `<<-`) leading tabs. A space-indented close never
// terminates a plain `<<` heredoc — it stays body.
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
// still awaiting its target: a bare `>`/`<`, or a fd-duplication opener
// `>&`/`<&` awaiting the fd number.
const DANGLING_REDIRECT = /(?:>&|<&|>|<)$/;

function endsWithDanglingRedirect(text: string): boolean {
  return DANGLING_REDIRECT.test(text.trimEnd());
}

// Inner chain of a segment that is exactly one parenthesised group, or null
// (trailing redirects like `(a && b) 2>&1` keep the segment atomic).
// Quote-aware so a `)` inside quotes does not close the group early.
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

// Closest non-space character in the current segment, or undefined at start.
// `&` consults this to decide whether it is redirect-bound.
function previousNonSpace(current: string): string | undefined {
  const trimmed = current.trimEnd();
  return trimmed.length > 0 ? trimmed[trimmed.length - 1] : undefined;
}

// `&` is redirect-bound when preceded by `>`/`<` (fd duplication: `2>&1`,
// `<&-`) or followed by `>` (combined redirect: `&>file`); otherwise it is
// the background operator — a chain boundary.
function isRedirectAmpersand(
  prev: string | undefined,
  next: string | undefined,
): boolean {
  if (next === ">") return true;
  return prev === ">" || prev === "<";
}
