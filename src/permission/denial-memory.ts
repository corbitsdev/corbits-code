// Stable denial fingerprint for the permission gate's denial memory.
//
// The reactor retries a denied ask-tier call with a fresh tool_call.id; the
// fingerprint must be stable across those retries (same tool + same normalized
// arguments) so the second decide() returns the identical cached reason instead
// of re-evaluating and re-logging. call.id and correlationId never participate.

import type { ToolCall } from "@intx/types/runtime";

import { normalizePathArguments } from "../plugins/path-escape-plugin.js";
import { splitChainedCommand } from "./command.js";
import type { RootsProvider } from "./worktree-roots.js";

const NULL_SEPARATOR = "\0";

// URL paths and queries are case-sensitive (RFC 3986): only the scheme and
// host normalize. The path, query, and fragment keep their case so distinct
// resources fingerprint distinctly.
function normalizeUrl(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  const match = /^(https?:\/\/)([^/?#]*)([\s\S]*)$/i.exec(trimmed);
  if (match === null) return value;
  const scheme = match[1] ?? "";
  const authority = match[2] ?? "";
  const rest = match[3] ?? "";
  // Userinfo (rarely present) is case-sensitive; only the host lowercases.
  const at = authority.lastIndexOf("@");
  const userinfo = at === -1 ? "" : authority.slice(0, at + 1);
  const host = (at === -1 ? authority : authority.slice(at + 1)).toLowerCase();
  return `${scheme.toLowerCase()}${userinfo}${host}${rest}`.replace(/\/+$/, "");
}

function normalizeArguments(
  args: Record<string, unknown>,
  toolName: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (key === "url") {
      out[key] = normalizeUrl(value);
    } else if (toolName === "run_shell" && key === "command") {
      out[key] = typeof value === "string" ? splitChainedCommand(value) : value;
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function stableRequestId(
  call: ToolCall,
  cwd: string = process.cwd(),
  rootsProvider: RootsProvider = () => [],
  trustedPluginRoots?: RootsProvider,
): string {
  const identity = normalizePathArguments(
    call.arguments,
    cwd,
    rootsProvider,
    trustedPluginRoots,
  );
  return (
    call.name +
    NULL_SEPARATOR +
    JSON.stringify(normalizeArguments(identity, call.name))
  );
}

export class DenialMemory {
  private readonly reasons = new Map<string, string>();

  record(stableId: string, reason: string): void {
    if (!this.reasons.has(stableId)) this.reasons.set(stableId, reason);
  }

  isDenied(stableId: string): string | undefined {
    return this.reasons.get(stableId);
  }

  clear(): void {
    this.reasons.clear();
  }
}
