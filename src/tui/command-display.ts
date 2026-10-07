import {
  isArithmeticCloser,
  isArithmeticOpener,
  isCommentStart,
  isHeredocTerminator,
  splitChainedCommand,
} from "../shell/command-segments.js";
import { sliceTailToWidth, sliceToWidth, stringWidth } from "./view/height.js";
// Marker word of a heredoc redirect at `i` (on `<<`), or null when `<<` is
// not an opener (e.g. `<<<` here-string). stripTabs is true only for `<<-`,
// which strips leading tabs from the closing line.
function parseHeredocMarker(
  command: string,
  i: number,
): { marker: string; stripTabs: boolean } | null {
  if (command[i] !== "<" || command[i + 1] !== "<" || command[i + 2] === "<")
    return null;
  // Same `<`-run rule as parseHeredocOpener: the second `<` of `<<<` must
  // not parse the here-string word as a marker.
  if (command[i - 1] === "<") return null;
  let j = i + 2;
  const stripTabs = command[j] === "-";
  if (stripTabs) j++;
  while (command[j] === " " || command[j] === "\t") j++;
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
  if (marker.endsWith("\r")) marker = marker.slice(0, -1);
  return marker.length > 0 ? { marker, stripTabs } : null;
}

export function groupChainSegmentsForDisplay(command: string): string[] {
  return splitChainedCommand(command);
}

export interface VerbatimLine {
  text: string;
  // True only for a genuine full-line shell comment: never for heredoc body
  // lines or backslash-newline continuations (where a leading # is
  // executable payload).
  isComment: boolean;
}

// Split an already-control-stripped command into the lines the verbatim block
// renders. A top-level LF is a real command separator and becomes a rendered
// line. A newline inside quotes is the Trojan-Source vector — a quoted
// argument line-breaking to imitate a fresh list entry — so it stays inline
// as a visible "↵" marker, as does a bare CR (the shell would not treat it
// as a separator, but a terminal would repaint on it). CRLF is an ordinary
// line ending and follows the LF rule.
export function verbatimCommandLines(text: string): VerbatimLine[] {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines: VerbatimLine[] = [];
  let current = "";
  let quote: '"' | "'" | "`" | null = null;
  let heredocMarker: string | null = null;
  let heredocStripTabs = false;
  let heredocPending: { marker: string; stripTabs: boolean } | null = null;
  let continued = false;
  // Arithmetic depth (`((` / `$((`): `<<` inside is the shift operator and
  // `#`-to-EOL comments never open a heredoc — mirrors the splitter.
  let arithDepth = 0;

  const push = (): void => {
    const isComment =
      heredocMarker === null &&
      !continued &&
      current.trimStart().startsWith("#");
    lines.push({ text: current, isComment });
    current = "";
    continued = false;
  };

  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i] as string;

    if (ch === "\r") {
      current += "↵";
      continue;
    }

    if (heredocMarker !== null) {
      if (ch === "\n") {
        const done = isHeredocTerminator(
          current,
          heredocMarker,
          heredocStripTabs,
        );
        push();
        if (done) {
          heredocMarker = null;
          heredocStripTabs = false;
        }
        continue;
      }
      current += ch;
      continue;
    }

    if (quote !== null) {
      if (ch === "\n") {
        current += "↵";
        continue;
      }
      if (ch === quote) quote = null;
      current += ch;
      continue;
    }

    if (ch === "\\" && normalized[i + 1] === "\n") {
      current += "\\";
      push();
      continued = true;
      i++;
      continue;
    }

    if (ch === "\n") {
      push();
      heredocMarker = heredocPending?.marker ?? null;
      heredocStripTabs = heredocPending?.stripTabs ?? false;
      heredocPending = null;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }

    if (isArithmeticOpener(normalized, i)) arithDepth++;
    else if (isArithmeticCloser(normalized, i) && arithDepth > 0) arithDepth--;

    // A top-level `#` comment runs to end of line: `<<` inside it documents
    // rather than opens. The line still renders whole (see push's isComment).
    if (arithDepth === 0 && isCommentStart(normalized, i)) {
      let j = i;
      while (j < normalized.length && normalized[j] !== "\n") j++;
      current += normalized.slice(i, j);
      i = j - 1;
      continue;
    }

    if (
      arithDepth === 0 &&
      ch === "<" &&
      normalized[i + 1] === "<" &&
      heredocPending === null
    ) {
      const opener = parseHeredocMarker(normalized, i);
      if (opener !== null) heredocPending = opener;
    }
    current += ch;
  }
  push();
  return lines.filter((line, i) => line.text.trim().length > 0 || i === 0);
}

