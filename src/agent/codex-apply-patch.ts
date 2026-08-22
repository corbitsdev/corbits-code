/**
 * Pure parser/applier for Codex `apply_patch` envelopes.
 *
 * Grammar (subset of codex-rs apply-patch):
 *   Patch := "*** Begin Patch" NEWLINE { FileOp } "*** End Patch" [NEWLINE]
 *   FileOp := AddFile | DeleteFile | UpdateFile
 *   AddFile := "*** Add File: " path NEWLINE { "+" line NEWLINE }
 *   DeleteFile := "*** Delete File: " path NEWLINE
 *   UpdateFile := "*** Update File: " path NEWLINE [ "*** Move to: " path NEWLINE ] { Hunk }
 *   Hunk := "@@" [ " " header ] NEWLINE { (" "|"-"|"+") text NEWLINE } [ "*** End of File" NEWLINE ]
 *
 * Stacked `@@` anchors (class → method) are accepted as consecutive header-only
 * hunks that advance the apply cursor before a hunk with +/- lines.
 *
 * No filesystem I/O, no shell, no dependencies — parse + string apply only.
 */

import { isAbsolute } from "node:path";

const BEGIN_PATCH = "*** Begin Patch";
const END_PATCH = "*** End Patch";
const ADD_FILE = "*** Add File: ";
const DELETE_FILE = "*** Delete File: ";
const UPDATE_FILE = "*** Update File: ";
const MOVE_TO = "*** Move to: ";
const END_OF_FILE = "*** End of File";

export type HunkLineKind = " " | "-" | "+";

export type PatchHunkLine = {
  kind: HunkLineKind;
  text: string;
};

export type PatchHunk = {
  /** Optional text after `@@` (class/method anchor). */
  header?: string;
  lines: PatchHunkLine[];
  endOfFile?: boolean;
};

export type PatchAddOp = {
  type: "add";
  path: string;
  /**
   * File body reconstructed from `+` lines. Each `+` line contributes
   * `text + "\n"` (Codex-rs parity), so non-empty adds end with a trailing newline.
   * An Add File with no `+` lines yields `""`.
   */
  content: string;
};

export type PatchDeleteOp = {
  type: "delete";
  path: string;
};

export type PatchUpdateOp = {
  type: "update";
  path: string;
  moveTo?: string;
  hunks: PatchHunk[];
};

export type PatchOp = PatchAddOp | PatchDeleteOp | PatchUpdateOp;

export type ParsedPatch = {
  ops: PatchOp[];
};

export class CodexApplyPatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexApplyPatchError";
  }
}

/** Parse a full `*** Begin Patch` … `*** End Patch` envelope into file ops. */
export function parseCodexApplyPatch(input: string): ParsedPatch {
  const rawLines = splitLines(input);
  if (rawLines.length === 0) {
    throw new CodexApplyPatchError("empty patch: expected '*** Begin Patch'");
  }

  // Tolerate a single trailing blank from a final newline after End Patch.
  let lines = rawLines;
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines = lines.slice(0, -1);
  }

  if (lines[0]?.trim() !== BEGIN_PATCH) {
    throw new CodexApplyPatchError("malformed envelope: first line must be '*** Begin Patch'");
  }
  if (lines[lines.length - 1]?.trim() !== END_PATCH) {
    throw new CodexApplyPatchError("malformed envelope: last line must be '*** End Patch'");
  }

  const body = lines.slice(1, -1);
  const ops: PatchOp[] = [];
  let i = 0;

  while (i < body.length) {
    const line = body[i]!;
    if (line.startsWith(ADD_FILE)) {
      const path = requireRelativePath(line.slice(ADD_FILE.length), "Add File");
      i += 1;
      const contentLines: string[] = [];
      while (i < body.length && body[i]!.startsWith("+")) {
        contentLines.push(body[i]!.slice(1));
        i += 1;
      }
      if (i < body.length && !isFileOpHeader(body[i]!)) {
        throw new CodexApplyPatchError(
          `malformed Add File '${path}': expected '+' content lines or next file op, got: ${body[i]}`,
        );
      }
      // Codex-rs: each '+' line contributes text + "\n".
      const content =
        contentLines.length === 0 ? "" : contentLines.map((l) => `${l}\n`).join("");
      ops.push({ type: "add", path, content });
      continue;
    }

    if (line.startsWith(DELETE_FILE)) {
      const path = requireRelativePath(line.slice(DELETE_FILE.length), "Delete File");
      i += 1;
      ops.push({ type: "delete", path });
      continue;
    }

    if (line.startsWith(UPDATE_FILE)) {
      const path = requireRelativePath(line.slice(UPDATE_FILE.length), "Update File");
      i += 1;
      let moveTo: string | undefined;
      if (i < body.length && body[i]!.startsWith(MOVE_TO)) {
        moveTo = requireRelativePath(body[i]!.slice(MOVE_TO.length), "Move to");
        i += 1;
      }
      const hunks: PatchHunk[] = [];
      while (i < body.length && isHunkStart(body[i]!)) {
        const { hunk, next } = parseHunk(body, i);
        hunks.push(hunk);
        i = next;
      }
      if (i < body.length && !isFileOpHeader(body[i]!)) {
        throw new CodexApplyPatchError(
          `malformed Update File '${path}': expected hunk ('@@') or next file op, got: ${body[i]}`,
        );
      }
      ops.push(moveTo === undefined ? { type: "update", path, hunks } : { type: "update", path, moveTo, hunks });
      continue;
    }

    throw new CodexApplyPatchError(
      `malformed envelope: expected file op header (Add/Delete/Update File), got: ${line}`,
    );
  }

  return { ops };
}

