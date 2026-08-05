export type FirstClassAuthKind = "oauth" | "api-key";

export type FirstClassOAuthProvider = "codex" | "xai";

export type FirstClassProviderDef = {
  id: string;
  label: string;
  auth: FirstClassAuthKind;
  /** OAuth flow key when auth === "oauth". */
  oauth?: FirstClassOAuthProvider;
  /** Default inference base URL for api-key providers. */
  baseURL?: string;
  /** Pre-seeded models for api-key providers (empty until connected for oauth). */
  models?: readonly string[];
  defaultModel?: string;
  /** Short paste hint for api-key providers. */
  authHint?: string;
  /**
   * When true, host should use Anthropic Messages adapter (baseURL without /v1
   * if the adapter appends /v1/messages).
   */
  anthropic?: boolean;
};
