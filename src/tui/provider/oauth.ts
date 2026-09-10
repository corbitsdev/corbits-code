/**
 * OAuth profile slugs, login guidance, and the browser sign-in flow the
 * subscription step runs — plus the multi-instance account-name step shared by
 * OAuth accounts and API-key instances.
 */

import {
  instanceSlugsForKind,
  OAUTH_SURFACES,
  resolveApiKeyInstanceName,
} from "./choices.js";
import { OAUTH_PROFILE_HINT } from "./form.js";
import { RAMP_TICK_MS, stopRamp } from "./surface.js";
import type {
  AccountNameFlow,
  LoginFlow,
  OAuthKind,
  OAuthLoginStart,
  OAuthResult,
  SetupFlowHooks,
  SetupSelectors,
  SetupState,
  Surface,
} from "./types.js";

/** Settings/catalog provider name a profile of `kind` is stored under. */
export function oauthProviderName(kind: OAuthKind, profile: string): string {
  return OAUTH_SURFACES[kind].providerName(profile);
}

/** Longest slug the name step accepts, after normalization. */
const OAUTH_PROFILE_MAX_LENGTH = 64;

const OAUTH_PROFILE_CHARS = /^[a-z0-9._-]+$/;
const OAUTH_PROFILE_EDGE_SEPARATOR = /^[._-]|[._-]$/;

export type OAuthProfileValidation =
  | { readonly ok: true; readonly slug: string }
  | { readonly ok: false; readonly error: string };

/**
 * Validate and lowercase-normalize an operator-entered account slug. This is
 * the constraint owner for the slug shape — the auth store and the catalog
 * projection (`oauthProviderName`) trust whatever they are handed, since a
 * "/" here would silently join into the compound catalog name they build.
 */
export function validateOAuthProfileSlug(raw: string): OAuthProfileValidation {
  const slug = raw.trim().toLowerCase();
  if (slug.length === 0) return { ok: false, error: "name cannot be empty" };
  if (slug.length > OAUTH_PROFILE_MAX_LENGTH) {
    return {
      ok: false,
      error: `name must be ${String(OAUTH_PROFILE_MAX_LENGTH)} characters or fewer`,
    };
  }
  if (!OAUTH_PROFILE_CHARS.test(slug)) {
    return {
      ok: false,
      error: "use only lowercase letters, numbers, and . _ -",
    };
  }
  if (OAUTH_PROFILE_EDGE_SEPARATOR.test(slug)) {
    return { ok: false, error: "name cannot start or end with . _ or -" };
  }
  return { ok: true, slug };
}

/**
 * A slug that does not collide with `existing`, so a first sign-in can
 * default to something usable without asking the operator to invent a name.
 * "default" first, then "default-2", "default-3", … on collision.
 */
export function suggestOAuthProfileSlug(existing: readonly string[]): string {
  const taken = new Set(existing);
  if (!taken.has("default")) return "default";
  let n = 2;
  while (taken.has(`default-${String(n)}`)) n += 1;
  return `default-${String(n)}`;
}

/**
 * Real lister, imported lazily per kind so mounting the surface never touches
 * the auth-store files in a test that injects its own lister.
 */
export const defaultProfileLister = async (
  kind: OAuthKind,
): Promise<readonly string[]> => {
  if (kind === "codex") {
    const { listCodexProfiles } = await import("../../config/oauth-stores.js");
    return (await listCodexProfiles()).map((p) => p.name);
  }
  const { listXaiProfiles } = await import("../../config/oauth-stores.js");
  return (await listXaiProfiles()).map((p) => p.name);
};

/** How long a sign-in may wait on the browser before it gives the screen back. */
export const LOGIN_TIMEOUT_MS = 3 * 60 * 1000;

export const LOGIN_TIMEOUT_MESSAGE = "sign-in timed out";

/** Set when the operator escapes a sign-in that was still outstanding. */
export const LOGIN_CANCELLED_MESSAGE = "sign-in cancelled";

/** What the operator should do about a sign-in that did not complete. */
export function loginGuidance(): string {
  return "enter to try signing in again · esc to pick a different provider";
}

/** What the operator should do after abandoning a sign-in. */
export function loginCancelGuidance(): string {
  return "nothing was saved — pick a provider to start over";
}

/** Status line while the browser round-trip is outstanding. */
export const LOGIN_WAITING_LABEL = "waiting for browser sign-in";