/**
 * Relative paths touched by the patch, in encounter order.
 * Update-with-move contributes both source and destination.
 */
export function extractAffectedPaths(patch: ParsedPatch): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (p: string) => {
    if (seen.has(p)) return;
    seen.add(p);
    out.push(p);
  };
  for (const op of patch.ops) {
    if (op.type === "add" || op.type === "delete") {
      push(op.path);
    } else {
      push(op.path);
      if (op.moveTo !== undefined) push(op.moveTo);
    }
  }
  return out;
}

/**
 * Apply update hunks to an in-memory file body. Returns the updated string.
 * NormalizeToLf-ish: non-empty results end with `\n` (Codex default update mode).
 */
export function applyUpdateHunks(original: string, hunks: PatchHunk[]): string {
  let lines = original === "" ? [] : original.replace(/\n$/, "").split("\n");
  // `split` on a lone "\n" yields [""]; treat that as empty content.
  if (lines.length === 1 && lines[0] === "" && original === "\n") {
    lines = [];
  }

  let cursor = 0;
  for (const hunk of hunks) {
    if (hunk.header !== undefined && hunk.header.length > 0) {
      const idx = findLineFrom(lines, hunk.header, cursor);
      if (idx === -1) {
        throw new CodexApplyPatchError(
          `failed to find hunk context header '${hunk.header}'`,
        );
      }
      cursor = idx + 1;
    }

    const oldLines: string[] = [];
    const newLines: string[] = [];
    for (const hl of hunk.lines) {
      if (hl.kind === " " || hl.kind === "-") oldLines.push(hl.text);
      if (hl.kind === " " || hl.kind === "+") newLines.push(hl.text);
    }

    if (oldLines.length === 0) {
      // Context-only @@ anchor (no +/-): cursor already advanced via header.
      if (newLines.length === 0) continue;
      // Pure insertion (e.g. append). Place at EOF when endOfFile, else at cursor.
      const at = hunk.endOfFile ? lines.length : cursor;
      lines = [...lines.slice(0, at), ...newLines, ...lines.slice(at)];
      cursor = at + newLines.length;
      continue;
    }

    const start = findSequence(lines, oldLines, cursor, hunk.endOfFile === true);
    if (start === -1) {
      throw new CodexApplyPatchError(
        `failed to find expected lines in file:\n${oldLines.join("\n")}`,
      );
    }
    lines = [...lines.slice(0, start), ...newLines, ...lines.slice(start + oldLines.length)];
    cursor = start + newLines.length;
  }

  if (lines.length === 0) {
    // Empty file: preserve empty; a prior lone newline becomes "\n" only when
    // original had content-as-newline — NormalizeToLf leaves truly empty as "".
    return original.length > 0 ? "\n" : "";
  }
  return `${lines.join("\n")}\n`;
}

/** Content for an Add File op (already on the op; helper for call sites). */
export function contentFromAddOp(op: PatchAddOp): string {
  return op.content;
}

