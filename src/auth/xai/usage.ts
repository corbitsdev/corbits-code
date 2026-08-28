import {
  XAI_BILLING_URL,
  XAI_CLIENT_IDENTIFIER,
  XAI_CLIENT_VERSION,
  XAI_TOKEN_TIMEOUT_MS,
  XAI_USER_AGENT,
} from "./constants.js";
import { getValidXaiToken, xaiUserIdFromAccessToken } from "./session.js";

// Live usage/quota for a Grok prepaid plan. Fetched from the CLI chat proxy
// (which accepts our OAuth token) and mirrors the shape returned by
// grok.com billing endpoints used by the official CLI.

export interface XaiUsage {
  subscriptionTier: string;
  // 0-100 percent of the credit allowance consumed in the current period.
  creditUsagePercent: number;
  monthlyLimit?: number;
  includedUsed?: number;
  totalUsed?: number;
  onDemandUsed?: number;
  onDemandCap?: number;
}

function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

function parseXaiUsage(payload: unknown): XaiUsage {
  let p = (typeof payload === "object" && payload !== null ? payload : {}) as Record<
    string,
    unknown
  >;
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

export function xaiAuthHeadersForToken(token: { readonly access: string }): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token.access}`,
    "user-agent": XAI_USER_AGENT,
    "x-grok-client-identifier": XAI_CLIENT_IDENTIFIER,
    "x-grok-client-version": XAI_CLIENT_VERSION,
  };
  const userId = xaiUserIdFromAccessToken(token.access);
  if (userId !== undefined) headers["x-grok-user-id"] = userId;
  return headers;
}

export async function xaiAuthHeaders(profileName: string): Promise<Record<string, string>> {
  return xaiAuthHeadersForToken(await getValidXaiToken(profileName));
}

// Fetch the live usage/quota snapshot for an xAI/Grok profile.
// On network/HTTP error (common for local grok proxies or unauthenticated),
// returns a neutral "unknown" record so the UI can still render a placeholder
// instead of leaving the usage area blank.
// If baseURL is supplied (and differs from the official), billing is resolved
// relative to it so local grok-compatible proxies can serve usage.
export async function fetchXaiUsage(profileName: string, baseURL?: string): Promise<XaiUsage> {
  const billingURL = baseURL ? `${baseURL.replace(/\/$/, "")}/billing` : XAI_BILLING_URL;
  // Bound the billing fetch: it runs on profile switch and modal open, neither
  // of which sits behind the inference timers, so an unresponsive proxy must
  // abort rather than hang the UI.
  try {
    const res = await fetch(billingURL, {
      headers: await xaiAuthHeaders(profileName),
      signal: AbortSignal.timeout(XAI_TOKEN_TIMEOUT_MS),
    });
    if (!res.ok) {
      return {
        subscriptionTier: "unknown",
        creditUsagePercent: 0,
      };
    }
    return parseXaiUsage(await res.json());
  } catch {
    return {
      subscriptionTier: "unknown",
      creditUsagePercent: 0,
    };
  }
}

// Render a multi-line usage summary (for the agent modal).
export function formatXaiUsage(usage: XaiUsage): string {
  const lines: string[] = [`Grok (${usage.subscriptionTier})`];
  lines.push(`credit: ${String(Math.round(usage.creditUsagePercent))}% used`);
  if (
    usage.includedUsed !== undefined &&
    usage.monthlyLimit !== undefined &&
    usage.monthlyLimit > 0
  ) {
    lines.push(`monthly: ${String(usage.includedUsed)}/${String(usage.monthlyLimit)}`);
  }
  if (
    usage.onDemandUsed !== undefined &&
    usage.onDemandCap !== undefined &&
    usage.onDemandCap > 0
  ) {
    lines.push(`on-demand: ${String(usage.onDemandUsed)}/${String(usage.onDemandCap)}`);
  }
  return lines.join("\n");
}

// Compact one-line form for the header (replaces the dollar cost for xAI
// profiles): "Grok pro 23%".
export function formatXaiUsageCompact(usage: XaiUsage): string {
  const tier =
    usage.subscriptionTier && usage.subscriptionTier !== "unknown"
      ? `Grok ${usage.subscriptionTier}`
      : "Grok";
  return `${tier} ${String(Math.round(usage.creditUsagePercent))}%`;
}
