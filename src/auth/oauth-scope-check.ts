// A completed OAuth login proves the token is real (issued by the provider's
// own authorization server via PKCE) but not that it carries usable API
// scope — e.g. a chat-only subscription without API access. Trusting the
// login result alone lets onboarding complete on a token whose first real
// inference call fails with a confusing auth error. This runs one cheap,
// authoritative call against each provider's own catalog/list endpoint
// (the same surface real inference would hit) so a scope gap is caught
// during setup instead of during the first conversation.
//
// Never logs or persists the token or any response body — only the HTTP
// status is inspected to classify the result.

import { CODEX_BASE_URL, CODEX_MODELS_PATH, CODEX_CLIENT_VERSION } from "./codex/constants.js";
import { refreshStagedCodexTokens } from "./codex/session.js";
import type { CodexTokens } from "./codex/store.js";
import { codexAuthHeadersForToken } from "./codex/usage.js";
import { XAI_BASE_URL, XAI_TOKEN_TIMEOUT_MS } from "./xai/constants.js";
import { refreshStagedXaiTokens } from "./xai/session.js";
import type { XaiTokens } from "./xai/store.js";
import { xaiAuthHeadersForToken } from "./xai/usage.js";
import { OAuthTokenEndpointError } from "./oauth/client.js";

export type OAuthScopeCheckKind = "codex" | "xai";

export type OAuthScopeCheckResult =
  | { status: "ok" }
  | { status: "blocked"; message: string }
  // The probe could not run to completion (network blip, timeout, rate
  // limit, provider hiccup). This must never be treated the same as a
  // definitive scope failure — a transient failure must not lock a
  // legitimate user out of onboarding.
  | { status: "unavailable"; message: string };

const SCOPE_CHECK_TIMEOUT_MS = 10_000;

function insufficientScope(providerLabel: string): OAuthScopeCheckResult {
  return {
    status: "blocked",
    message:
      `Your ${providerLabel} sign-in doesn't carry API access (it looks like a chat-only plan). ` +
      `Reconnect ${providerLabel} with an account/plan that includes API access, then try again.`,
  };
}

function unavailable(providerLabel: string): OAuthScopeCheckResult {
  return {
    status: "unavailable",
    message: `Couldn't confirm ${providerLabel} API access right now — continuing without blocking setup.`,
  };
}

function invalidCredentials(providerLabel: string): OAuthScopeCheckResult {
  return {
    status: "blocked",
    message: `${providerLabel} sign-in expired or was revoked. Reconnect ${providerLabel}, then try again.`,
  };
}

export class OAuthProviderScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthProviderScopeError";
  }
}

export function isOAuthProviderScopeError(err: unknown): err is OAuthProviderScopeError {
  return err instanceof OAuthProviderScopeError;
}

export function isBlockingOAuthScopeCheckResult(
  result: OAuthScopeCheckResult,
): result is Extract<OAuthScopeCheckResult, { status: "blocked" }> {
  return result.status === "blocked";
}

function isDefinitiveRefreshAuthRejection(err: unknown): boolean {
  if (!(err instanceof OAuthTokenEndpointError)) return false;
  if (err.status === 401 || err.status === 403) return true;
  return /invalid_grant|revoked/i.test(err.detail);
}

// 401/403 is the provider definitively rejecting the token for this surface —
// treated as a real scope failure. Anything else (429, 5xx, a malformed
// response) is inconclusive: it says nothing about whether the token has
// scope, only that this particular check didn't get a clean answer.
function classifyStatus(status: number, providerLabel: string): OAuthScopeCheckResult {
  if (status === 401 || status === 403) return insufficientScope(providerLabel);
  return unavailable(providerLabel);
}

async function checkCodexScope(tokens: CodexTokens): Promise<OAuthScopeCheckResult> {
  const providerLabel = "Codex";
  try {
    const headers = codexAuthHeadersForToken(await refreshStagedCodexTokens(tokens));
    const url = `${CODEX_BASE_URL}${CODEX_MODELS_PATH}?client_version=${encodeURIComponent(CODEX_CLIENT_VERSION)}`;
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(SCOPE_CHECK_TIMEOUT_MS),
    });
    if (res.ok) return { status: "ok" };
    return classifyStatus(res.status, providerLabel);
  } catch (err) {
    if (isDefinitiveRefreshAuthRejection(err)) return invalidCredentials(providerLabel);
    return unavailable(providerLabel);
  }
}

async function checkXaiScope(tokens: XaiTokens): Promise<OAuthScopeCheckResult> {
  const providerLabel = "Grok";
  try {
    const headers = xaiAuthHeadersForToken(await refreshStagedXaiTokens(tokens));
    const res = await fetch(`${XAI_BASE_URL}/models`, {
      headers,
      signal: AbortSignal.timeout(XAI_TOKEN_TIMEOUT_MS),
    });
    if (res.ok) return { status: "ok" };
    return classifyStatus(res.status, providerLabel);
  } catch (err) {
    if (isDefinitiveRefreshAuthRejection(err)) return invalidCredentials(providerLabel);
    return unavailable(providerLabel);
  }
}

// Probe an OAuth-issued token against the provider's own catalog/list
// endpoint to prove it carries real API scope, rather than trusting the
// login result alone.
export async function checkOAuthProviderScope(
  kind: OAuthScopeCheckKind,
  tokens: CodexTokens | XaiTokens,
): Promise<OAuthScopeCheckResult> {
  return kind === "codex" ? checkCodexScope(tokens) : checkXaiScope(tokens);
}
