// xAI token session — see the shared factory in ./provider.ts.
import { xaiAuth } from "./provider.js";

export const XaiAuthError = xaiAuth.AuthError;
export type XaiAuthError = InstanceType<typeof XaiAuthError>;

export type { XaiAccess } from "./provider.js";

export const isXaiTokenExpired = xaiAuth.session.isExpired;
export const getValidXaiToken = xaiAuth.session.getValidToken;
export const refreshStagedXaiTokens = xaiAuth.refreshStaged;

// The grok proxy wants the caller's user id in the x-grok-user-id header. The
// access token is a JWT whose `sub` claim is that id; decode it rather than
// threading a separately-stored value through the catalog.
export function xaiUserIdFromAccessToken(access: string): string | undefined {
  const payload = access.split(".")[1];
  if (payload === undefined) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      sub?: unknown;
    };
    return typeof decoded.sub === "string" ? decoded.sub : undefined;
  } catch {
    return undefined;
  }
}