export interface CollapsedPayload {
  placeholder: string;
  lines: string[];
}

export interface CollapsedSegment {
  // The segment with each qualifying payload (heredoc body, or multi-line
  // quoted string) replaced by a short "<label, N lines>" placeholder. Any
  // newline left in a boundary-resolved segment comes from one of these two
  // sources — never a chain boundary — so the collapsed segment always
  // renders as one line.
  display: string;
  // The full text of each collapsed payload, in placeholder order, shown when
  // the operator expands via Alt+E.
  payloads: CollapsedPayload[];
}

// Picks a short label for a collapsed quoted payload from the flag token
// immediately before it (`-m`/`--message`/`-F` read as a commit message;
// anything else is "text"). Display-only guesswork — never used for
// classification or matching.
function payloadLabel(segment: string, quoteStart: number): string {
  let k = quoteStart - 1;
  while (k >= 0 && (segment[k] === " " || segment[k] === "=")) k--;
  const end = k + 1;
  while (k >= 0 && segment[k] !== " " && segment[k] !== "=") k--;
  const token = segment.slice(k + 1, end);
  return token === "-m" || token === "--message" || token === "-F"
    ? "message"
    : "text";
}

function lineCountSuffix(count: number): string {
  return `${count} line${count === 1 ? "" : "s"}`;
}

// Commands that hand a payload to a shell/interpreter to execute rather than
// consuming it as inert data — a segment naming one must never collapse: the
// operator has to read the code they approve. `ssh` is unconditional too
// (whatever follows the host runs remotely).
//
// Interpreters can take code via `-c`/`-e`, stdin, a heredoc body, or a
// pipe, so flag-gated detection would leave those paths free to collapse
// executable bodies — fail open: any segment naming an interpreter never
// collapses.
const CODE_CONSUMING_COMMANDS = new Set([
  "eval",
  "source",
  ".",
  "xargs",
  "env",
  "ssh",
  "bash",
  "sh",
  "zsh",
  "dash",
  "ash",
  "busybox",
  "python",
  "python3",
  "node",
  "bun",
  "bunx",
  "deno",
  "ruby",
  "perl",
  "php",
  "osascript",
]);

