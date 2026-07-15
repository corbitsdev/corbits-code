const TOOL_OUTPUT_URI_PREFIX = "tool-output:";

export function isToolOutputLike(path: string): boolean {
  return path.startsWith(TOOL_OUTPUT_URI_PREFIX);
}

/** Accept common model mistakes (tool-output:/id) and normalize to tool-output:///id. */
export function normalizeToolOutputUri(path: string): string {
  if (!path.startsWith(TOOL_OUTPUT_URI_PREFIX)) return path;
  if (path.startsWith("tool-output:///")) return path;
  const rest = path.slice(TOOL_OUTPUT_URI_PREFIX.length).replace(/^\/+/, "");
  const callId = rest.split(/[/?#]/)[0] ?? "";
  if (callId.length === 0) return path;
  return `tool-output:///${callId}`;
}

/** Normalized tool-output URI with a non-empty callId, or undefined when not applicable. */
export function canonicalToolOutputUri(path: string): string | undefined {
  if (!isToolOutputLike(path)) return undefined;
  const normalized = normalizeToolOutputUri(path);
  if (!normalized.startsWith("tool-output:///")) return undefined;
  const callId = normalized.slice("tool-output:///".length);
  if (callId.length === 0) return undefined;
  return normalized;
}