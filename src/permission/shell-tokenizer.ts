export type ShellBoundaryKind = "and" | "or" | "pipe" | "semicolon" | "newline" | "background";

export interface ShellBoundary {
  start: number;
  end: number;
  kind: ShellBoundaryKind;
}

export type ShellSpan =
  | { start: number; end: number; kind: "quote" | "continuation" | "heredoc-body" }
  | { start: number; end: number; kind: "comment"; fullLine: boolean };

export interface ShellHeredoc {
  delimiter: string;
  stripTabs: boolean;
  openerStart: number;
  openerEnd: number;
  bodyStart: number;
  bodyEnd: number;
  terminatorStart: number | null;
  terminatorEnd: number | null;
}

export interface ShellStructure {
  boundaries: ShellBoundary[];
  spans: ShellSpan[];
  heredocs: ShellHeredoc[];
}

interface PendingHeredoc {
  delimiter: string;
  stripTabs: boolean;
  openerStart: number;
  openerEnd: number;
}

function lineEndingAt(text: string, index: number): { start: number; end: number } | null {
  const ch = text[index];
  if (ch === "\n") return { start: index, end: index + 1 };
  if (ch === "\r" && text[index + 1] === "\n") return { start: index, end: index + 2 };
  return null;
}

function parseHeredocDelimiter(text: string, start: number): PendingHeredoc | null {
  if (
    text[start] !== "<" ||
    text[start + 1] !== "<" ||
    text[start - 1] === "<" ||
    text[start + 2] === "<"
  ) {
    return null;
  }

  let i = start + 2;
  const stripTabs = text[i] === "-";
  if (stripTabs) i++;
  while (text[i] === " " || text[i] === "\t") i++;

  let delimiter = "";
  let quote: "'" | '"' | null = null;
  while (i < text.length) {
    const ch = text[i] as string;
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
        i++;
        continue;
      }
      if (quote === '"' && ch === "\\" && i + 1 < text.length) {
        delimiter += text[i + 1];
        i += 2;
        continue;
      }
      if (ch === "\n" || ch === "\r") return null;
      delimiter += ch;
      i++;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      i++;
      continue;
    }
    if (ch === "\\" && i + 1 < text.length) {
      const escaped = text[i + 1] as string;
      if (escaped === "\n" || escaped === "\r") return null;
      delimiter += escaped;
      i += 2;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ";&|<>()".includes(ch)) {
      break;
    }
    delimiter += ch;
    i++;
  }

  if (quote !== null || delimiter.length === 0) return null;
  return { delimiter, stripTabs, openerStart: start, openerEnd: i };
}

function heredocLineMatches(line: string, pending: PendingHeredoc): boolean {
  return (pending.stripTabs ? line.replace(/^\t+/, "") : line) === pending.delimiter;
}

function isRedirectAmpersand(next: string | undefined): boolean {
  return !(next === undefined || next === " " || next === "\t" || next === "\r" || next === "\n");
}

/**
 * Performs one bounded lexical scan of shell structure shared by authorization
 * and approval display. It recognizes only structure needed by those consumers;
 * malformed or unsupported syntax is left visible rather than made opaque.
 */
