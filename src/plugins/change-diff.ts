/**
 * Bounded unified-diff formatting for product-mutation tool results.
 *
 * Surfaces the changed region computed by verify-plugin / delete-file-plugin
 * so a model can see its edit landed without issuing a follow-up read_file.
 * Kept intentionally small: a plain LCS diff over line arrays, with an escape
 * hatch for large files (skip the O(n*m) LCS, report a boundary-only summary)
 * and a hard char cap so a whole-file rewrite never dominates the result.
 */

const MAX_DIFF_CHARS = 4_000;
const MAX_LCS_LINES = 2_000;
const CONTEXT_LINES = 3;

function splitLines(content: string): string[] {
  if (content === "") return [];
  const lines = content.split("\n");
  // Drop a single trailing empty segment from a final newline so line counts
  // match what a reader would call "N lines", not N+1.
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

interface DiffOp {
  kind: "same" | "add" | "del";
  text: string;
}

/** Longest-common-subsequence line diff. Callers must bound input size. */
function lcsDiff(oldLines: string[], newLines: string[]): DiffOp[] {
  const n = oldLines.length;
  const m = newLines.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i];
    const nextRow = dp[i + 1];
    if (row === undefined || nextRow === undefined) {
      throw new Error("lcs dp row missing");
    }
    for (let j = m - 1; j >= 0; j--) {
      const oldLine = oldLines[i];
      const newLine = newLines[j];
      const diag = nextRow[j + 1];
      const down = nextRow[j];
      const right = row[j + 1];
      if (
        oldLine === undefined ||
        newLine === undefined ||
        diag === undefined ||
        down === undefined ||
        right === undefined
      ) {
        throw new Error("lcs dp cell missing");
      }
      row[j] = oldLine === newLine ? diag + 1 : Math.max(down, right);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const oldLine = oldLines[i];
    const newLine = newLines[j];
    if (oldLine === undefined || newLine === undefined) break;
    const nextRow = dp[i + 1];
    const row = dp[i];
    const down = nextRow?.[j];
    const right = row?.[j + 1];
    if (oldLine === newLine) {
      ops.push({ kind: "same", text: oldLine });
      i++;
      j++;
    } else if (down !== undefined && right !== undefined && down >= right) {
      ops.push({ kind: "del", text: oldLine });
      i++;
    } else {
      ops.push({ kind: "add", text: newLine });
      j++;
    }
  }
  while (i < n) {
    const oldLine = oldLines[i];
    if (oldLine === undefined) break;
    ops.push({ kind: "del", text: oldLine });
    i++;
  }
  while (j < m) {
    const newLine = newLines[j];
    if (newLine === undefined) break;
    ops.push({ kind: "add", text: newLine });
    j++;
  }
  return ops;
}

interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  ops: DiffOp[];
}

/** Group diff ops into hunks, collapsing runs of "same" longer than 2*context. */
function toHunks(ops: DiffOp[]): Hunk[] {
  const hunks: Hunk[] = [];
  let oldLine = 1;
  let newLine = 1;
  let cur: Hunk | undefined;
  let sameRun = 0;

  const flush = () => {
    if (cur !== undefined) hunks.push(cur);
    cur = undefined;
  };

  for (let idx = 0; idx < ops.length; idx++) {
    const op = ops[idx];
    if (op === undefined) continue;
    if (op.kind === "same") {
      sameRun++;
      if (cur !== undefined) {
        cur.ops.push(op);
        cur.oldLines++;
        cur.newLines++;
        // Close the hunk once trailing context is satisfied and the run of
        // unchanged lines continues for longer than one context window.
        if (sameRun > CONTEXT_LINES) {
          const trimBy = sameRun - CONTEXT_LINES;
          cur.ops.splice(cur.ops.length - trimBy, trimBy);
          cur.oldLines -= trimBy;
          cur.newLines -= trimBy;
          flush();
        }
      }
      oldLine++;
      newLine++;
      continue;
    }

    sameRun = 0;
    if (cur === undefined) {
      const ctxStart = Math.max(0, idx - CONTEXT_LINES);
      const ctxOps = ops.slice(ctxStart, idx).filter((o) => o.kind === "same");
      cur = {
        oldStart: oldLine - ctxOps.length,
        oldLines: ctxOps.length,
        newStart: newLine - ctxOps.length,
        newLines: ctxOps.length,
        ops: [...ctxOps],
      };
    }
    cur.ops.push(op);
    if (op.kind === "del") {
      cur.oldLines++;
      oldLine++;
    } else {
      cur.newLines++;
      newLine++;
    }
  }
  flush();
  return hunks;
}

