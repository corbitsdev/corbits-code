export {
  OPENCODE_GO_ANTHROPIC_BASE_URL,
  OPENCODE_GO_AUTH_HINT,
  OPENCODE_GO_BASE_URL,
  OPENCODE_GO_DISPLAY_NAME,
  OPENCODE_GO_MODELS_PATH,
  OPENCODE_GO_PROVIDER_ID,
  OPENCODE_GO_USAGE_PATH,
} from "./constants.js";

export {
  OPENCODE_GO_DEFAULT_MODEL,
  OPENCODE_GO_MODEL_IDS,
  OPENCODE_GO_MODELS,
  isKnownGoModel,
  protocolForGoModel,
  type GoModel,
  type GoModelId,
  type GoProtocol,
} from "./models.js";

export { resolveGoEndpoint, type GoEndpoint } from "./endpoint.js";
export { validateGoApiKey, type GoApiKeyValidation } from "./auth.js";
export { fetchGoUsage, formatGoUsage, type GoFetch, type GoUsage, type GoUsageWindow } from "./usage.js";
export { buildGoCatalogEntry, type GoCatalogEntry } from "./catalog.js";
export {
  isOpenCodeGoProvider,
  isOpenCodeGoProviderId,
  isOpenCodeGoURL,
} from "./identity.js";
export {
  parseGoAPIError,
  type GoErrorCategory,
  type GoErrorKind,
  type ParsedGoAPIError,
} from "./errors.js";