// Command-position words only: the program name and its flags, never text
// inside a quoted argument or heredoc body. A naive whitespace split would
// let a trigger word inside a quoted payload (a commit message mentioning
// "source") falsely mark the segment as code-consuming — this walk skips
// quoted/heredoc spans entirely. Display-only guesswork — never used for
// classification.
function segmentWords(segment: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: '"' | "'" | "`" | null = null;
  let heredocMarker: string | null = null;
  let heredocStripTabs = false;
  let heredocPending: { marker: string; stripTabs: boolean } | null = null;
  // Arithmetic depth (`((` / `$((`): `<<` inside shifts, never opens —
  // mirrors the splitter (keyed on arithmetic, NOT on bare parens).
  let arithDepth = 0;

  const push = (): void => {
    if (current.length > 0) words.push(current);
    current = "";
  };

  let i = 0;
  while (i < segment.length) {
    const ch = segment[i] as string;

    if (heredocMarker !== null) {
      if (ch === "\n") {
        let lineEnd = segment.indexOf("\n", i + 1);
        if (lineEnd === -1) lineEnd = segment.length;
        if (
          isHeredocTerminator(
            segment.slice(i + 1, lineEnd),
            heredocMarker,
            heredocStripTabs,
          )
        ) {
          heredocMarker = null;
          heredocStripTabs = false;
          i = lineEnd;
        }
      }
      i++;
      continue;
    }

    if (quote !== null) {
      if (ch === quote) quote = null;
      i++;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      push();
      quote = ch;
      i++;
      continue;
    }

    if (isArithmeticOpener(segment, i)) arithDepth++;
    else if (isArithmeticCloser(segment, i) && arithDepth > 0) arithDepth--;

    if (arithDepth === 0 && ch === "<" && segment[i + 1] === "<") {
      const opener = parseHeredocMarker(segment, i);
      if (opener !== null) {
        push();
        heredocPending = opener;
        const marker = opener.marker;
        i += 2;
        if (segment[i] === "-") i++;
        while (segment[i] === " " || segment[i] === "\t") i++;
        const markerQuote =
          segment[i] === "'" || segment[i] === '"' ? segment[i++] : null;
        i += marker.length;
        if (markerQuote !== null && segment[i] === markerQuote) i++;
        // The parser strips a CRLF trailing \r from the marker; skip it here
        // too so it does not leak into the word stream.
        if (segment[i] === "\r") i++;
        continue;
      }
    }

    if (ch === " " || ch === "\t" || ch === "\n") {
      push();
      if (ch === "\n" && heredocPending !== null) {
        heredocMarker = heredocPending.marker;
        heredocStripTabs = heredocPending.stripTabs;
        heredocPending = null;
      }
      i++;
      continue;
    }

    current += ch;
    i++;
  }
  push();
  return words;
}

// POSIX basename of a word naming a program: strips any directory prefix, so
// `/bin/bash`, `./bash`, and `bash` are all the same interpreter. Display-only
// guesswork, same as the rest of this file.
function programBasename(word: string): string {
  const slash = word.lastIndexOf("/");
  return slash === -1 ? word : word.slice(slash + 1);
}

