export {
  FIRST_CLASS_PROVIDERS,
  connectListProviders,
  firstClassPathAsProvider,
  firstClassProviderById,
} from "./providers.js";
export type {
  FirstClassAuthKind,
  FirstClassBillingProduct,
  FirstClassOAuthProvider,
  FirstClassProviderDef,
  FirstClassProviderPath,
} from "./types.js";

// Re-export Go package surface so hosts can depend on one entry for connect.
export {
  OPENCODE_GO_ANTHROPIC_BASE_URL,
  OPENCODE_GO_AUTH_HINT,
  OPENCODE_GO_BASE_URL,
  OPENCODE_GO_DEFAULT_MODEL,
  OPENCODE_GO_DISPLAY_NAME,
  OPENCODE_GO_MODEL_IDS,
  OPENCODE_GO_MODELS,
  OPENCODE_GO_PROVIDER_ID,
  buildGoCatalogEntry,
  fetchGoUsage,
  formatGoUsage,
  isKnownGoModel,
  protocolForGoModel,
  resolveGoEndpoint,
  validateGoApiKey,
  type GoCatalogEntry,
  type GoEndpoint,
  type GoModel,
  type GoProtocol,
  type GoUsage,
} from "../../opencode-go/src/index.js";
