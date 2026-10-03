import { metaDeviceLogin, type MetaOAuthTokens } from "@corbits/meta-provider";

import type { AuthProfile } from "../store.js";
import { saveMetaProfile } from "../../config/oauth-stores.js";

// Meta's device flow is a direct RFC 8628 exchange: there is no PKCE loopback
// server and no authorization-code round trip. `startMetaLogin` adapts the
// self-contained `metaDeviceLogin` into the TUI's `OAuthLoginHandle` shape so
// the sign-in step can wait on a single promise.
export type MetaLoginHandle = {
  authorizeUrl: string;
  completed: Promise<{
    profile: AuthProfile<MetaOAuthTokens>;
    commit: () => Promise<void>;
  }>;
  cancel: () => void;
};

export type StartMetaLoginOptions = {
  profile: string;
  signal: AbortSignal;
  home?: string;
  /** Injectable fetch for tests (device authorize / token poll / mint). */
  fetchImpl?: typeof fetch;
  /** Injectable sleep so tests skip real wall-clock waits. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Injectable clock for expiry math. */
  now?: () => number;
  /** Called with the device-code event so the TUI can surface verificationUri + userCode. */
  notify?: (event: {
    type: "device_code";
    verificationUri: string;
    userCode: string;
  }) => void;
};

/**
 * Runs Meta's device login. `metaDeviceLogin` owns the authorize → poll →
 * mint sequence; `notify` surfaces the verification URI + user code so the
 * caller can print them for the operator (Meta has no loopback callback).
 * The returned handle resolves with the minted tokens once the flow
 * completes, and `cancel` aborts the in-flight request.
 */
export function startMetaLogin(opts: StartMetaLoginOptions): MetaLoginHandle {
  const controller = new AbortController();
  const abort = (): void => {
    controller.abort();
  };
  // The TUI's cancel is a soft abandon: it lets the underlying login reject
  // with the cancel message (the same shape the caller matches on).
  opts.signal.addEventListener("abort", abort, { once: true });

  let committed: Promise<void> | undefined;
  const completed = (async (): Promise<{
    profile: AuthProfile<MetaOAuthTokens>;
    commit: () => Promise<void>;
  }> => {
    const tokens = await metaDeviceLogin(controller.signal, {
      ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
      ...(opts.sleep !== undefined ? { sleep: opts.sleep } : {}),
      ...(opts.now !== undefined ? { now: opts.now } : {}),
      notify: (event) => {
        if (event.type === "device_code") {
          opts.notify?.({
            type: "device_code",
            verificationUri: event.verificationUri,
            userCode: event.userCode,
          });
        }
      },
    });
    const profile: AuthProfile<MetaOAuthTokens> = {
      name: opts.profile,
      tokens,
      createdAt: opts.now?.() ?? Date.now(),
    };
    return {
      profile,
      commit: () => {
        if (committed !== undefined) return committed;
        const attempt = saveMetaProfile(profile, opts.home);
        committed = attempt;
        attempt.then(
          () => undefined,
          () => {
            if (committed === attempt) committed = undefined;
          },
        );
        return attempt;
      },
    };
  })();

  return {
    // The verification URI is surfaced via `notify` (device flow); the
    // authorizeUrl slot is unused for Meta, but the TUI reads it for the
    // "open this url" login box. Keep it empty — the device code box shows
    // the real instructions instead.
    authorizeUrl: "",
    completed,
    cancel: abort,
  };
}
