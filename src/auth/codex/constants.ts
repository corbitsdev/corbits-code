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

// The models a ChatGPT sign-in can select, in the Codex backend's priority
// order (GET /codex/models); the first entry is the ChatGPT default. OpenAI
// retires models for ChatGPT sign-in on its own schedule, independently of the
// OpenAI API, so this list and its default do not follow the API-key path.
export const CODEX_DEFAULT_MODELS = [
  "gpt-6.1-sol",
  "gpt-6-astra",
  "gpt-6.1-terra",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
] as const;