// Unified-diff convention: a zero-length side reports the line *before* the
// empty range (one less than where content would start), not that position
// itself — e.g. an insertion at the top of the file is "-0,0", not "-1,0".
function hunkRangeStart(start: number, count: number): number {
  return count === 0 ? Math.max(0, start - 1) : start;
}

function formatHunk(h: Hunk): string {
  const oldStart = hunkRangeStart(h.oldStart, h.oldLines);
  const newStart = hunkRangeStart(h.newStart, h.newLines);
  const lines = [`@@ -${oldStart},${h.oldLines} +${newStart},${h.newLines} @@`];
  for (const op of h.ops) {
    const prefix = op.kind === "same" ? " " : op.kind === "add" ? "+" : "-";
    lines.push(prefix + op.text);
  }
  return lines.join("\n");
}

function truncationNote(sliceLen: number, discarded: number): string {
  return (
    `\n[diff truncated at ${sliceLen.toLocaleString()} chars — ${discarded.toLocaleString()} chars discarded. ` +
    `The write/edit still applied in full; this is only a display cutoff.]`
  );
}

/**
 * Truncates so the FINAL result (slice + note) never exceeds maxChars — the
 * note is reserved before slicing, not appended after. The note's own length
 * depends on the digit counts of sliceLen/discarded, which depend on
 * sliceLen, so shrink sliceLen until the assembled result fits (a handful of
 * iterations at most — the note only grows when a digit-count boundary is
 * crossed) and hard-clamp as a fallback.
 */
function truncate(diff: string, maxChars: number): string {
  if (diff.length <= maxChars) return diff;

  let sliceLen = maxChars;
  for (let i = 0; i < 8; i++) {
    const discarded = diff.length - sliceLen;
    const note = truncationNote(sliceLen, discarded);
    const total = sliceLen + note.length;
    if (total <= maxChars) return diff.slice(0, sliceLen) + note;
    sliceLen -= total - maxChars;
    if (sliceLen < 0) sliceLen = 0;
  }

  // Fallback: guaranteed to fit even if the loop above didn't converge.
  const discarded = diff.length - sliceLen;
  const note = truncationNote(sliceLen, discarded);
  return (diff.slice(0, sliceLen) + note).slice(0, maxChars);
}

/**
 * Bounded unified diff between `before` and `after` file content. Returns
 * undefined when the two are identical (nothing to show).
 */
export function formatChangeDiff(
  path: string,
  before: string,
  after: string,
  maxChars: number = MAX_DIFF_CHARS,
): string | undefined {
  if (before === after) return undefined;

  const oldLines = splitLines(before);
  const newLines = splitLines(after);

  if (oldLines.length > MAX_LCS_LINES || newLines.length > MAX_LCS_LINES) {
    // Large file: skip LCS (O(n*m) is too expensive) and report a bounded
    // summary instead of a full line-by-line diff.
    const header = `--- ${path}\n+++ ${path}\n`;
    const summary =
      `@@ large change: ${oldLines.length} lines -> ${newLines.length} lines @@\n` +
      `[file exceeds ${MAX_LCS_LINES.toLocaleString()} lines; full diff omitted to stay bounded — ` +
      `re-read the file directly if you need exact content]`;
    return truncate(header + summary, maxChars);
  }

  const ops = lcsDiff(oldLines, newLines);
  const hunks = toHunks(ops);
  if (hunks.length === 0) return undefined;

  const body = hunks.map(formatHunk).join("\n");
  const header = `--- ${path}\n+++ ${path}\n`;
  return truncate(header + body, maxChars);
}

export { MAX_DIFF_CHARS };
