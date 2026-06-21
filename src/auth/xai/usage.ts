import {
  XAI_BILLING_URL,
  XAI_USER_AGENT,
} from "./constants.js";
import { getValidXaiToken } from "./session.js";

// Live usage/quota for a Grok prepaid plan. Fetched from the CLI chat proxy
// (which accepts our OAuth token) and mirrors the shape returned by
// grok.com billing endpoints used by the official CLI.

export type XaiUsage = {
  subscriptionTier: string;
  // 0-100 percent of the credit allowance consumed in the current period.
  creditUsagePercent: number;
  monthlyLimit?: number;
  includedUsed?: number;
  totalUsed?: number;
  onDemandUsed?: number;
  onDemandCap?: number;
};

function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

function parseXaiUsage(payload: unknown): XaiUsage {
  let p = (typeof payload === "object" && payload !== null ? payload : {}) as Record<string, unknown>;
  // Some clients return { config: { ... } } — unwrap for the real fields.
  if (p["config"] && typeof p["config"] === "object") {
    p = p["config"] as Record<string, unknown>;
  }
  const tier =
    typeof p["subscription_tier"] === "string"
      ? (p["subscription_tier"] as string)
      : typeof p["subscriptionTier"] === "string"
        ? (p["subscriptionTier"] as string)
        : "unknown";
  const pctRaw =
    p["creditUsagePercent"] ??
    p["credit_usage_percent"] ??
    p["creditUsage"] ??
    p["percent"] ??
    p["credit_usage"] ??
    0;
  return {
    subscriptionTier: tier,
    creditUsagePercent: num(pctRaw),
    monthlyLimit: num(p["monthlyLimit"] ?? p["monthly_limit"]),
    includedUsed: num(p["includedUsed"] ?? p["included_used"]),
    totalUsed: num(p["totalUsed"] ?? p["total_used"]),
    onDemandUsed: num(p["onDemandUsed"] ?? p["on_demand_used"]),
    onDemandCap: num(p["onDemandCap"] ?? p["on_demand_cap"]),
  };
}

async function xaiAuthHeaders(profileName: string): Promise<Record<string, string>> {
  const { access } = await getValidXaiToken(profileName);
  return {
    authorization: `Bearer ${access}`,
    "user-agent": XAI_USER_AGENT,
  };
}

// Fetch the live usage/quota snapshot for an xAI/Grok profile.
export async function fetchXaiUsage(profileName: string): Promise<XaiUsage> {
  const res = await fetch(XAI_BILLING_URL, {
    headers: await xaiAuthHeaders(profileName),
  });
  if (!res.ok) {
    throw new Error(`xAI usage request failed (HTTP ${String(res.status)}).`);
  }
  return parseXaiUsage(await res.json());
}

// Render a multi-line usage summary (for the agent modal).
export function formatXaiUsage(usage: XaiUsage): string {
  const lines: string[] = [`Grok (${usage.subscriptionTier})`];
  lines.push(`credit: ${String(Math.round(usage.creditUsagePercent))}% used`);
  if (usage.includedUsed !== undefined && usage.monthlyLimit !== undefined && usage.monthlyLimit > 0) {
    lines.push(`monthly: ${String(usage.includedUsed)}/${String(usage.monthlyLimit)}`);
  }
  if (usage.onDemandUsed !== undefined && usage.onDemandCap !== undefined && usage.onDemandCap > 0) {
    lines.push(`on-demand: ${String(usage.onDemandUsed)}/${String(usage.onDemandCap)}`);
  }
  return lines.join("\n");
}

// Compact one-line form for the header (replaces the dollar cost for xAI
// profiles): "Grok pro 23%".
export function formatXaiUsageCompact(usage: XaiUsage): string {
  const tier = usage.subscriptionTier && usage.subscriptionTier !== "unknown" ? `Grok ${usage.subscriptionTier}` : "Grok";
  return `${tier} ${String(Math.round(usage.creditUsagePercent))}%`;
}

// Parse the (future?) rate-limit headers the backend might return on responses.
// Currently a no-op stub; usage is populated via fetchXaiUsage.
export function parseXaiRateLimitHeaders(headers: Headers): XaiUsage | undefined {
  const pct = headers.get("x-grok-credit-used-percent") ?? headers.get("x-grok-usage-percent");
  if (pct === null) return undefined;
  return {
    subscriptionTier: "grok",
    creditUsagePercent: Number(pct) || 0,
  };
}

// Latest usage observed from fetch (or headers). Updated on profile switch and
// modal open so the header can render without waiting for a stream.
let latestUsage: XaiUsage | undefined;
export function recordXaiUsage(usage: XaiUsage): void {
  latestUsage = usage;
}
export function getLatestXaiUsage(): XaiUsage | undefined {
  return latestUsage;
}
