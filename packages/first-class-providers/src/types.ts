export type FirstClassAuthKind = "oauth" | "api-key" | "keyless" | "chooser" | "custom";

export type FirstClassOAuthProvider = "codex" | "xai";

export type FirstClassBillingProduct = "subscription" | "credits";

/** One connect path under a chooser provider (e.g. OpenAI ChatGPT vs API key). */
export interface FirstClassProviderPath {
  id: string;
  label: string;
  auth: "oauth" | "api-key";
  /** OAuth flow key when auth === "oauth". */
  oauth?: FirstClassOAuthProvider;
  /** Default inference base URL for api-key paths. */
  baseURL?: string;
  /** Pre-seeded models for api-key paths. */
  models?: readonly string[];
  defaultModel?: string;
  /** Short paste hint for api-key paths. */
  authHint?: string;
  /**
   * Catalog provider id written after connect.
   * e.g. "codex" for ChatGPT OAuth, "openai" for API key.
   */
  providerId?: string;
}

export interface FirstClassProviderDef {
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
  /** When true, host should treat this as OpenCode Go (protocol + key validation). */
  opencodeGo?: boolean;
  /** Optional product billing style for Go/Zen-style subscriptions vs credits. */
  billingProduct?: FirstClassBillingProduct;
  /**
   * Sub-paths when auth === "chooser". Operator picks a path, then oauth or
   * api-key flow runs against that path's fields / providerId.
   */
  paths?: readonly FirstClassProviderPath[];
}
