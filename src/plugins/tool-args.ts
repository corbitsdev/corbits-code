import type { ToolResult } from "@intx/types/runtime";

/** One error-text rendering: message when an Error, String(err) otherwise. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Scalar tool-argument guards, the yolo early-out, and the deny-result shape
// shared by the tool/plugins stack. Per-tool semantics stay with each caller;
// this only pins the shared vocabulary so the shape cannot drift between
// plugins answering the same way.

/** Finite number argument, else undefined. Non-numbers and NaN/Infinity miss. */
export function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/** Non-empty string argument, else undefined. */
export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Resolve an `allowOutside` option passed as `boolean | (() => boolean)`:
 * yolo is a live flag, so the getter is re-read per call and a mid-session
 * toggle applies without rebuilding the plugin stack.
 */
export function resolveAllowOutside(
  value: boolean | (() => boolean) | undefined,
): boolean {
  if (typeof value === "function") return value();
  return value === true;
}

/** The one deny result shape: swallowed error text in the model's call id. */
export function denyResult(callId: string, message: string): ToolResult {
  return { callId, content: message, isError: true };
}
