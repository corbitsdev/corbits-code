import { metaDeviceLogin, type MetaOAuthTokens } from "@corbits/meta-provider";

import type { AuthProfile } from "../store.js";
import { saveMetaProfile } from "../../config/oauth-stores.js";
import {
  isPinnedMetaVerificationUri,
  REJECTED_META_VERIFICATION_URI,
} from "./verification-uri.js";

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
  fetchImpl?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  notify?: (event: {
    type: "device_code";
    verificationUri: string;
    userCode: string;
  }) => void;
};

export function startMetaLogin(opts: StartMetaLoginOptions): MetaLoginHandle {
  const controller = new AbortController();
  const abort = (): void => {
    controller.abort();
  };
  // Abort only; the login promise rejects with the message the TUI matches.
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
        if (event.type !== "device_code") return;
        if (!isPinnedMetaVerificationUri(event.verificationUri)) {
          throw new Error(REJECTED_META_VERIFICATION_URI);
        }
        opts.notify?.({
          type: "device_code",
          verificationUri: event.verificationUri,
          userCode: event.userCode,
        });
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
    // Empty: notify carries the device URI; this slot is the open-url box.
    authorizeUrl: "",
    completed,
    cancel: abort,
  };
}
