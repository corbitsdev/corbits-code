import { createTokenSession } from "../oauth/session.js";
import { XAI_REFRESH_SKEW_MS } from "./constants.js";
import { refreshTokens } from "./oauth.js";
import { loadXaiProfile, updateXaiTokens, type XaiTokens } from "./store.js";

export class XaiAuthError extends Error {
  readonly profile: string;
  readonly reason: "missing" | "refresh-failed";

  constructor(profile: string, reason: "missing" | "refresh-failed", message: string) {
    super(message);
    this.name = "XaiAuthError";
    this.profile = profile;
    this.reason = reason;
  }
}

export interface XaiAccess {
  access: string;
}

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

const session = createTokenSession<XaiTokens, XaiAccess>({
  skewMs: XAI_REFRESH_SKEW_MS,
  loadProfile: loadXaiProfile,
  updateTokens: updateXaiTokens,
  refreshTokens,
  toAccess: (tokens) => ({ access: tokens.access }),
  missingError: (name) =>
    new XaiAuthError(name, "missing", `xAI profile "${name}" is not authorized. Log in again.`),
  refreshFailedError: (name, err) =>
    new XaiAuthError(
      name,
      "refresh-failed",
      `xAI profile "${name}" could not be refreshed (${err instanceof Error ? err.message : String(err)}). Log in again.`,
    ),
});

export const isXaiTokenExpired = session.isExpired;
export const getValidXaiToken = session.getValidToken;

export async function refreshStagedXaiTokens(
  tokens: XaiTokens,
  now: number = Date.now(),
): Promise<XaiTokens> {
  if (!isXaiTokenExpired(tokens, now)) return tokens;
  const refreshed = await refreshTokens(tokens.refresh, now);
  Object.assign(tokens, refreshed);
  return tokens;
}
