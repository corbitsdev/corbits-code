import { OPENCODE_GO_BASE_URL, OPENCODE_GO_USAGE_PATH } from "./constants.js";

export type GoUsageWindow = {
  usageDollars?: number;
  limitDollars?: number;
  usagePercent?: number;
  resetInSec?: number;
};

export type GoUsage = {
  rolling5h?: GoUsageWindow;
  weekly?: GoUsageWindow;
  monthly?: GoUsageWindow;
  /** Raw status when the endpoint is missing or auth fails. */
  status: "ok" | "unavailable" | "unauthorized" | "error";
  message?: string;
};

/** Minimal fetch shape so tests can inject stubs without matching full DOM fetch. */
export type GoFetch = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<Response>;

function asWindow(value: unknown): GoUsageWindow | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const o = value as Record<string, unknown>;
  const out: GoUsageWindow = {};
  if (typeof o["usageDollars"] === "number") out.usageDollars = o["usageDollars"];
  if (typeof o["limitDollars"] === "number") out.limitDollars = o["limitDollars"];
  if (typeof o["usagePercent"] === "number") out.usagePercent = o["usagePercent"];
  if (typeof o["resetInSec"] === "number") out.resetInSec = o["resetInSec"];
  return out;
}

/**
 * Best-effort Go subscription usage fetch.
 * Upstream usage API may be absent (404) — callers must degrade cleanly.
 */
export async function fetchGoUsage(
  apiKey: string,
  opts?: { fetchImpl?: GoFetch; signal?: AbortSignal },
): Promise<GoUsage> {
  const fetchImpl: GoFetch =
    opts?.fetchImpl ??
    ((input, init) => globalThis.fetch(input, init as RequestInit));
  const url = `${OPENCODE_GO_BASE_URL}${OPENCODE_GO_USAGE_PATH}`;
  try {
    const init: {
      method: string;
      headers: Record<string, string>;
      signal?: AbortSignal;
    } = {
      method: "GET",
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: "application/json",
      },
    };
    if (opts?.signal !== undefined) {
      init.signal = opts.signal;
    }
    const res = await fetchImpl(url, init);
    if (res.status === 401 || res.status === 403) {
      return { status: "unauthorized", message: `usage HTTP ${String(res.status)}` };
    }
    if (res.status === 404) {
      return { status: "unavailable", message: "usage endpoint not available" };
    }
    if (!res.ok) {
      return { status: "error", message: `usage HTTP ${String(res.status)}` };
    }
    const body: unknown = await res.json();
    if (body === null || typeof body !== "object") {
      return { status: "error", message: "usage response was not an object" };
    }
    const o = body as Record<string, unknown>;
    const result: GoUsage = { status: "ok" };
    const rolling5h = asWindow(o["rolling5h"]);
    const weekly = asWindow(o["weekly"]);
    const monthly = asWindow(o["monthly"]);
    if (rolling5h !== undefined) result.rolling5h = rolling5h;
    if (weekly !== undefined) result.weekly = weekly;
    if (monthly !== undefined) result.monthly = monthly;
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: "error", message };
  }
}

export function formatGoUsage(usage: GoUsage): string {
  if (usage.status !== "ok") {
    if (usage.status === "unavailable") return "Go usage unavailable";
    if (usage.status === "unauthorized") return "Go usage: auth failed";
    return usage.message !== undefined ? `Go usage: ${usage.message}` : "Go usage error";
  }
  const w = usage.rolling5h ?? usage.weekly ?? usage.monthly;
  if (w === undefined) return "Go usage ok";
  const pct =
    w.usagePercent !== undefined
      ? `${Math.round(w.usagePercent)}%`
      : w.usageDollars !== undefined && w.limitDollars !== undefined
        ? `$${w.usageDollars.toFixed(2)}/$${w.limitDollars.toFixed(0)}`
        : "ok";
  const window = usage.rolling5h !== undefined ? "5h" : usage.weekly !== undefined ? "week" : "month";
  return `Go ${window} ${pct}`;
}