function parseHunk(
  body: string[],
  start: number,
): { hunk: PatchHunk; next: number } {
  const headerLine = body[start]!;
  let header: string | undefined;
  if (headerLine === "@@") {
    header = undefined;
  } else if (headerLine.startsWith("@@ ")) {
    header = headerLine.slice(3);
  } else if (headerLine.startsWith("@@")) {
    header = headerLine.slice(2).trimStart();
  } else {
    throw new CodexApplyPatchError(`expected hunk start '@@', got: ${headerLine}`);
  }

  let i = start + 1;
  const lines: PatchHunkLine[] = [];
  while (i < body.length) {
    const raw = body[i]!;
    if (raw === END_OF_FILE) {
      i += 1;
      return {
        hunk: header === undefined
          ? { lines, endOfFile: true }
          : { header, lines, endOfFile: true },
        next: i,
      };
    }
    if (isHunkStart(raw) || isFileOpHeader(raw)) break;
    if (raw.startsWith("***")) {
      throw new CodexApplyPatchError(`unexpected marker inside hunk: ${raw}`);
    }
    const kind = raw[0];
    if (kind !== " " && kind !== "-" && kind !== "+") {
      throw new CodexApplyPatchError(
        `invalid hunk line (must start with ' ', '-', or '+'): ${raw}`,
      );
    }
    lines.push({ kind, text: raw.slice(1) });
    i += 1;
  }

  // Allow header-only hunks so stacked `@@ class` / `@@ method` anchors can
  // precede a hunk that carries the +/- lines (Codex multi-@@ grammar).
  if (lines.length === 0) {
    if (header === undefined || header.length === 0) {
      throw new CodexApplyPatchError(
        "empty hunk: expected at least one ' '/'+'/'-' line after '@@'",
      );
    }
  }

  return {
    hunk: header === undefined ? { lines } : { header, lines },
    next: i,
  };
}

function isFileOpHeader(line: string): boolean {
  return (
    line.startsWith(ADD_FILE) ||
    line.startsWith(DELETE_FILE) ||
    line.startsWith(UPDATE_FILE)
  );
}

function isHunkStart(line: string): boolean {
  return line === "@@" || line.startsWith("@@");
}

function requireRelativePath(raw: string, label: string): string {
  const path = raw.trim();
  if (path.length === 0) {
    throw new CodexApplyPatchError(`${label}: path must be non-empty`);
  }
  if (isAbsolute(path) || isWindowsAbsolute(path)) {
    throw new CodexApplyPatchError(
      `${label}: path must be relative, never absolute (got '${path}')`,
    );
  }
  return path;
}

function isWindowsAbsolute(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

function splitLines(input: string): string[] {
  // Preserve empty trailing segment so callers can detect a final newline.
  return input.split("\n");
}

function findLineFrom(lines: string[], target: string, from: number): number {
  for (let i = from; i < lines.length; i++) {
    if (lines[i] === target) return i;
  }
  // Soften header seek the same way as hunk body matching.
  for (let i = from; i < lines.length; i++) {
    if (lines[i]!.trimEnd() === target.trimEnd()) return i;
  }
  for (let i = from; i < lines.length; i++) {
    if (lines[i]!.trim() === target.trim()) return i;
  }
  return -1;
}

/**
 * Codex seek_sequence subset: exact, then rstrip, then trim.
 * Unicode punctuation normalize is intentionally omitted.
 */
function findSequence(
  lines: string[],
  pattern: string[],
  from: number,
  endOfFile: boolean,
): number {
  if (pattern.length === 0) return from;
  if (pattern.length > lines.length) return -1;

  const searchStart =
    endOfFile && lines.length >= pattern.length
      ? lines.length - pattern.length
      : from;

  const tryFrom = (start: number, eq: (a: string, b: string) => boolean): number => {
    for (let i = start; i <= lines.length - pattern.length; i++) {
      let ok = true;
      for (let j = 0; j < pattern.length; j++) {
        if (!eq(lines[i + j]!, pattern[j]!)) {
          ok = false;
          break;
        }
      }
      if (ok) return i;
    }
    return -1;
  };

  // When eof, try the eof-aligned window first, then fall through from `from`.
  const starts =
    endOfFile && searchStart !== from ? [searchStart, from] : [searchStart];

  for (const start of starts) {
    const exact = tryFrom(start, (a, b) => a === b);
    if (exact !== -1) return exact;
  }
  for (const start of starts) {
    const rstrip = tryFrom(start, (a, b) => a.trimEnd() === b.trimEnd());
    if (rstrip !== -1) return rstrip;
  }
  for (const start of starts) {
    const trimmed = tryFrom(start, (a, b) => a.trim() === b.trim());
    if (trimmed !== -1) return trimmed;
  }
  return -1;
}