// True when `segment` names a command that treats a quoted or heredoc payload
// as code — directly (eval, source, xargs, env, ssh) or via an interpreter
// (bash/sh/python/node/…), including one reached through `$(...)`/backtick
// substitution (those words appear as ordinary tokens). Interpreter names
// match by basename so a path-qualified spelling (`/bin/bash`, `./sh`) is not
// missed; wrapper prefixes (env, sudo, nohup, timeout, ...) are handled for
// free because every word is scanned, not just the first.
function isCodeConsumingSegment(segment: string): boolean {
  const words = segmentWords(segment);
  const bareWord = (word: string): string =>
    word.replace(/^[(`]+/, "").replace(/^\$\(/, "");
  for (const word of words) {
    const bare = programBasename(bareWord(word));
    if (CODE_CONSUMING_COMMANDS.has(bare)) return true;
  }
  return false;
}

// Collapse a heredoc body or multi-line quoted-string argument within one
// display segment into a placeholder. Display only — never influences
// classification or grant matching. A segment handing its payload to an
// interpreter as code never collapses (see isCodeConsumingSegment); only
// data-consuming payloads (commit messages, file contents piped to tee/cat,
// echoed text) do.
export function collapseSegmentPayloads(segment: string): CollapsedSegment {
  if (isCodeConsumingSegment(segment))
    return { display: segment, payloads: [] };
  const payloads: CollapsedPayload[] = [];
  let display = "";
  let i = 0;
  while (i < segment.length) {
    const ch = segment[i] as string;

    if (ch === "<" && segment[i + 1] === "<") {
      const opener = parseHeredocMarker(segment, i);
      if (opener !== null) {
        let j = i;
        while (j < segment.length && segment[j] !== "\n") j++;
        display += segment.slice(i, j);
        i = j + 1;
        const bodyLines: string[] = [];
        while (i < segment.length) {
          let lineEnd = segment.indexOf("\n", i);
          if (lineEnd === -1) lineEnd = segment.length;
          const line = segment.slice(i, lineEnd);
          if (isHeredocTerminator(line, opener.marker, opener.stripTabs)) {
            i = lineEnd + 1;
            break;
          }
          bodyLines.push(line);
          i = lineEnd + 1;
        }
        const placeholder = `<heredoc, ${lineCountSuffix(bodyLines.length)}>`;
        display += ` ${placeholder}`;
        payloads.push({ placeholder, lines: bodyLines });
        continue;
      }
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      let j = i + 1;
      while (j < segment.length && segment[j] !== quote) j++;
      const content = segment.slice(i + 1, j);
      if (content.includes("\n")) {
        const lines = content.split("\n");
        const placeholder = `<${payloadLabel(segment, i)}, ${lineCountSuffix(lines.length)}>`;
        display += placeholder;
        payloads.push({ placeholder, lines });
        i = j < segment.length ? j + 1 : j;
        continue;
      }
      display += segment.slice(i, j < segment.length ? j + 1 : j);
      i = j < segment.length ? j + 1 : j;
      continue;
    }

    display += ch;
    i++;
  }
  return { display, payloads };
}

// Truncate to `max` columns keeping both head and tail, so strings sharing a
// long common prefix (e.g. persistent Allow options differing only in their
// trailing grant note) stay distinguishable instead of clipping at the same
// point.
export function middleEllipsis(text: string, max: number): string {
  if (stringWidth(text) <= max) return text;
  if (max <= 1) return sliceToWidth(text, max);
  // The ellipsis is itself a column that has to come out of the budget.
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  return `${sliceToWidth(text, head)}…${sliceTailToWidth(text, keep - head)}`;
}

export interface CommandDisplay {
  readonly lines: readonly string[];
  // Payloads replaced by a placeholder. Zero means nothing collapsed — what
  // tells the caller whether to offer the expand key.
  readonly payloadCount: number;
}

// Render a payload line through verbatimCommandLines so a bare CR shows as a
// visible ↵ instead of repainting the row being read — the same Trojan-Source
// defence the verbatim block applies.
function renderPayloadLine(line: string): string {
  return verbatimCommandLines(line)
    .map((l) => l.text)
    .join(" ");
}

// Render an approval subject: every chain segment on its own numbered line
// (so a second destructive command cannot hide inside a wall of text), with
// heredoc / multi-line quoted payloads collapsed to a placeholder. When
// `expanded`, each placeholder keeps its line and the full payload prints
// underneath — the two views describe the same command. A single unchained
// segment is not numbered: the number exists to expose chaining, and "1)" on
// a lone command is only noise.
export function formatCommandForApproval(
  command: string,
  opts?: { readonly expanded?: boolean },
): CommandDisplay {
  const segments = groupChainSegmentsForDisplay(command);
  if (segments.length === 0) return { lines: [command], payloadCount: 0 };

  // The canonical splitter discards operators, so it cannot tell a pipeline
  // from another chain after splitting. If any connected segment consumes
  // code, fail open for the whole chain rather than hide a payload that may
  // feed that interpreter through a pipe.
  const chainConsumesCode = segments.some(isCodeConsumingSegment);
  const collapsed = chainConsumesCode
    ? segments.map((segment) => ({ display: segment, payloads: [] }))
    : segments.map(collapseSegmentPayloads);
  const chained = segments.length > 1;
  const lines: string[] = [];
  let payloadCount = 0;

  collapsed.forEach((segment, i) => {
    payloadCount += segment.payloads.length;
    lines.push(chained ? `${i + 1}) ${segment.display}` : segment.display);
    if (opts?.expanded !== true) return;
    for (const payload of segment.payloads) {
      lines.push(`   ${payload.placeholder}`);
      for (const line of payload.lines)
        lines.push(`     ${renderPayloadLine(line)}`);
    }
  });

  return { lines, payloadCount };
}