export function scanShellStructure(command: string): ShellStructure {
  const boundaries: ShellBoundary[] = [];
  const spans: ShellSpan[] = [];
  const heredocs: ShellHeredoc[] = [];
  const pendingHeredocs: PendingHeredoc[] = [];
  const parenFrames: ("paren" | "arithmetic")[] = [];
  let logicalLineHasContent = false;
  let wordStart = true;
  let malformedHeredocLine = false;
  let i = 0;

  while (i < command.length) {
    const ch = command[i] as string;

    if (ch === "\\") {
      const ending = lineEndingAt(command, i + 1);
      if (ending !== null) {
        spans.push({ kind: "continuation", start: i, end: ending.end });
        logicalLineHasContent = true;
        wordStart = true;
        i = ending.end;
        continue;
      }
      logicalLineHasContent = true;
      wordStart = false;
      i = Math.min(i + 2, command.length);
      continue;
    }

    if (!malformedHeredocLine && (ch === "'" || ch === '"' || ch === "`")) {
      const start = i;
      const quote = ch;
      i++;
      while (i < command.length) {
        const quoted = command[i] as string;
        if (quote !== "'" && quoted === "\\" && i + 1 < command.length) {
          i += 2;
          continue;
        }
        i++;
        if (quoted === quote) break;
      }
      spans.push({ kind: "quote", start, end: i });
      logicalLineHasContent = true;
      wordStart = false;
      continue;
    }

    if (ch === "#" && wordStart) {
      const start = i;
      while (i < command.length && lineEndingAt(command, i) === null) i++;
      spans.push({ kind: "comment", start, end: i, fullLine: !logicalLineHasContent });
      continue;
    }

    const ending = lineEndingAt(command, i);
    if (ending !== null) {
      if (pendingHeredocs.length > 0) {
        let bodyStart = ending.end;
        let cursor = bodyStart;
        let finalEnding: { start: number; end: number } | null = null;

        for (const pending of pendingHeredocs) {
          let terminatorStart: number | null = null;
          let terminatorEnd: number | null = null;
          let nextBodyStart = command.length;

          while (cursor <= command.length) {
            let lineEnd = cursor;
            while (lineEnd < command.length && lineEndingAt(command, lineEnd) === null) lineEnd++;
            const bodyEnding = lineEndingAt(command, lineEnd);
            const line = command.slice(cursor, lineEnd);
            if (heredocLineMatches(line, pending)) {
              terminatorStart = cursor;
              terminatorEnd = lineEnd;
              finalEnding = bodyEnding;
              nextBodyStart = bodyEnding?.end ?? command.length;
              break;
            }
            if (bodyEnding === null) {
              cursor = command.length + 1;
              break;
            }
            cursor = bodyEnding.end;
          }

          const opaqueEnd = terminatorEnd ?? command.length;
          spans.push({ kind: "heredoc-body", start: bodyStart, end: opaqueEnd });
          heredocs.push({
            ...pending,
            bodyStart,
            bodyEnd: terminatorStart ?? command.length,
            terminatorStart,
            terminatorEnd,
          });
          if (terminatorStart === null) {
            pendingHeredocs.length = 0;
            return { boundaries, spans, heredocs };
          }
          cursor = nextBodyStart;
          bodyStart = nextBodyStart;
        }

        pendingHeredocs.length = 0;
        if (finalEnding !== null) {
          boundaries.push({ ...finalEnding, kind: "newline" });
          i = finalEnding.end;
          logicalLineHasContent = false;
          wordStart = true;
          continue;
        }
        i = command.length;
        continue;
      }

      if (parenFrames.length === 0) boundaries.push({ ...ending, kind: "newline" });
      i = ending.end;
      logicalLineHasContent = false;
      wordStart = true;
      malformedHeredocLine = false;
      continue;
    }

    if (parenFrames.length === 0 && ch === "<" && command[i + 1] === "<") {
      const opener = parseHeredocDelimiter(command, i);
      if (opener !== null) {
        pendingHeredocs.push(opener);
        logicalLineHasContent = true;
        wordStart = false;
        i = opener.openerEnd;
        continue;
      }
      if (command[i - 1] !== "<" && command[i + 2] !== "<") {
        malformedHeredocLine = true;
        i += 2;
        continue;
      }
    }

    if (!malformedHeredocLine && ch === "(" && command[i - 1] === "$" && command[i + 1] === "(") {
      parenFrames.push("arithmetic", "arithmetic");
      logicalLineHasContent = true;
      wordStart = false;
      i += 2;
      continue;
    }
    if (!malformedHeredocLine && ch === "(") {
      parenFrames.push(command[i + 1] === "(" ? "arithmetic" : "paren");
      logicalLineHasContent = true;
      wordStart = true;
      i++;
      continue;
    }
    if (!malformedHeredocLine && ch === ")") {
      parenFrames.pop();
      logicalLineHasContent = true;
      wordStart = false;
      i++;
      continue;
    }

    if (parenFrames.length === 0 && pendingHeredocs.length === 0) {
      const next = command[i + 1];
      let boundary: ShellBoundary | null = null;
      if (ch === "&" && next === "&") boundary = { start: i, end: i + 2, kind: "and" };
      else if (ch === "|" && next === "|") boundary = { start: i, end: i + 2, kind: "or" };
      else if (ch === "|") boundary = { start: i, end: i + 1, kind: "pipe" };
      else if (ch === ";") boundary = { start: i, end: i + 1, kind: "semicolon" };
      else if (ch === "&" && !isRedirectAmpersand(next)) {
        boundary = { start: i, end: i + 1, kind: "background" };
      }
      if (boundary !== null) {
        boundaries.push(boundary);
        logicalLineHasContent = true;
        wordStart = true;
        i = boundary.end;
        continue;
      }
    }

    if (ch === " " || ch === "\t") {
      wordStart = true;
      i++;
      continue;
    }
    logicalLineHasContent = true;
    wordStart = false;
    i++;
  }

  return { boundaries, spans, heredocs };
}

export interface ProjectShellSegmentsOpts {
  splitPipes: boolean;
  coalesceDanglingRedirects: boolean;
}

const DANGLING_REDIRECT = /(?:>&|<&|>|<)$/;

export function projectShellSegments(command: string, opts: ProjectShellSegmentsOpts): string[] {
  const structure = scanShellStructure(command);
  const continuations = structure.spans.filter((span) => span.kind === "continuation");
  const segments: string[] = [];
  let current = "";
  let cursor = 0;
  let continuationIndex = 0;

  const appendRange = (start: number, end: number): void => {
    let rangeCursor = start;
    while (continuations[continuationIndex]?.end !== undefined) {
      const continuation = continuations[continuationIndex];
      if (continuation === undefined || continuation.end > rangeCursor) break;
      continuationIndex++;
    }
    while (continuationIndex < continuations.length) {
      const continuation = continuations[continuationIndex];
      if (continuation === undefined) break;
      if (continuation.start >= end) break;
      current += command.slice(rangeCursor, continuation.start);
      rangeCursor = continuation.end;
      continuationIndex++;
    }
    current += command.slice(rangeCursor, end);
  };
  const push = (): void => {
    const trimmed = current.trim();
    current = "";
    if (trimmed.length > 0) segments.push(trimmed);
  };

  for (const boundary of structure.boundaries) {
    if (boundary.kind === "pipe" && !opts.splitPipes) continue;
    appendRange(cursor, boundary.start);
    cursor = boundary.end;
    if (opts.coalesceDanglingRedirects && DANGLING_REDIRECT.test(current.trimEnd())) {
      current = `${current.trimEnd()} `;
      continue;
    }
    push();
  }
  appendRange(cursor, command.length);
  push();
  return segments;
}
