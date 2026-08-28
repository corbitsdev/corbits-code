import {
  CODEX_BASE_URL,
  CODEX_CLIENT_VERSION,
  CODEX_MODELS_PATH,
  CODEX_USAGE_PATH,
  CODEX_AUTHORIZE_EXTRA_PARAMS,
} from "./constants.js";
import { getValidCodexToken } from "./session.js";
import { COMMAND_NAME } from "../../branding.js";

// Live usage/quota for a prepaid Codex plan. Since the subscription is not
// billed per token, dollar cost is meaningless — what matters is how much of
// each rolling window has been consumed and when it resets. Mirrors the shape
// of GET /codex/usage.

export interface CodexWindow {
  usedPercent: number;
  windowSeconds: number;
  resetAfterSeconds: number;
  resetAt: number;
}

export interface CodexUsage {
  planType: string;
  // false when the account is currently over its limit / out of credits.
  allowed: boolean;
  limitReached: boolean;
  // The short (e.g. 5-hour) window; the long (e.g. weekly) window.
  primary?: CodexWindow;
  secondary?: CodexWindow;
  hasCredits: boolean;
  // e.g. "workspace_member_credits_depleted" when limit-reached.
  reachedType?: string;
}

function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

function parseWindow(value: unknown): CodexWindow | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const w = value as Record<string, unknown>;
  return {
    usedPercent: num(w["used_percent"]),
    windowSeconds: num(w["limit_window_seconds"]),
    resetAfterSeconds: num(w["reset_after_seconds"]),
    resetAt: num(w["reset_at"]),
  };
}

function parseUsage(payload: unknown): CodexUsage {
  const p = (typeof payload === "object" && payload !== null ? payload : {}) as Record<
    string,
    unknown
  >;
  const rl = (
    typeof p["rate_limit"] === "object" && p["rate_limit"] !== null ? p["rate_limit"] : {}
  ) as Record<string, unknown>;
  const credits = (
    typeof p["credits"] === "object" && p["credits"] !== null ? p["credits"] : {}
  ) as Record<string, unknown>;
  const reached = p["rate_limit_reached_type"] as Record<string, unknown> | undefined;
  const primary = parseWindow(rl["primary_window"]);
  const secondary = parseWindow(rl["secondary_window"]);
  return {
    planType: typeof p["plan_type"] === "string" ? (p["plan_type"] as string) : "unknown",
    allowed: rl["allowed"] !== false,
    limitReached: rl["limit_reached"] === true,
    ...(primary !== undefined ? { primary } : {}),
    ...(secondary !== undefined ? { secondary } : {}),
    hasCredits: credits["has_credits"] === true || credits["unlimited"] === true,
    ...(typeof reached?.["type"] === "string" ? { reachedType: reached["type"] as string } : {}),
  };
}

export function codexAuthHeadersForToken(token: {
  readonly access: string;
  readonly accountId?: string | undefined;
}): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token.access}`,
    originator: CODEX_AUTHORIZE_EXTRA_PARAMS["originator"] ?? "codex_cli_rs",
    "user-agent": `${COMMAND_NAME} (codex_cli_rs/${CODEX_CLIENT_VERSION})`,
  };
  if (token.accountId !== undefined) headers["chatgpt-account-id"] = token.accountId;
  return headers;
}

export async function codexAuthHeaders(profileName: string): Promise<Record<string, string>> {
  return codexAuthHeadersForToken(await getValidCodexToken(profileName));
}

// Fetch the live usage/quota snapshot for a Codex profile.
export async function fetchCodexUsage(profileName: string): Promise<CodexUsage> {
  const res = await fetch(`${CODEX_BASE_URL}${CODEX_USAGE_PATH}`, {
    headers: await codexAuthHeaders(profileName),
  });
  if (!res.ok) {
    throw new Error(`Codex usage request failed (HTTP ${String(res.status)}).`);
  }
  return parseUsage(await res.json());
}

// Fetch the account's available Codex model ids. Returns an empty array when the
// account has no models available (e.g. while rate-limited), in which case the
// caller falls back to the default list.
export async function fetchCodexModels(profileName: string): Promise<string[]> {
  const url = `${CODEX_BASE_URL}${CODEX_MODELS_PATH}?client_version=${encodeURIComponent(CODEX_CLIENT_VERSION)}`;
  const res = await fetch(url, { headers: await codexAuthHeaders(profileName) });
  if (!res.ok) return [];
  const payload = (await res.json()) as unknown;
  const models = (payload as { models?: unknown })?.models;
  if (!Array.isArray(models)) return [];
  return models
    .map((m) =>
      typeof m === "string"
        ? m
        : typeof (m as { slug?: unknown })?.slug === "string"
          ? (m as { slug: string }).slug
          : undefined,
    )
    .filter((s): s is string => s !== undefined);
}

// Render a compact, dollar-free usage summary for the prepaid plan.
export function formatCodexUsage(usage: CodexUsage): string {
  const lines: string[] = [
    `Codex (${usage.planType}) — ${usage.allowed ? "active" : "limit reached"}`,
  ];
  const windowLine = (label: string, w: CodexWindow | undefined): string | undefined => {
    if (w === undefined) return undefined;
    return `${label}: ${String(Math.round(w.usedPercent))}% used · resets in ${formatDuration(w.resetAfterSeconds)}`;
  };
  const primary = windowLine("5-hour", usage.primary);
  const weekly = windowLine("weekly", usage.secondary);
  if (primary !== undefined) lines.push(primary);
  if (weekly !== undefined) lines.push(weekly);
  if (!usage.allowed && usage.reachedType !== undefined) {
    lines.push(`blocked: ${usage.reachedType.replace(/_/g, " ")}`);
  }
  return lines.join("\n");
}

// Label a rate-limit window from its actual duration so the status bar stays
// correct if the backend changes window lengths. Falls back to the supplied
// default when the duration is missing (older header sets omit it).
function windowLabel(windowSeconds: number, fallback: string): string {
  if (windowSeconds <= 0) return fallback;
  const hours = windowSeconds / 3600;
  if (hours < 24) return `${String(Math.round(hours))}h`;
  const days = hours / 24;
  if (days === 7) return "wk";
  return `${String(Math.round(days))}d`;
}

// Compact one-line form for the status bar (replaces the dollar cost for Codex
// profiles): "Codex 5h 100% · wk 74%".
export function formatCodexUsageCompact(usage: CodexUsage): string {
  const parts: string[] = ["Codex"];
  if (usage.primary !== undefined) {
    parts.push(
      `${windowLabel(usage.primary.windowSeconds, "5h")} ${String(Math.round(usage.primary.usedPercent))}%`,
    );
  }
  if (usage.secondary !== undefined) {
    parts.push(
      `${windowLabel(usage.secondary.windowSeconds, "wk")} ${String(Math.round(usage.secondary.usedPercent))}%`,
    );
  }
  if (!usage.allowed) parts.push("(limit reached)");
  return parts.length === 1 ? "Codex" : `${parts[0]} ${parts.slice(1).join(" · ")}`;
}

function formatDuration(seconds: number): string {
  if (seconds <= 0) return "now";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h >= 24) return `${String(Math.floor(h / 24))}d ${String(h % 24)}h`;
  if (h > 0) return `${String(h)}h ${String(m)}m`;
  return `${String(m)}m`;
}
