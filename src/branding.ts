// Canonical product-identity strings for runtime TypeScript. Product name, CLI
// command, config directory, logger/director/tool namespace, and wire identity
// (MCP client name, user-agent token, prompt-injection tag) derive from here so
// a future *runtime* rename does not scatter literals across src/.
//
// package.json "name"/"bin", build/release scripts, and docs cannot import
// TypeScript — keep those in sync with COMMAND_NAME / PRODUCT_NAME by hand.

export const PRODUCT_NAME = "Corbits Code";

// Short attribution form used in compact UI (status lines, footers).
export const PRODUCT_SHORT_NAME = "Corbits";

export const COMMAND_NAME = "corbits";

export const SETTINGS_DIR_NAME = ".corbits";

export const ENV_PREFIX = "CORBITS_";

// Logger namespace root, e.g. getLogger([LOG_NAMESPACE_ROOT, "agent", "director"]).
export const LOG_NAMESPACE_ROOT = COMMAND_NAME;

// Prefix for director/tool ids, e.g. `${ID_PREFIX}/chat`, `${ID_PREFIX}/subagent`.
export const ID_PREFIX = COMMAND_NAME;

// Name reported by MCP clients we open (Client({ name: MCP_CLIENT_NAME, ... })),
// and the OAuth dynamic-registration client_name.
export const MCP_CLIENT_NAME = COMMAND_NAME;

// Marker used to delimit shell cwd output; upper-cased env-style token.
export const SHELL_PWD_MARKER = `__${ENV_PREFIX}SHELL_PWD_END__`;

// XML-ish tag wrapping the injected system prompt in the Codex Responses bridge.
export const ENVIRONMENT_TAG_NAME = `${COMMAND_NAME}_environment`;
