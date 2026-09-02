// Display-only helpers for the chained-command approval modal. These never
// influence classification, grant scopes, or what actually executes — only
// how an already-sanitized command string is grouped and truncated on screen.
// Splitting logic used for approval/classification lives in
// src/permission/command.ts and is intentionally not reused here: this
// grouping is coarser (pipes stay inline) and must never feed back into a
// security decision.

import { sliceTailToWidth, sliceToWidth, stringWidth } from "./view/height.js";
import { projectShellSegments, scanShellStructure } from "../permission/shell-tokenizer.js";

// Mirrors the top-level boundary rules in splitChainedCommand (quote-, paren-,
// heredoc- and continuation-aware; && / || / ; / newline / lone & are chain
// boundaries) but treats a single "|" as part of the current segment instead
// of a boundary, so a pipe stage never shows up as its own meaningless
// numbered item.
export function groupChainSegmentsForDisplay(command: string): string[] {
  return projectShellSegments(command, {
    splitPipes: false,
    coalesceDanglingRedirects: false,
  });
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
  const structure = scanShellStructure(normalized);
  const quoteSpans = structure.spans.filter((span) => span.kind === "quote");
  const continuations = new Set(
    structure.spans.filter((span) => span.kind === "continuation").map((span) => span.end - 1),
  );
  const fullLineComments = structure.spans.filter(
    (span) => span.kind === "comment" && span.fullLine,
  );
  const lines: VerbatimLine[] = [];
  let current = "";
  let lineStart = 0;
  let continued = false;
  let commentIndex = 0;
  let quoteIndex = 0;

  const push = (lineEnd: number): void => {
    while (fullLineComments[commentIndex]?.end !== undefined) {
      const comment = fullLineComments[commentIndex];
      if (comment === undefined || comment.end >= lineStart) break;
      commentIndex++;
    }
    const comment = fullLineComments[commentIndex];
    const isComment =
      !continued && comment !== undefined && comment.start >= lineStart && comment.start <= lineEnd;
    lines.push({ text: current, isComment });
    current = "";
  };

  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i] as string;
    if (ch === "\r") {
      current += "↵";
      continue;
    }
    if (ch !== "\n") {
      current += ch;
      continue;
    }

    while (quoteSpans[quoteIndex]?.end !== undefined) {
      const quote = quoteSpans[quoteIndex];
      if (quote === undefined || quote.end > i) break;
      quoteIndex++;
    }
    const quote = quoteSpans[quoteIndex];
    const quoted = quote !== undefined && quote.start < i && i < quote.end;
    if (quoted) {
      current += "↵";
      continue;
    }

    push(i);
    continued = continuations.has(i);
    lineStart = i + 1;
  }
  push(normalized.length);
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
  const opaqueSpans = scanShellStructure(segment)
    .spans.filter(
      (span) => span.kind === "quote" || span.kind === "comment" || span.kind === "heredoc-body",
    )
    .sort((a, b) => a.start - b.start);
  let current = "";
  let spanIndex = 0;

  const push = (): void => {
    if (current.length > 0) words.push(current);
    current = "";
  };

  let i = 0;
  while (i < segment.length) {
    const opaque = opaqueSpans[spanIndex];
    if (opaque !== undefined && i >= opaque.start) {
      push();
      i = opaque.end;
      spanIndex++;
      continue;
    }

    const ch = segment[i] as string;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") push();
    else current += ch;
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
// Also true when any *other* segment of a pipe/chain is code-consuming: the
// caller checks each segment, and `groupChainSegmentsForDisplay` keeps pipes
// in one display segment, so `cat <<EOF … | bash` is one segment containing
// both `cat` and `bash` and fails closed via the bash word.
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

  const structure = scanShellStructure(segment);
  const heredocReplacements = structure.heredocs
    .filter(
      (
        heredoc,
      ): heredoc is typeof heredoc & {
        terminatorStart: number;
        terminatorEnd: number;
      } => heredoc.terminatorStart !== null && heredoc.terminatorEnd !== null,
    )
    .map((heredoc, index) => {
      const body = segment.slice(heredoc.bodyStart, heredoc.bodyEnd).replace(/(?:\r\n|\n)$/, "");
      const lines = body.length === 0 ? [] : body.split(/\r?\n/);
      const placeholder = `<heredoc, ${lineCountSuffix(lines.length)}>`;
      const firstBodyStart =
        segment.slice(heredoc.bodyStart - 2, heredoc.bodyStart) === "\r\n"
          ? heredoc.bodyStart - 2
          : heredoc.bodyStart - 1;
      let end = heredoc.terminatorEnd;
      if (segment.slice(end, end + 2) === "\r\n") end += 2;
      else if (segment[end] === "\n") end++;
      return {
        start: index === 0 ? firstBodyStart : heredoc.bodyStart,
        end,
        placeholder,
        lines,
      };
    });
  const quoteSpans = structure.spans.filter((span) => span.kind === "quote");
  const payloads: CollapsedPayload[] = [];
  let display = "";
  let heredocIndex = 0;
  let quoteIndex = 0;
  let i = 0;

  while (i < segment.length) {
    const heredoc = heredocReplacements[heredocIndex];
    if (heredoc !== undefined && i === heredoc.start) {
      display += ` ${heredoc.placeholder}`;
      payloads.push({ placeholder: heredoc.placeholder, lines: heredoc.lines });
      heredocIndex++;
      i = heredoc.end;
      continue;
    }

    const quote = quoteSpans[quoteIndex];
    if (quote !== undefined && i === quote.start) {
      const closed = segment[quote.end - 1] === segment[quote.start];
      const contentEnd = closed ? quote.end - 1 : quote.end;
      const content = segment.slice(quote.start + 1, contentEnd);
      if (content.includes("\n")) {
        const lines = content.split(/\r?\n/);
        const placeholder = `<${payloadLabel(segment, i)}, ${lineCountSuffix(lines.length)}>`;
        display += placeholder;
        payloads.push({ placeholder, lines });
      } else {
        display += segment.slice(quote.start, quote.end);
      }
      quoteIndex++;
      i = quote.end;
      continue;
    }

    if (quote !== undefined && quote.start < i) quoteIndex++;
    display += segment[i] as string;
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

  const collapsed = segments.map(collapseSegmentPayloads);
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
