import { readFile, writeFile } from "node:fs/promises";
import { hasCode } from "@intx/types";
import type { ToolDefinition } from "@intx/types/runtime";

export type EditFileSubstringMode = {
  kind: "substring";
  path: string;
  old_string: string;
  new_string: string;
  replace_all: boolean;
};

export type EditFileLineRangeMode = {
  kind: "line_range";
  path: string;
  start_line: number;
  end_line: number;
  new_string: string;
};

export type EditFileModeParse =
  | EditFileSubstringMode
  | EditFileLineRangeMode
  | { kind: "invalid"; message: string };

function optionalInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)
    ? value
    : undefined;
}

function hasOldStringArg(args: Record<string, unknown>): boolean {
  return typeof args.old_string === "string";
}

function hasLineRangeArgs(args: Record<string, unknown>): boolean {
  return optionalInt(args.start_line) !== undefined || optionalInt(args.end_line) !== undefined;
}

const MIXED_MODE_MESSAGE =
  "edit_file: received both old_string and start_line/end_line; only one edit mode is allowed. " +
  "Omit old_string to use line-range mode, or omit start_line/end_line to use substring mode.";

export function parseLineRangeFields(
  path: string,
  new_string: string,
  args: Record<string, unknown>,
): EditFileLineRangeMode | { kind: "invalid"; message: string } {
  const start_line = optionalInt(args.start_line);
  const end_line = optionalInt(args.end_line);
  if (start_line === undefined || end_line === undefined) {
    return {
      kind: "invalid",
      message: "edit_file line-range mode requires both start_line and end_line (1-based inclusive)",
    };
  }
  if (start_line < 1 || end_line < 1) {
    return { kind: "invalid", message: "start_line and end_line must be >= 1" };
  }
  if (start_line > end_line) {
    return { kind: "invalid", message: `start_line (${start_line}) must be <= end_line (${end_line})` };
  }
  return { kind: "line_range", path, start_line, end_line, new_string };
}

/**
 * Decide which exclusive edit_file mode the call uses. Stock substring mode is the
 * default when no line-range fields are present.
 */
export function parseEditFileMode(args: Record<string, unknown>): EditFileModeParse {
  const path = args.path;
  if (typeof path !== "string" || path.length === 0) {
    return { kind: "invalid", message: 'argument "path" is required' };
  }

  const new_string = args.new_string;
  if (typeof new_string !== "string") {
    return { kind: "invalid", message: 'argument "new_string" is required' };
  }

  const substring = hasOldStringArg(args);
  const lineRange = hasLineRangeArgs(args);

  // Reject rather than guess: silently picking a mode when both are supplied previously
  // meant line-range mode won and old_string was asserted against the exact line-range
  // slice, producing a confusing "old_string does not match" error even when the caller
  // meant plain substring mode (CL-4399). One explicit error beats a wrong guess.
  if (substring && lineRange) {
    return { kind: "invalid", message: MIXED_MODE_MESSAGE };
  }

  if (lineRange) {
    return parseLineRangeFields(path, new_string, args);
  }

  if (!substring) {
    return {
      kind: "invalid",
      message:
        'edit_file requires old_string (substring mode) or start_line and end_line (line-range mode)',
    };
  }

  const old_string = String(args.old_string);
  if (old_string.length === 0) {
    return { kind: "invalid", message: "old_string must not be empty" };
  }

  return {
    kind: "substring",
    path,
    old_string,
    new_string,
    replace_all: Boolean(args.replace_all),
  };
}

export type SplitFileLines = {
  lines: string[];
  newline: "\n" | "\r\n";
  /** File ended with a newline before the edit. */
  trailingNewline: boolean;
};

export function splitFileLines(content: string): SplitFileLines {
  const newline: "\n" | "\r\n" = content.includes("\r\n") ? "\r\n" : "\n";
  const trailingNewline =
    content.length > 0 && (newline === "\r\n" ? content.endsWith("\r\n") : content.endsWith("\n"));

  let lines =
    newline === "\r\n"
      ? content.split("\r\n")
      : content.split("\n");

  if (trailingNewline && lines.length > 0 && lines[lines.length - 1] === "") {
    lines = lines.slice(0, -1);
  }

  return { lines, newline, trailingNewline };
}

function splitNewStringLines(newString: string): string[] {
  if (newString.length === 0) return [];
  const normalized = newString.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const parts = normalized.split("\n");
  if (normalized.endsWith("\n") && parts.length > 0 && parts[parts.length - 1] === "") {
    parts.pop();
  }
  return parts;
}

