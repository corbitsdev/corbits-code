import { CODEX_REDIRECT_URI } from "@corbits/codex-provider";

export {
  CODEX_BASE_URL,
  CODEX_REDIRECT_URI,
  CODEX_REFRESH_SKEW_MS,
  CODEX_RESPONSES_PATH,
} from "@corbits/codex-provider";

const codexRedirect = new URL(CODEX_REDIRECT_URI);
export const CODEX_CALLBACK_PORT = Number(codexRedirect.port);
export const CODEX_CALLBACK_PATH = codexRedirect.pathname;

// Live usage/quota for the prepaid plan (window %, reset, credits) and the
// account's available model catalog. The models endpoint requires a
// client_version query param.
export const CODEX_USAGE_PATH = "/codex/usage";
export const CODEX_MODELS_PATH = "/codex/models";
export const CODEX_CLIENT_VERSION = "0.50.0";

// Client identity the Codex backend expects on usage/model requests, matching
// the public Codex CLI originator.
export const CODEX_ORIGINATOR = "codex_cli_rs";

// Fallback model list, used only when the live catalog (GET /codex/models) is
// unavailable — e.g. while rate-limited it returns an empty list. The Codex
// backend rotates its serving set (codex-rs no longer hardcodes presets), so
// the live fetch is authoritative and these are just a current-generation
// default so the picker is never empty. The first entry doubles as the
// ChatGPT-OAuth default model: it must stay the model shared with the OpenAI
// API-key path's default in FIRST_CLASS_PROVIDERS (gpt-5.4), so both auth
// paths serving OpenAI agree. identity-divergence.test.ts pins this.
export const CODEX_DEFAULT_MODELS = [
  "gpt-5.4",
  "gpt-5.5",
  "gpt-6-astra",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.4-mini",
] as const;

// How often a headless run re-checks its Codex token and reseeds the source.
// Half the skew so the refresh window is never missed between ticks.
export const CODEX_HEADLESS_REFRESH_INTERVAL_MS = 30_000;
