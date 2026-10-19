import type { AuthzCallResult } from "@intx/inference";
import { type } from "arktype";

const PluginAuthorizeResult = type({
  effect: "'allow' | 'ask' | 'deny' | null",
  matchingGrants: "unknown[]",
  resolvedBy: "unknown",
  "reason?": "string",
});

export type PluginAuthorizeResultBoundary =
  | { ok: true; result: AuthzCallResult }
  | { ok: false; kind: "malformed" | "hostile"; diagnostic: string };

export function safePluginDiagnostic(err: unknown): string {
  try {
    const diagnostic: unknown = err instanceof Error ? err.message : err;
    return typeof diagnostic === "string" ? diagnostic : String(diagnostic);
  } catch {
    return "[unprintable thrown value]";
  }
}

export function validatePluginAuthorizeResult(
  rawResult: unknown,
): PluginAuthorizeResultBoundary {
  try {
    const source = rawResult as Record<string, unknown>;
    const effect = source.effect;
    const matchingGrants = source.matchingGrants;
    const resolvedBy = source.resolvedBy;
    const reason = source.reason;
    const result = PluginAuthorizeResult({
      effect,
      matchingGrants,
      resolvedBy,
      ...(reason !== undefined ? { reason } : {}),
    });
    return result instanceof type.errors
      ? { ok: false, kind: "malformed", diagnostic: result.summary }
      : { ok: true, result: result as AuthzCallResult };
  } catch (err) {
    return {
      ok: false,
      kind: "hostile",
      diagnostic: safePluginDiagnostic(err),
    };
  }
}
