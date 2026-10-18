import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { callbackTargetFor } from "@corbits/oauth-core";

const require = createRequire(import.meta.url);
const packageIndex = pathToFileURL(require.resolve("@corbits/codex-provider"));
const codexConstants = require(
  fileURLToPath(new URL("./constants.js", packageIndex)),
) as {
  CODEX_BASE_URL: string;
  CODEX_REDIRECT_URI: string;
  CODEX_RESPONSES_PATH: string;
};
const { codexOAuthConfig } = require(
  fileURLToPath(new URL("./oauth.js", packageIndex)),
) as {
  codexOAuthConfig: Parameters<typeof callbackTargetFor>[0];
};

export const CODEX_BASE_URL = codexConstants.CODEX_BASE_URL;
export const CODEX_REDIRECT_URI = codexConstants.CODEX_REDIRECT_URI;
export const CODEX_RESPONSES_PATH = codexConstants.CODEX_RESPONSES_PATH;

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

// Fallback model list, used only when the live catalog (GET /codex/models) is
// unavailable — rate-limited it returns an empty list. The backend rotates its
// serving set, so the live fetch is authoritative and these are just a
// current-generation default so the picker is never empty. The first entry
// doubles as the ChatGPT-OAuth default: it must stay the model shared with the
// OpenAI API-key path's default in FIRST_CLASS_PROVIDERS (gpt-5.4) so both
// auth paths serving OpenAI agree. identity-divergence.test.ts pins this.
export const CODEX_DEFAULT_MODELS = [
  "gpt-5.4",
  "gpt-5.5",
  "gpt-6-astra",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.4-mini",
] as const;
