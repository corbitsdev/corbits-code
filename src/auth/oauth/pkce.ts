import { createHash, randomBytes } from "node:crypto";

// PKCE (RFC 7636) and CSRF state generation for loopback OAuth flows.
// The verifier is a high-entropy random string; the challenge is its SHA-256
// digest, base64url-encoded. The authorization server stores the challenge and
// later verifies the verifier presented at token exchange, which is what stops
// an intercepted authorization code from being redeemed by anyone else.

function base64url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface Pkce {
  verifier: string;
  challenge: string;
  method: "S256";
}

export function generatePkce(): Pkce {
  // 32 random bytes → 43-char base64url string, within the RFC's 43–128 range.
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge, method: "S256" };
}

// Opaque CSRF nonce echoed back on the redirect and checked for an exact match
// before the code is trusted.
export function generateState(): string {
  return base64url(randomBytes(32));
}
