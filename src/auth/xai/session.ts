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

export function isXaiTokenExpired(tokens: XaiTokens, now: number): boolean {
  return now >= tokens.expiresAt - XAI_REFRESH_SKEW_MS;
}

export type XaiAccess = { access: string };

// The grok proxy wants the caller's user id in the x-grok-user-id header. The
// access token is a JWT whose `sub` claim is that id; decode it rather than
// threading a separately-stored value through the catalog.
export function xaiUserIdFromAccessToken(access: string): string | undefined {
  const payload = access.split(".")[1];
  if (payload === undefined) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { sub?: unknown };
    return typeof decoded.sub === "string" ? decoded.sub : undefined;
  } catch {
    return undefined;
  }
}

const inflightRefresh = new Map<string, Promise<XaiAccess>>();

export async function getValidXaiToken(
  name: string,
  now: number = Date.now(),
  home?: string,
): Promise<XaiAccess> {
  const existingProfile = await loadXaiProfile(name, home);
  if (existingProfile === undefined) {
    throw new XaiAuthError(name, "missing", `xAI profile "${name}" is not authorized. Log in again.`);
  }
  if (!isXaiTokenExpired(existingProfile.tokens, now)) {
    return { access: existingProfile.tokens.access };
  }

  const pending = inflightRefresh.get(name);
  if (pending !== undefined) return pending;

  const refreshPromise = doRefresh(name, now, home);
  inflightRefresh.set(name, refreshPromise);
  const cleanup = (): void => {
    if (inflightRefresh.get(name) === refreshPromise) inflightRefresh.delete(name);
  };
  refreshPromise.then(cleanup, cleanup);

  return refreshPromise;
}

async function doRefresh(name: string, now: number, home?: string): Promise<XaiAccess> {
  const profile = await loadXaiProfile(name, home);
  if (profile === undefined) {
    throw new XaiAuthError(name, "missing", `xAI profile "${name}" is not authorized. Log in again.`);
  }
  if (!isXaiTokenExpired(profile.tokens, now)) {
    return { access: profile.tokens.access };
  }
  let refreshed: XaiTokens;
  try {
    refreshed = await refreshTokens(profile.tokens.refresh, now);
  } catch (err) {
    throw new XaiAuthError(
      name,
      "refresh-failed",
      `xAI profile "${name}" could not be refreshed (${err instanceof Error ? err.message : String(err)}). Log in again.`,
    );
  }
  await updateXaiTokens(name, refreshed, home);
  return { access: refreshed.access };
}
