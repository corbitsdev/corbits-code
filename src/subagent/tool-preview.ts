/**
 * One-line previews of what a live tool call is doing — the subject of a lane
 * row, not a serialisation of its arguments.
 *
 * Operators watching a fleet need to tell six shell commands apart;
 * the bare tool name cannot. Previews are bounded, single-line, and secret-
 * scrubbed so the agents strip never becomes a new leak path for credentials
 * that happen to sit in a command string.
 */

import { scrubSecrets } from "../web/secret-scrub.js";
import { isProductMutationTool, productMutationPaths } from "../agent/product-mutation-tools.js";

/** Hard cap so a long command cannot shove the row's other columns off-screen. */
export const TOOL_PREVIEW_MAX = 48;

/**
 * Subject of a running tool call for lane/chrome paint, or null when the args
 * have nothing meaningful to show — the surface then falls back to the tool name.
 */
export function toolCallPreview(name: string, rawArgs: string): string | null {
  const extracted = extractSubject(name, rawArgs);
  if (extracted === null) return null;
  const scrubbed = scrubSecrets(extracted);
  const oneLine = scrubbed.replace(/\s+/g, " ").trim();
  if (oneLine.length === 0) return null;
  if (oneLine.length <= TOOL_PREVIEW_MAX) return oneLine;
  return `${oneLine.slice(0, TOOL_PREVIEW_MAX - 1)}…`;
}

function extractSubject(name: string, rawArgs: string): string | null {
  if (rawArgs.length === 0) return null;
  const args = parseObject(rawArgs);
  if (args === null) {
    // Incomplete JSON streams through here mid-delta. Do not surface the raw
    // fragment as a subject — wait for a parseable object.
    const trimmed = rawArgs.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) return null;
    // Non-JSON payload — only useful when short enough to be the whole subject.
    const oneLine = trimmed.replace(/\s+/g, " ");
    return oneLine.length > 0 && oneLine.length <= TOOL_PREVIEW_MAX ? oneLine : null;
  }

  const tool = name.toLowerCase();

  // Shell: the command is the whole story. Old surface replaced the tool name
  // with it entirely; we produce the same subject here.
  if (
    tool === "run_shell" ||
    tool === "shell" ||
    tool === "bash" ||
    tool.endsWith("__run_shell") ||
    tool.endsWith("__shell")
  ) {
    return stringField(args, "command") ?? stringField(args, "cmd");
  }

  if (
    tool === "read_file" ||
    isProductMutationTool(tool) ||
    tool.endsWith("__read_file") ||
    tool.endsWith("__write_file") ||
    tool.endsWith("__edit_file")
  ) {
    if (tool === "apply_patch") {
      const paths = productMutationPaths(tool, args);
      return paths[0] ?? null;
    }
    return stringField(args, "path") ?? stringField(args, "file_path");
  }

  if (tool === "grep" || tool.endsWith("__grep")) {
    return stringField(args, "pattern") ?? stringField(args, "query");
  }

  if (tool === "search_files" || tool.endsWith("__search_files")) {
    return stringField(args, "pattern") ?? stringField(args, "glob");
  }

  if (tool === "web_search" || tool === "web_fetch") {
    return stringField(args, "query") ?? stringField(args, "url");
  }

  if (tool === "spawn_agent") {
    return stringField(args, "description") ?? stringField(args, "prompt");
  }

  // Generic fallback: first short scalar among common subject keys.
  for (const key of ["path", "command", "query", "pattern", "url", "description", "prompt"]) {
    const value = stringField(args, key);
    if (value !== null) return value;
  }
  return null;
}

function parseObject(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function stringField(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
