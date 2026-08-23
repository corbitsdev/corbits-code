import {
  OPENCODE_GO_AUTH_HINT,
  OPENCODE_GO_BASE_URL,
  OPENCODE_GO_DISPLAY_NAME,
  OPENCODE_GO_PROVIDER_ID,
} from "./constants.js";
import {
  OPENCODE_GO_DEFAULT_MODEL,
  OPENCODE_GO_MODEL_IDS,
  OPENCODE_GO_MODELS,
  type GoProtocol,
} from "./models.js";

/** Host-agnostic catalog projection for connect + model pickers. */
export interface GoCatalogEntry {
  name: typeof OPENCODE_GO_PROVIDER_ID;
  displayName: typeof OPENCODE_GO_DISPLAY_NAME;
  baseURL: typeof OPENCODE_GO_BASE_URL;
  models: readonly string[];
  defaultModel: string;
  protocols: Readonly<Record<string, GoProtocol>>;
  authHint: typeof OPENCODE_GO_AUTH_HINT;
}

export function buildGoCatalogEntry(): GoCatalogEntry {
  const protocols: Record<string, GoProtocol> = {};
  for (const m of OPENCODE_GO_MODELS) {
    protocols[m.id] = m.protocol;
  }
  return {
    name: OPENCODE_GO_PROVIDER_ID,
    displayName: OPENCODE_GO_DISPLAY_NAME,
    baseURL: OPENCODE_GO_BASE_URL,
    models: OPENCODE_GO_MODEL_IDS,
    defaultModel: OPENCODE_GO_DEFAULT_MODEL,
    protocols,
    authHint: OPENCODE_GO_AUTH_HINT,
  };
}