/**
 * Real login: PKCE plus a loopback callback server, per provider. Imported
 * lazily so mounting the surface never binds a port in a test that has
 * injected its own starter.
 */
export const defaultLoginStarter = async ({
  kind,
  profile,
  signal,
}: {
  readonly kind: OAuthKind;
  readonly profile: string;
  readonly signal: AbortSignal;
}) => {
  const { productCallbackCopy } = await import("../../branding.js");
  if (kind === "codex") {
    const { startCodexLogin } = await import("../../auth/codex/login.js");
    return startCodexLogin({ profile, signal, copy: productCallbackCopy });
  }
  const { startXaiLogin } = await import("../../auth/xai/login.js");
  return startXaiLogin({ profile, signal, copy: productCallbackCopy });
};

/**
 * Browser sign-in state machine for the `login` step: arms the deadline before
 * starting the flow, ignores late resolutions from superseded attempts, and
 * hands the screen back on denial, transport failure, or timeout.
 */
export function createLoginFlow(
  state: SetupState,
  surface: Surface,
  selectors: SetupSelectors,
  hooks: SetupFlowHooks,
): LoginFlow {
  const clearLoginTimer = (): void => {
    if (state.loginTimer === null) return;
    clearTimeout(state.loginTimer);
    state.loginTimer = null;
  };

  /**
   * Drop whatever attempt is in flight: stop its deadline, close its callback
   * server, and bump the attempt counter so a late resolution is ignored.
   */
  const abandonLogin = (): void => {
    state.loginAttempt += 1;
    clearLoginTimer();
    state.loginAbort?.abort();
    state.loginAbort = null;
    state.loginHandle?.cancel();
    state.loginHandle = null;
  };

  /** Denial, transport failure, or the deadline — all land the operator here. */
  const failLogin = (attempt: number, message: string): void => {
    if (attempt !== state.loginAttempt) return;
    abandonLogin();
    stopRamp(state);
    state.loginStatus = "failed";
    state.loginError = message;
    state.loginURL = null;
    surface.paint();
  };

  const finishLogin = (
    attempt: number,
    kind: OAuthKind,
    staged: Awaited<OAuthLoginStart["completed"]>,
  ): void => {
    if (attempt !== state.loginAttempt) return;
    clearLoginTimer();
    state.loginHandle = null;
    state.loginAbort = null;
    stopRamp(state);
    state.loginStatus = "done";
    state.loginError = null;
    const result: OAuthResult = {
      kind,
      tokens: staged.profile.tokens,
      commit: staged.commit,
      providerName: oauthProviderName(kind, staged.profile.name),
    };
    state.loginResult = result;
    state.values.name = result.providerName;
    state.values.apiKey = "";
    state.stepIndex += 1;
    if (selectors.isListStep()) hooks.enterModelList();
    hooks.showStep();
  };

  const beginLogin = (): void => {
    const kind = state.choice?.oauth ?? null;
    if (kind === null) return;
    abandonLogin();
    const attempt = state.loginAttempt;
    state.loginStatus = "pending";
    state.loginError = null;
    state.loginCancelled = false;
    const abort = new AbortController();
    state.loginAbort = abort;
    // A browser round-trip that never comes back must still give the screen
    // back, so the deadline is armed before the flow is even started.
    state.loginTimer = setTimeout(() => {
      failLogin(attempt, LOGIN_TIMEOUT_MESSAGE);
    }, state.loginTimeoutMs);
    stopRamp(state);
    state.rampTimer = setInterval(() => surface.paintStatus(), RAMP_TICK_MS);
    surface.paint();

    state
      .startLogin({
        kind,
        profile: state.values.oauthProfile,
        signal: abort.signal,
      })
      .then(
        (handle) => {
          if (attempt !== state.loginAttempt) {
            handle.cancel();
            return;
          }
          state.loginHandle = handle;
          state.loginURL = handle.authorizeUrl;
          surface.paint();
          handle.completed.then(
            (result) => {
              finishLogin(attempt, kind, result);
            },
            (err: unknown) => {
              failLogin(
                attempt,
                err instanceof Error ? err.message : String(err),
              );
            },
          );
        },
        (err: unknown) => {
          failLogin(attempt, err instanceof Error ? err.message : String(err));
        },
      );
  };

  /** Abandon an outstanding sign-in and return to the provider list. */
  const cancelLogin = (): void => {
    const wasPending = state.loginStatus === "pending";
    abandonLogin();
    stopRamp(state);
    state.loginStatus = "idle";
    state.loginURL = null;
    state.loginError = null;
    state.loginResult = null;
    hooks.back();
    state.loginCancelled = wasPending;
    surface.paint();
  };

  return { beginLogin, abandonLogin, cancelLogin };
}

