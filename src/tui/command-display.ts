import { splitChainedCommand } from "../shell/command-segments.js";
import { sliceTailToWidth, sliceToWidth, stringWidth } from "./view/height.js";
// The marker word of a heredoc redirect starting at `i` (pointing at `<<`),
// or null when `<<` is not a heredoc opener (e.g. `<<<` here-string).
function parseHeredocMarker(command: string, i: number): string | null {
  if (command[i] !== "<" || command[i + 1] !== "<" || command[i + 2] === "<") return null;
  let j = i + 2;
  if (command[j] === "-") j++;
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
  return marker.length > 0 ? marker : null;
}

export function groupChainSegmentsForDisplay(command: string): string[] {
  return splitChainedCommand(command);
}

export interface VerbatimLine {
  text: string;
  // True only for a genuine full-line shell comment: never for heredoc body
  // lines or for a line the shell joins onto the previous one via a
  // backslash-newline continuation (where a leading # is executable payload).
  isComment: boolean;
}

// Split an already-control-stripped command into the lines the verbatim block
// renders. A top-level LF is a genuine command separator and becomes a real
// rendered line. A newline inside quotes is the Trojan-Source vector — a
// quoted argument line-breaking itself to imitate a fresh list entry — so it
// stays inline as a visible "↵" marker, as does a bare CR (which the shell
// would not treat as a separator but a terminal would repaint on). CRLF is an
// ordinary line ending and follows the LF rule.
export function verbatimCommandLines(text: string): VerbatimLine[] {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines: VerbatimLine[] = [];
  let current = "";
  let quote: '"' | "'" | "`" | null = null;
  let heredocMarker: string | null = null;
  let heredocPending: string | null = null;
  let continued = false;

  const push = (): void => {
    const isComment = heredocMarker === null && !continued && current.trimStart().startsWith("#");
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
        const done = current.trim() === heredocMarker;
        push();
        if (done) heredocMarker = null;
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
      heredocMarker = heredocPending;
      heredocPending = null;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }

    if (ch === "<" && normalized[i + 1] === "<" && heredocPending === null) {
      const marker = parseHeredocMarker(normalized, i);
      if (marker !== null) heredocPending = marker;
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
  // The segment with each qualifying payload (a heredoc body, or a quoted
  // string spanning multiple lines) replaced by a short "<label, N lines>"
  // placeholder. A segment returned by groupChainSegmentsForDisplay is
  // already boundary-resolved, so any newline still inside it comes from one
  // of these two sources — never a chain boundary — which is what lets the
  // collapsed segment always render as a single line.
  display: string;
  // The full text of each collapsed payload, in placeholder order, shown when
  // the operator expands via Alt+E.
  payloads: CollapsedPayload[];
}

// Picks a short, human label for a collapsed quoted payload by looking at the
// flag token immediately before it (`-m`/`--message`/`-F` read as a commit
// message; anything else is generic "text"). Display-only guesswork — never
// used for classification or matching.
function payloadLabel(segment: string, quoteStart: number): string {
  let k = quoteStart - 1;
  while (k >= 0 && (segment[k] === " " || segment[k] === "=")) k--;
  const end = k + 1;
  while (k >= 0 && segment[k] !== " " && segment[k] !== "=") k--;
  const token = segment.slice(k + 1, end);
  return token === "-m" || token === "--message" || token === "-F" ? "message" : "text";
}

function lineCountSuffix(count: number): string {
  return `${count} line${count === 1 ? "" : "s"}`;
}

// Commands that hand a payload to a shell/interpreter to execute rather than
// consuming it as inert data. A segment naming one of these must never
// collapse — the operator has to be able to read the code they are approving.
// `ssh` is unconditional too: whatever payload follows the host runs on the
// remote end regardless of flags, so there is no safe "no -c present" case.
//
// Interpreters are unconditional for the same reason: they can take code via
// `-c`/`-e`, stdin (`-s` / `-`), a heredoc body, or a pipe from an earlier
// stage — flag-gated detection left those paths free to collapse executable
// bodies. Fail open: any segment that names an interpreter never collapses.
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
// let a trigger word incidentally appearing inside a quoted payload (a commit
// message mentioning "source", a heredoc line mentioning "env") falsely mark
// the segment as code-consuming and suppress collapsing it — this walk skips
// quoted/heredoc spans entirely so only the actual command and its arguments
// are considered. Display-only guesswork (see the file header) — never used
// for classification.
function segmentWords(segment: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: '"' | "'" | "`" | null = null;
  let heredocMarker: string | null = null;
  let heredocPending: string | null = null;

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
        if (segment.slice(i + 1, lineEnd).trim() === heredocMarker) {
          heredocMarker = null;
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

    if (ch === "<" && segment[i + 1] === "<") {
      const marker = parseHeredocMarker(segment, i);
      if (marker !== null) {
        push();
        heredocPending = marker;
        i += 2;
        if (segment[i] === "-") i++;
        while (segment[i] === " " || segment[i] === "\t") i++;
        const markerQuote = segment[i] === "'" || segment[i] === '"' ? segment[i++] : null;
        i += marker.length;
        if (markerQuote !== null && segment[i] === markerQuote) i++;
        continue;
      }
    }

    if (ch === " " || ch === "\t" || ch === "\n") {
      push();
      if (ch === "\n" && heredocPending !== null) {
        heredocMarker = heredocPending;
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

// The POSIX basename of a word naming a program: strips any directory
// prefix, so `/bin/bash`, `./bash`, and `bash` are all recognized as the
// same interpreter. Display-only guesswork, same as the rest of this file.
function programBasename(word: string): string {
  const slash = word.lastIndexOf("/");
  return slash === -1 ? word : word.slice(slash + 1);
}

// True when `segment` names a command that treats a quoted or heredoc payload
// as code — directly (eval, source, xargs, env, ssh) or via an interpreter
// (bash/sh/python/node/…), including one reached through a `$(...)`/backtick
// command substitution, since those words show up as ordinary tokens in the
// segment either way. Interpreter names are matched by basename so a
// path-qualified spelling (`/bin/bash`, `./sh`) is not missed, and wrapper
// prefixes (env, sudo, nohup, timeout, ...) are handled for free because this
// scans every word rather than just the first.
//
function isCodeConsumingSegment(segment: string): boolean {
  const words = segmentWords(segment);
  const bareWord = (word: string): string => word.replace(/^[(`]+/, "").replace(/^\$\(/, "");
  for (const word of words) {
    const bare = programBasename(bareWord(word));
    if (CODE_CONSUMING_COMMANDS.has(bare)) return true;
  }
  return false;
}

// Collapse a heredoc body or a multi-line quoted-string argument within one
// display segment into a placeholder. Never influences classification or
// grant matching — display only, mirroring the header comment for this file.
// A segment that hands its payload to an interpreter as code is never
// collapsed (see isCodeConsumingSegment) — only data-consuming payloads
// (commit messages, file contents piped to tee/cat, echoed text) collapse.
export function collapseSegmentPayloads(segment: string): CollapsedSegment {
  if (isCodeConsumingSegment(segment)) return { display: segment, payloads: [] };
  const payloads: CollapsedPayload[] = [];
  let display = "";
  let i = 0;
  while (i < segment.length) {
    const ch = segment[i] as string;

    if (ch === "<" && segment[i + 1] === "<") {
      const marker = parseHeredocMarker(segment, i);
      if (marker !== null) {
        let j = i;
        while (j < segment.length && segment[j] !== "\n") j++;
        display += segment.slice(i, j);
        i = j + 1;
        const bodyLines: string[] = [];
        while (i < segment.length) {
          let lineEnd = segment.indexOf("\n", i);
          if (lineEnd === -1) lineEnd = segment.length;
          const line = segment.slice(i, lineEnd);
          if (line.trim() === marker) {
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

// Truncate to `max` columns keeping both the head and tail, so a set of
// strings that share a long common prefix (e.g. persistent Allow options that
// differ only in their trailing grant note) stay visually distinguishable
// instead of all clipping at the same point.
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
  // How many payloads were replaced by a placeholder. Zero when nothing was
  // collapsed, which is what tells the caller whether to offer the expand key.
  readonly payloadCount: number;
}

// A payload line is rendered through verbatimCommandLines so a bare CR inside
// it shows as a visible ↵ instead of repainting the row the operator is
// reading — the same Trojan-Source defence the verbatim block applies.
function renderPayloadLine(line: string): string {
  return verbatimCommandLines(line)
    .map((l) => l.text)
    .join(" ");
}

// Render an approval subject for the operator: every chain segment on its own
// numbered line (so a second destructive command can never hide inside a wall
// of text), with heredoc / multi-line quoted payloads collapsed to a
// placeholder. When `expanded`, each placeholder keeps its line and the full
// payload is printed underneath it — the placeholder never disappears, so the
// collapsed and expanded views describe the same command.
//
// A single unchained segment is not numbered: the number exists to expose
// chaining, and prefixing a lone command with "1)" only adds noise.
export function formatCommandForApproval(
  command: string,
  opts?: { readonly expanded?: boolean },
): CommandDisplay {
  const segments = groupChainSegmentsForDisplay(command);
  if (segments.length === 0) return { lines: [command], payloadCount: 0 };

  // The canonical splitter deliberately discards operators, so it cannot tell
  // a pipeline from another chain after splitting. If any connected segment
  // consumes code, fail open for the whole chain rather than hide a payload
  // that may feed that interpreter through a pipe.
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
      for (const line of payload.lines) lines.push(`     ${renderPayloadLine(line)}`);
    }
  });

  return { lines, payloadCount };
}
