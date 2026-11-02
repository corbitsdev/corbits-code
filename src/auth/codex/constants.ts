import { callbackTargetFor } from "@corbits/oauth-core";
import { codexOAuthConfig } from "@corbits/codex-provider";

export {
  CODEX_BASE_URL,
  CODEX_REDIRECT_URI,
  CODEX_RESPONSES_PATH,
} from "@corbits/codex-provider";

const callbackTarget = callbackTargetFor(codexOAuthConfig);
export const CODEX_CALLBACK_HOST = callbackTarget.host;
export const CODEX_CALLBACK_PORT = callbackTarget.port;
export const CODEX_CALLBACK_PATH = callbackTarget.path;

// The account's available model catalog. The models endpoint requires a
// client_version query param.
export const CODEX_MODELS_PATH = "/codex/models";
export const CODEX_CLIENT_VERSION = "0.50.0";

// Client identity the Codex backend expects on usage/model requests, matching
// the public Codex CLI originator.
export const CODEX_ORIGINATOR = "codex_cli_rs";

// The models a ChatGPT sign-in offers, in the order the Codex backend lists
// them (GET /codex/models); the first entry is the ChatGPT default. gpt-5.4,
// gpt-5.4-mini and gpt-5.5 are left out because OpenAI's documentation lists
// them as retired for ChatGPT, whether or not the backend still returns them.
// The OpenAI API-key path has its own list and default and does not follow
// this one.
export const CODEX_DEFAULT_MODELS = [
  "gpt-6.1-sol",
  "gpt-6-astra",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-5.6-sol",
  "gpt-6.1-terra",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
] as const;