/**
 * The multi-instance "name" step: an inline error from the last validation,
 * a suggested non-colliding slug prefilled on entry, and a collision confirm
 * (one more Enter) before the slug is settled and the flow advances.
 */
export function createAccountNameFlow(
  state: SetupState,
  surface: Surface,
  hooks: SetupFlowHooks,
): AccountNameFlow {
  /**
   * Enter the step: reset per-visit state, show whatever slug is already
   * typed, then resolve existing instance names to prefill a suggested,
   * non-colliding slug when the field is still blank. OAuth reads the live
   * auth store; API-key reads the settings catalog snapshot.
   */
  const enter = (): void => {
    state.oauthProfileError = null;
    state.oauthProfileConfirmPending = false;
    surface.input.placeholder = OAUTH_PROFILE_HINT;
    surface.input.value = state.values.oauthProfile;
    surface.paint();
    surface.input.focus();
    if (state.choice === null || state.choice.custom) return;
    const attempt = (state.oauthNameAttempt += 1);
    const applySuggestion = (names: readonly string[]): void => {
      if (state.settled || attempt !== state.oauthNameAttempt) return;
      if (state.values.oauthProfile.trim().length === 0) {
        state.values.oauthProfile = suggestOAuthProfileSlug(names);
        surface.input.value = state.values.oauthProfile;
        surface.paint();
      }
    };
    if (state.choice.oauth !== null) {
      state
        .listOAuthProfiles(state.choice.oauth)
        .catch((): readonly string[] => [])
        .then(applySuggestion);
      return;
    }
    applySuggestion(
      instanceSlugsForKind(state.choice.id, state.existingProviderNames),
    );
  };

  const settleAccountNameSlug = (slug: string): void => {
    state.values.oauthProfile = slug;
    state.oauthProfileError = null;
    state.oauthProfileConfirmPending = false;
    state.confirmedSlug = null;
    if (
      state.choice !== null &&
      state.choice.oauth === null &&
      !state.choice.custom
    ) {
      // API-key multi-instance: catalog key is kind/slug (or legacy bare kind
      // when reconnecting the original single-instance "default").
      state.values.name = resolveApiKeyInstanceName(
        state.choice.id,
        slug,
        state.existingProviderNames,
      );
    }
    state.stepIndex += 1;
    hooks.showStep();
  };

  /**
   * Validate the entered slug, then check collisions against a fresh source
   * (auth store for OAuth, settings catalog for API-key). A collision needs
   * one more Enter to confirm before the step advances.
   */
  const advance = (): void => {
    if (state.choice === null || state.choice.custom) return;
    const validated = validateOAuthProfileSlug(state.values.oauthProfile);
    if (!validated.ok) {
      state.oauthProfileError = validated.error;
      state.oauthProfileConfirmPending = false;
      state.confirmedSlug = null;
      surface.paint();
      return;
    }
    const slug = validated.slug;
    // Already confirmed this exact slug on the previous Enter — proceed
    // without another round-trip. Any edit since then cleared the flag (see
    // the input handler), so this only fires on a genuine second, unmodified
    // Enter.
    if (state.oauthProfileConfirmPending && state.confirmedSlug === slug) {
      settleAccountNameSlug(slug);
      return;
    }
    const attempt = (state.oauthNameAttempt += 1);
    const handleNames = (names: readonly string[]): void => {
      if (state.settled || attempt !== state.oauthNameAttempt) return;
      if (names.includes(slug)) {
        state.oauthProfileError = null;
        state.oauthProfileConfirmPending = true;
        state.confirmedSlug = slug;
        surface.paint();
        return;
      }
      settleAccountNameSlug(slug);
    };
    if (state.choice.oauth !== null) {
      state
        .listOAuthProfiles(state.choice.oauth)
        .catch((): readonly string[] => [])
        .then(handleNames);
      return;
    }
    handleNames(
      instanceSlugsForKind(state.choice.id, state.existingProviderNames),
    );
  };

  return { enter, advance };
}