export function joinFileLines(lines: string[], newline: "\n" | "\r\n", trailingNewline: boolean): string {
  if (lines.length === 0) {
    return trailingNewline ? newline : "";
  }
  const body = lines.join(newline);
  return trailingNewline ? body + newline : body;
}

/**
 * Replace inclusive 1-based line range with new_string (may contain \\n). Does not write disk.
 */
export function applyLineRangeEdit(
  content: string,
  startLine: number,
  endLine: number,
  newString: string,
): string {
  const { lines, newline, trailingNewline } = splitFileLines(content);

  if (lines.length === 0) {
    throw new Error("cannot replace lines in an empty file");
  }
  if (startLine > lines.length || endLine > lines.length) {
    throw new Error(
      `line range ${startLine}-${endLine} is out of range (file has ${lines.length} line(s))`,
    );
  }

  const newLines = splitNewStringLines(newString);
  const before = lines.slice(0, startLine - 1);
  const after = lines.slice(endLine);
  const merged = [...before, ...newLines, ...after];

  // When the range includes the last line, the replacement defines EOF; otherwise keep prior trailing newline.
  const rangeTouchesLastLine = endLine === lines.length;
  const keepTrailing = rangeTouchesLastLine
    ? newString.endsWith("\n") || newString.endsWith("\r\n")
    : trailingNewline;

  return joinFileLines(merged, newline, keepTrailing);
}

export function formatLineRangeSuccess(path: string, startLine: number, endLine: number): string {
  if (startLine === endLine) {
    return `replaced line ${startLine} in ${path}`;
  }
  return `replaced lines ${startLine}-${endLine} in ${path}`;
}

export async function runEditFileLineRange(
  args: EditFileLineRangeMode,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();

  let content: string;
  try {
    const buf = await readFile(args.path, { signal });
    if (buf.includes(0)) {
      throw new Error(`refusing to edit binary file: ${args.path}`);
    }
    content = buf.toString("utf8");
  } catch (err) {
    if (hasCode(err)) {
      if (err.code === "ENOENT") {
        throw new Error(`file not found: ${args.path}`, { cause: err });
      }
      if (err.code === "EACCES") {
        throw new Error(`permission denied: ${args.path}`, { cause: err });
      }
      if (err.code === "EISDIR") {
        throw new Error(`path is a directory: ${args.path}`, { cause: err });
      }
    }
    throw err;
  }

  const newContent = applyLineRangeEdit(content, args.start_line, args.end_line, args.new_string);

  signal.throwIfAborted();

  try {
    await writeFile(args.path, newContent, { encoding: "utf8", signal });
  } catch (err) {
    if (hasCode(err)) {
      if (err.code === "EACCES") {
        throw new Error(`permission denied: ${args.path}`, { cause: err });
      }
    }
    throw err;
  }

  return formatLineRangeSuccess(args.path, args.start_line, args.end_line);
}

/**
 * Extend the model-visible edit_file schema with exclusive line-range mode (Intercode-only).
 */
export function advertiseEditFileLineRange(definition: ToolDefinition): ToolDefinition {
  if (definition.name !== "edit_file") return definition;

  const schema = definition.inputSchema;
  const props = schema["properties"];
  if (props === undefined || typeof props !== "object" || props === null) {
    return definition;
  }
  const properties = props as Record<string, unknown>;

  return {
    ...definition,
    description:
      "Make a surgical edit to an existing file. Mode A (substring): path + old_string + new_string " +
      "(exact match; must be unique unless replace_all). Mode B (line range): path + start_line + end_line " +
      "(1-based inclusive) + new_string. The two modes are mutually exclusive: sending both old_string and " +
      "start_line/end_line is rejected with an error; omit old_string for line-range mode, or omit " +
      "start_line/end_line for substring mode. " +
      "On substring mismatch, errors include nearby file context.",
    inputSchema: {
      ...schema,
      properties: {
        ...properties,
        start_line: {
          type: "number",
          description:
            "Line-range mode: first line to replace (1-based, inclusive). Requires end_line. Mutually exclusive " +
            "with old_string; a call sending both is rejected.",
        },
        end_line: {
          type: "number",
          description:
            "Line-range mode: last line to replace (1-based, inclusive). Requires start_line. Mutually exclusive " +
            "with old_string; a call sending both is rejected.",
        },
      },
      required: ["path", "new_string"],
    },
  };
}