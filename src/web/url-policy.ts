import { URL } from "node:url";

// Destinations that must never be reached by web_fetch, even when the model
// constructs the URL. This blocks SSRF against internal services, cloud
// metadata endpoints, and the local filesystem.
const BLOCKED_PROTOCOLS = new Set(["file:", "ftp:", "ftps:", "javascript:"]);

// Cloud metadata endpoints and link-local addresses.
const BLOCKED_HOSTS = new Set([
  "169.254.169.254", // AWS, GCP, Azure metadata
  "metadata.google.internal",
  "metadata.goog",
]);

function isPrivateIPv4(host: string): boolean {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return false;
  }
  const a = parts[0]!;
  const b = parts[1]!;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 127.0.0.0/8 (localhost)
  if (a === 127) return true;
  // 169.254.0.0/16 (link-local)
  if (a === 169 && b === 254) return true;
  // 0.0.0.0/8
  if (a === 0) return true;
  return false;
}

function isBlockedHost(host: string): boolean {
  const lower = host.toLowerCase();
  if (BLOCKED_HOSTS.has(lower)) return true;
  if (lower === "localhost" || lower === "localhost.localdomain") return true;
  if (isPrivateIPv4(lower)) return true;
  // IPv6 loopback and link-local
  if (lower === "::1" || lower === "::" || lower.startsWith("fe80:")) return true;
  return false;
}

export function isBlockedURL(urlString: string): { blocked: true; reason: string } | { blocked: false } {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return { blocked: true, reason: "invalid URL" };
  }

  if (BLOCKED_PROTOCOLS.has(parsed.protocol)) {
    return { blocked: true, reason: `blocked protocol: ${parsed.protocol}` };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { blocked: true, reason: `blocked protocol: ${parsed.protocol}` };
  }

  // URL.hostname strips brackets from IPv6 literals in standard runtimes,
  // but Bun may preserve them. Strip brackets defensively before checking.
  const host = parsed.hostname.replace(/^\[(.*)\]$/, "$1");
  if (isBlockedHost(host)) {
    return { blocked: true, reason: `blocked host: ${host}` };
  }

  // Block username/password in URLs (credential leak vector).
  if (parsed.username || parsed.password) {
    return { blocked: true, reason: "URL contains credentials" };
  }

  return { blocked: false };
}
