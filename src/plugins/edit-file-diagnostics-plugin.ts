import { readFile } from "node:fs/promises";
import type { ToolPlugin } from "@intx/tools-posix";
import type { ToolResult } from "@intx/types/runtime";

// Stock tools-posix messages — match tightly so permission/binary/ENOENT stay untouched.
const NOT_FOUND_RE = /^old_string not found in /;
const NOT_UNIQUE_RE = /^old_string is not unique \(\d+ occurrences\) in /;

const MAX_DIAGNOSTIC_CHARS = 2048;
const MAX_OCCURRENCES_LISTED = 10;
const PREVIEW_CHARS = 120;
const CLOSEST_LINE_COUNT = 3;
// Keep multi-line occurrence previews short enough that 10 of them fit under the cap.
const OCCURRENCE_PREVIEW_LINES = 3;

// read_file decorates as padStart(6) + "\t" + line; pasting that into old_string is the
// dominant failure mode for this ticket.
const LINE_PREFIX_RE = /^\s*\d+\t/;

export function editFileDiagnosticsPlugin(): ToolPlugin {
  return {
    middleware: (next) => async (call, signal) => {
      const result = await next(call, signal);
      if (call.name !== "edit_file" || result.isError !== true) {
        return result;
      }

      const content = String(result.content);
      const notFound = NOT_FOUND_RE.test(content);
      const uniqueMatch = content.match(NOT_UNIQUE_RE);
      if (!notFound && uniqueMatch === null) {
        return result;
      }

      const path = call.arguments.path;
      const oldString = call.arguments.old_string;
      if (typeof path !== "string" || path.length === 0) {
        return result;
      }
      if (typeof oldString !== "string") {
        return result;
      }

      let fileText: string;
      try {
        // path-escape already resolved this to an absolute, sandbox-checked path.
        const buf = await readFile(path, { signal });
        if (buf.includes(0)) {
          return result;
        }
        fileText = buf.toString("utf8");
      } catch {
        return result;
      }

      const diagnostic = notFound
        ? diagnoseNotFound(fileText, oldString)
        : diagnoseNotUnique(fileText, oldString);

      if (diagnostic.length === 0) {
        return result;
      }

      return {
        ...result,
        content: `${content}\n\n${truncateDiagnostic(diagnostic)}`,
      } satisfies ToolResult;
    },
  };
}

function diagnoseNotFound(fileText: string, oldString: string): string {
  const parts: string[] = [];

  const stripped = stripLineNumberPrefixes(oldString);
  if (stripped !== null) {
    parts.push(
      "old_string looks like it includes read_file line-number prefixes (NNNNNN\\t). " +
        "Strip those prefixes before matching. Candidate without prefixes:",
      fence(stripped),
    );
  }

  // Prefer a near-miss on the raw needle; if prefixes contaminated it, retry on stripped.
  const nearMiss =
    findWhitespaceNearMiss(fileText, oldString) ??
    (stripped !== null ? findWhitespaceNearMiss(fileText, stripped) : null);

  if (nearMiss !== null) {
    parts.push(
      "Whitespace near-miss (unique; use this exact text as old_string):",
      fence(nearMiss.text),
      `(lines ${formatLineRange(nearMiss.startLine, nearMiss.endLine)}; whitespace differs from your old_string)`,
    );
    return parts.join("\n");
  }

  if (stripped !== null && fileText.includes(stripped)) {
    parts.push(
      "After stripping line-number prefixes, old_string matches the file exactly. Retry with the stripped text above.",
    );
    return parts.join("\n");
  }

  const closest = closestLines(fileText, oldString);
  if (closest.length > 0) {
    parts.push("No unique whitespace near-miss. Closest lines by token overlap (heuristic):");
    for (const line of closest) {
      parts.push(`line ${line.lineNumber}: ${preview(line.text)}`);
    }
  }

  return parts.join("\n");
}

function diagnoseNotUnique(fileText: string, oldString: string): string {
  const occurrences = findOccurrences(fileText, oldString);
  if (occurrences.length === 0) {
    return "";
  }

  const lines: string[] = [
    `Occurrences (showing ${Math.min(occurrences.length, MAX_OCCURRENCES_LISTED)} of ${occurrences.length}):`,
  ];
  for (const occ of occurrences.slice(0, MAX_OCCURRENCES_LISTED)) {
    lines.push(`line ${occ.lineNumber}: ${preview(occ.preview)}`);
  }
  if (occurrences.length > MAX_OCCURRENCES_LISTED) {
    lines.push(`… and ${occurrences.length - MAX_OCCURRENCES_LISTED} more`);
  }
  lines.push("Widen old_string with surrounding context so it matches exactly once, or pass replace_all=true.");
  return lines.join("\n");
}

/**
 * Per-line whitespace normalize for matching only; reported text is always original.
 * Full trim + internal collapse so indent drift (the dominant failure mode) still
 * near-matches; CR is stripped so CRLF files compare cleanly against LF needles.
 */
export function normalizeLine(line: string): string {
  const noCr = line.replace(/\r/g, "");
  return noCr.trim().replace(/[ \t]+/g, " ");
}

export type NearMiss = {
  text: string;
  startLine: number;
  endLine: number;
};

/**
 * Find a unique multi-line span whose per-line whitespace normalization equals
 * the normalized old_string. Returns original (un-normalized) text.
 *
 * Leading/trailing empty lines on the needle are ignored for matching (models
 * often paste a trailing newline) but do not expand the reported span.
 */
