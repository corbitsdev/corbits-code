import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { evalHttpEnvGet } from "./eval-http-env.js";

// Blocks requests to loopback, private, link-local, and other non-public IP
// ranges before a fetch is issued, and again after every redirect hop (a
// public-looking hostname can still resolve to an internal address, and a
// redirect can retarget to one even when the original did not).

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a >= 224) return true; // multicast/reserved
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === "::1") return true; // loopback
  if (normalized === "::") return true;
  if (normalized.startsWith("fe80:")) return true; // link-local
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // unique local
  if (normalized.startsWith("::ffff:")) {
    // IPv4-mapped IPv6; re-check the embedded v4 address. WHATWG URL
    // parsing renders the tail hex ("::ffff:7f00:1") rather than dotted
    // ("::ffff:127.0.0.1"), so decode either form.
    const mapped = normalized.slice("::ffff:".length);
    if (mapped.includes(".")) {
      if (isIP(mapped) === 4) return isPrivateIPv4(mapped);
    } else {
      const decoded = mappedTailToIPv4(mapped);
      if (decoded !== undefined) return isPrivateIPv4(decoded);
    }
  }
  return false;
}

// Decodes the hex tail of a "::ffff:" mapped address (one or two groups,
// the low 32 bits) back to dotted IPv4. Returns undefined when the tail is
// not plain hex, leaving the caller to fall through.
function mappedTailToIPv4(tail: string): string | undefined {
  const groups = tail.split(":");
  if (groups.length < 1 || groups.length > 2) return undefined;
  if (
    groups.some(
      (g) => g.length === 0 || g.length > 4 || !/^[0-9a-f]+$/.test(g),
    )
  )
    return undefined;
  const hi = groups.length === 2 ? parseInt(groups[0] as string, 16) : 0;
  const lo = parseInt(groups[groups.length - 1] as string, 16);
  return `${(hi >>> 8) & 255}.${hi & 255}.${(lo >>> 8) & 255}.${lo & 255}`;
}

export function isPrivateAddress(ip: string): boolean {
  // URL.hostname keeps IPv6 brackets ("[::1]"), which isIP rejects; strip
  // them so bracketed literals classify directly instead of falling through
  // to the DNS fail-closed path.
  const host =
    ip.length >= 2 && ip.startsWith("[") && ip.endsWith("]")
      ? ip.slice(1, -1)
      : ip;
  const version = isIP(host);
  if (version === 4) return isPrivateIPv4(host);
  if (version === 6) return isPrivateIPv6(host);
  return true; // not a literal IP; caller must resolve first
}

export type SsrfCheckResult = { ok: true } | { ok: false; reason: string };

// Narrow, deliberate exception: the capability eval's hermetic "web-bait" case
// binds a per-run HTTP fixture to 127.0.0.1 (see scripts/eval-capability.ts
// startHTTPFixture) specifically so web_fetch can be exercised without curl.
// The allowed origin is the calling cell's ALS overlay (see eval-http-env.ts),
// falling back to process.env.EVAL_HTTP_URL for tests that set it directly.
// An operator's real session never has it set, so this does not weaken the
// guard for any target the eval harness did not itself stand up. Matched by
// origin (not full URL) so a same-origin redirect within the fixture still
// passes the per-hop re-check.
function isEvalFixtureUrl(rawUrl: string): boolean {
  const allowed = evalHttpEnvGet("EVAL_HTTP_URL");
  if (allowed === undefined || allowed.length === 0) return false;
  try {
    return new URL(rawUrl).origin === new URL(allowed).origin;
  } catch {
    return false;
  }
}

// Resolves the hostname and rejects if any resolved address is private,
// loopback, or link-local. Also rejects non-http(s) schemes at the boundary.
export async function checkUrlForSsrf(
  rawUrl: string,
): Promise<SsrfCheckResult> {
  if (isEvalFixtureUrl(rawUrl)) return { ok: true };
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: `Invalid URL: ${rawUrl}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      reason: `Unsupported protocol "${parsed.protocol}"; only http and https are allowed.`,
    };
  }

  const hostname = parsed.hostname;
  if (hostname === "localhost") {
    return { ok: false, reason: "Requests to localhost are not allowed." };
  }

  // URL.hostname preserves IPv6 brackets ("[::1]"); strip them before isIP
  // so bracketed literals classify as private directly, not via DNS
  // fail-closed. The refusal message keeps the original hostname.
  const literalHost =
    hostname.length >= 2 &&
    hostname.startsWith("[") &&
    hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  const literalVersion = isIP(literalHost);
  if (literalVersion !== 0) {
    if (isPrivateAddress(literalHost)) {
      return {
        ok: false,
        reason: `Requests to private/loopback/link-local address ${hostname} are not allowed.`,
      };
    }
    return { ok: true };
  }

  let addresses: { address: string }[];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch (err) {
    return {
      ok: false,
      reason: `Could not resolve host "${hostname}": ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (addresses.length === 0) {
    return {
      ok: false,
      reason: `Host "${hostname}" resolved to no addresses.`,
    };
  }
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      return {
        ok: false,
        reason: `Host "${hostname}" resolves to private/loopback/link-local address ${address}; refusing.`,
      };
    }
  }
  return { ok: true };
}