export function findWhitespaceNearMiss(fileText: string, oldString: string): NearMiss | null {
  const needleLines = oldString.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  // Drop only edge blank lines so "foo\n" still matches a mid-file "foo".
  // Mid-needle blanks stay so intentional empty lines still constrain the match.
  const coreNorm = trimEdgeEmptyLines(needleLines.map(normalizeLine));
  if (coreNorm.length === 0 || coreNorm.every((l) => l.length === 0)) {
    return null;
  }

  const fileLines = fileText.split("\n");
  const fileNorm = fileLines.map(normalizeLine);

  const hits: Array<{ start: number; end: number }> = [];
  const window = coreNorm.length;
  for (let i = 0; i <= fileNorm.length - window; i++) {
    let match = true;
    for (let j = 0; j < window; j++) {
      if (fileNorm[i + j] !== coreNorm[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      hits.push({ start: i, end: i + window - 1 });
      if (hits.length > 1) {
        return null;
      }
    }
  }

  if (hits.length !== 1) {
    return null;
  }

  const hit = hits[0]!;
  // Reconstruct original span with "\n" join — matches how edit_file treats content.
  const text = fileLines.slice(hit.start, hit.end + 1).join("\n");

  // Exact identity is not a near-miss (stock tool would have matched).
  if (text === oldString) {
    return null;
  }

  return {
    text,
    startLine: hit.start + 1,
    endLine: hit.end + 1,
  };
}

/** Drop leading/trailing empty strings from a line array (not mid-array blanks). */
export function trimEdgeEmptyLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start] === "") start++;
  while (end > start && lines[end - 1] === "") end--;
  return lines.slice(start, end);
}

export type Occurrence = {
  lineNumber: number;
  preview: string;
};

export function findOccurrences(fileText: string, oldString: string): Occurrence[] {
  if (oldString.length === 0) return [];
  const out: Occurrence[] = [];
  let from = 0;
  while (from <= fileText.length) {
    const idx = fileText.indexOf(oldString, from);
    if (idx === -1) break;
    const lineNumber = lineNumberAt(fileText, idx);
    // Preview the matched span (up to a few lines), not just the start line, so
    // multi-line old_string occurrences can be disambiguated.
    const matched = fileText.slice(idx, idx + oldString.length);
    const previewLines = matched.split("\n").slice(0, OCCURRENCE_PREVIEW_LINES);
    const previewText =
      matched.split("\n").length > OCCURRENCE_PREVIEW_LINES
        ? `${previewLines.join("\\n")}…`
        : previewLines.join("\\n");
    out.push({ lineNumber, preview: previewText });
    from = idx + Math.max(oldString.length, 1);
  }
  return out;
}

function lineNumberAt(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index; i++) {
    if (text.charCodeAt(i) === 10) n++;
  }
  return n;
}

export type ClosestLine = {
  lineNumber: number;
  text: string;
};

export function closestLines(fileText: string, oldString: string): ClosestLine[] {
  const needleTokens = tokenize(oldString);
  if (needleTokens.size === 0) return [];

  const lines = fileText.split("\n");
  const scored: Array<{ lineNumber: number; text: string; score: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i] ?? "";
    const tokens = tokenize(text);
    if (tokens.size === 0) continue;
    let overlap = 0;
    for (const t of needleTokens) {
      if (tokens.has(t)) overlap++;
    }
    if (overlap === 0) continue;
    scored.push({ lineNumber: i + 1, text, score: overlap });
  }

  scored.sort((a, b) => b.score - a.score || a.lineNumber - b.lineNumber);
  return scored.slice(0, CLOSEST_LINE_COUNT).map(({ lineNumber, text }) => ({ lineNumber, text }));
}

function tokenize(text: string): Set<string> {
  const parts = text.match(/[A-Za-z_][A-Za-z0-9_]*|[0-9]+/g);
  return new Set(parts ?? []);
}

/**
 * If every non-empty line of old_string looks like a read_file decoration, return
 * the stripped body. Otherwise null.
 */
export function stripLineNumberPrefixes(oldString: string): string | null {
  const lines = oldString.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines.length === 0) return null;
  let nonEmpty = 0;
  const stripped: string[] = [];
  for (const line of lines) {
    if (line.length === 0) {
      stripped.push("");
      continue;
    }
    nonEmpty++;
    if (!LINE_PREFIX_RE.test(line)) {
      return null;
    }
    stripped.push(line.replace(LINE_PREFIX_RE, ""));
  }
  if (nonEmpty === 0) return null;
  return stripped.join("\n");
}

function preview(text: string): string {
  const flat = text.replace(/\r?\n/g, "\\n");
  if (flat.length <= PREVIEW_CHARS) return flat;
  return `${flat.slice(0, PREVIEW_CHARS - 1)}…`;
}

function formatLineRange(start: number, end: number): string {
  return start === end ? String(start) : `${start}-${end}`;
}

function fence(body: string): string {
  return `<<<\n${body}\n>>>`;
}

/**
 * Prefer intact fences over a mid-body slice. When a near-miss span itself exceeds
 * the budget, drop the body and tell the caller to re-read by line range instead of
 * offering a half-truncated old_string that will fail again.
 */
export function truncateDiagnostic(text: string): string {
  if (text.length <= MAX_DIAGNOSTIC_CHARS) return text;

  // Replace oversized fenced bodies with a pointer, keeping headers and line ranges.
  const withoutBodies = text.replace(
    /<<<\n[\s\S]*?\n>>>/g,
    "<<<\n… [span too large to inline; re-read the cited lines and copy exact text]\n>>>",
  );
  if (withoutBodies.length <= MAX_DIAGNOSTIC_CHARS) {
    return withoutBodies;
  }

  const cut = withoutBodies.slice(0, MAX_DIAGNOSTIC_CHARS);
  const lastNl = cut.lastIndexOf("\n");
  const base = lastNl > 0 ? cut.slice(0, lastNl) : cut;
  return `${base}\n… [diagnostic truncated]`;
}
