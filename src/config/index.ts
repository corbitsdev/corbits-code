import { resolve } from "node:path";

import { xaiUserIdFromAccessToken } from "@corbits/xai-provider";
import type { InferenceSource } from "@intx/types/runtime";
import {
  generateSessionId,
  isSessionId,
  migrateLegacySessionIfNeeded,
} from "../session/index.js";
import { loadState } from "../session/state.js";
import { COMMAND_NAME } from "../branding.js";
import pkg from "../../package.json" with { type: "json" };

import { isDirectorId } from "../agent/directors/registry.js";
import { DIRECTOR_IDS, type DirectorId } from "../agent/directors/types.js";
import type { GuidelineSubBlockId } from "../agent/prompts.js";
import {
  validateEffort,
  type ReasoningEffort,
} from "../provider/reasoning-effort.js";
import {
  buildProviderContextWindowOverrides,
  setProviderContextWindowOverrides,
} from "../provider/context-window.js";
import { bootstrapPricingMetadata } from "../cost/pricing-metadata.js";
import {
  defaultPricingCachePath,
  type PricingFetcherOptions,
} from "../cost/pricing-fetcher.js";
import type { CodexProfile } from "../auth/codex/store.js";
import type { XaiProfile } from "../auth/xai/store.js";
import { listCodexProfiles, listXaiProfiles } from "./oauth-stores.js";
import {
  registerSourceCredentialRecord,
  type SourceCredentialProvenance,
} from "./source-credentials.js";
import {
  codexProfilesToCatalogEntries,
  codexProvidersAsSettings,
  isCodexProviderName,
} from "./codex-providers.js";
import {
  isXaiProviderName,
  xaiProfilesToCatalogEntries,
  xaiProvidersAsSettings,
} from "./xai-providers.js";
import { fetchBifrostModels } from "./bifrost.js";
import { customReasoningSettings } from "./providers.js";

export { fetchBifrostModels };
import { CODEX_BASE_URL } from "../auth/codex/constants.js";
import { XAI_BASE_URL } from "../auth/xai/constants.js";
import {
  CODEX_RESPONSES_PROVIDER,
  CODEX_SESSION_ID_OPTION,
} from "../provider/codex-responses.js";
import {
  GROK_RESPONSES_PROVIDER,
  GROK_SESSION_ID_OPTION,
} from "../provider/grok-responses.js";
import { BIFROST_PROVIDER } from "../provider/bifrost-adapter.js";
import { DEEPSEEK_V4_PROVIDER } from "../provider/deepseek-v4-adapter.js";
import { isDeepSeekModel } from "../provider/deepseek-v4-effort.js";
import { isOllamaProviderId, ollamaOpenAIBaseURL } from "../provider/ollama.js";
import { selectableGoModelIds } from "../provider/model-catalogs.js";
import {
  OPENCODE_GO_MESSAGES_PROVIDER,
  ZEN_MESSAGES_PROVIDER,
} from "../provider/anthropic-session-adapter.js";
import { selectableZenModelIds } from "../provider/model-catalogs.js";
import {
  OPENAI_RESPONSES_PROVIDER,
  OPENAI_SESSION_ID_OPTION,
} from "../provider/openai-responses.js";
import { OPENCODE_SESSION_ID_OPTION } from "../provider/opencode-session.js";
import {
  OPENCODE_GO_BASE_URL,
  OPENCODE_GO_PROVIDER_ID,
  isOpenCodeGoProvider,
  resolveGoEndpoint,
} from "../../packages/opencode-go/src/index.js";
import {
  ZEN_DEFAULT_BASE_URL,
  isZenProvider,
  resolveZenEndpoint,
} from "../../packages/zen/src/index.js";

import {
  globalSettingsPath,
  loadLocalSettingsResult,
  type SettingsLoadDiagnostic,
  loadSettingsRecoveringClobberedOAuthSelection,
  resolveLocalSettingsPath,
  normalizeOpenAICompatibleBaseURL,
  resolveProvider,
  hasMcpTransport,
  isExaMCPPreset,
  type MCPServerSettingsEntry,
  type ResolvedProvider,
  type Settings,
  type ProviderSettings,
} from "./settings.js";
import {
  EXA_MCP_SERVER_NAME,
  createExaMCPServerConfig,
  type ResolvedMCPServerConfig,
} from "../mcp/exa.js";
import { resolveProfile } from "./profiles.js";

// Per-call token ceiling for inference sources, shared by agent creation
// (runner.ts) and live provider switching (the /agent modal) so a live switch
// cannot silently revert it.
export const SOURCE_MAX_TOKENS = 16384;

// Credential-cell placeholder for keyless local providers (e.g. Ollama). The
// harness still sends it as `Bearer <key>`; keyless servers ignore it.
export const KEYLESS_API_KEY = "keyless";

// Registers the secret behind a source id in the credential cell (see
// ./source-credentials.ts), falling back to the keyless sentinel when no key
// was configured. Every buildXSource below calls this so the vendored
// credentialId model resolves the secret at send time.
function registerSourceSecret(
  id: string,
  apiKey: string | undefined,
  provenance?: SourceCredentialProvenance,
  headers?: Readonly<Record<string, string>>,
): void {
  const hasSecret = apiKey !== undefined && apiKey.length > 0;
  registerSourceCredentialRecord(id, {
    provenance:
      provenance ?? (hasSecret ? { kind: "api-key" } : { kind: "keyless" }),
    material: {
      secret: hasSecret ? apiKey : KEYLESS_API_KEY,
      ...(headers !== undefined ? { headers } : {}),
    },
  });
}

function applyPersistedOAuthDefaults(
  settings: Settings | null,
  projected: Record<string, ProviderSettings>,
): Record<string, ProviderSettings> {
  const merged: Record<string, ProviderSettings> = {};
  for (const [name, provider] of Object.entries(projected)) {
    const defaultModel = settings?.providers[name]?.defaultModel;
    merged[name] =
      defaultModel !== undefined && defaultModel.length > 0
        ? {
            ...provider,
            models: provider.models.includes(defaultModel)
              ? provider.models
              : [defaultModel, ...provider.models],
            defaultModel,
          }
        : provider;
  }
  return merged;
}

// OAuth entries in settings.json carry no credentials; they work only while a
// matching auth-store profile exists. Drop orphans in memory so a removed
// profile does not pin resolution to an unauthenticatable provider.
export function dropOrphanedOAuthEntries(
  settings: Settings | null,
  projected: Record<string, ProviderSettings>,
): Settings | null {
  if (settings === null) return null;
  const providers = Object.fromEntries(
    Object.entries(settings.providers).filter(
      ([name, provider]) =>
        (!isCodexProviderName(name) && !isXaiProviderName(name)) ||
        projected[name] !== undefined ||
        isHandNamedProviderEntry(provider),
    ),
  );
  const { defaultProvider, ...rest } = settings;
  return {
    ...rest,
    providers,
    ...(defaultProvider !== undefined &&
    providers[defaultProvider] !== undefined
      ? { defaultProvider }
      : {}),
  };
}

// A codex/<slug> or xai/<slug> row with its own credential is explicit
// config, not an OAuth placeholder: projections must never overwrite or
// orphan-sweep it. Credential-less namespaced rows stay placeholders.
function isHandNamedProviderEntry(
  entry: Pick<ProviderSettings, "apiKey" | "keyless"> | undefined,
): boolean {
  if (entry === undefined) return false;
  if (entry.keyless === true) return true;
  return typeof entry.apiKey === "string" && entry.apiKey.length > 0;
}

// Overlay live OAuth profile projections onto settings for runtime provider
// resolution. Exported for tests; loadConfig is the only production caller.
export function overlayOAuthProjections(
  settings: Settings | null,
  projected: Record<string, ProviderSettings>,
): Settings | null {
  if (Object.keys(projected).length === 0) return settings;
  const providers = { ...(settings?.providers ?? {}) };
  for (const [name, entry] of Object.entries(projected)) {
    if (!isHandNamedProviderEntry(providers[name])) providers[name] = entry;
  }
  return {
    ...(settings ?? { providers: {} }),
    providers,
  };
}

function hasExaEntry(servers: MCPServerSettingsEntry[] | undefined): boolean {
  return (
    servers?.some((server) => server.name === EXA_MCP_SERVER_NAME) === true
  );
}

function globalExaSuppressesBuiltin(
  servers: MCPServerSettingsEntry[] | undefined,
): boolean {
  return (
    servers?.some((server) => {
      if (server.name !== EXA_MCP_SERVER_NAME) return false;
      if (isExaMCPPreset(server)) return !server.enabled;
      return hasMcpTransport(server);
    }) === true
  );
}

function expandMcpServers(
  servers: MCPServerSettingsEntry[],
): ResolvedMCPServerConfig[] {
  return servers.flatMap((server) => {
    if (isExaMCPPreset(server))
      return server.enabled ? [createExaMCPServerConfig()] : [];
    if (server.enabled === false) return [];
    const { enabled: _enabled, ...connect } = server;
    return [connect];
  });
}

export function resolveMcpServers(
  globalServers: MCPServerSettingsEntry[] | undefined,
  localServers: MCPServerSettingsEntry[] | undefined,
): ResolvedMCPServerConfig[] {
  if (localServers !== undefined) {
    const localResolved = expandMcpServers(localServers);
    if (hasExaEntry(localServers) || globalExaSuppressesBuiltin(globalServers))
      return localResolved;
    return [createExaMCPServerConfig(), ...localResolved];
  }

  if (globalServers !== undefined) {
    const globalResolved = expandMcpServers(globalServers);
    if (hasExaEntry(globalServers)) return globalResolved;
    return [createExaMCPServerConfig(), ...globalResolved];
  }

  return [createExaMCPServerConfig()];
}

// Build the OpenAI-compatible InferenceSource the runtime consumes. `id` is the
// user-facing name for this source (e.g. "zen"); `provider` routes to the
// openai-compatible adapter, or the deepseek-v4 per-family adapter for V4
// models, so the inference registry picks the right adapter.
export function buildOpenAISource(fields: {
  id: string;
  baseURL: string;
  apiKey?: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  quirks?: Record<string, unknown>;
}): InferenceSource {
  const providerOptions: Record<string, unknown> = {};
  if (fields.reasoningEffort !== undefined)
    providerOptions["reasoning_effort"] = fields.reasoningEffort;
  if (fields.temperature !== undefined)
    providerOptions["temperature"] = fields.temperature;
  if (fields.topP !== undefined) providerOptions["top_p"] = fields.topP;
  registerSourceSecret(fields.id, fields.apiKey);
  return {
    id: fields.id,
    provider: isDeepSeekModel(fields.model)
      ? DEEPSEEK_V4_PROVIDER
      : "openai-compatible",
    baseURL: isOllamaProviderId(fields.id)
      ? ollamaOpenAIBaseURL(fields.baseURL)
      : normalizeOpenAICompatibleBaseURL(fields.baseURL),
    credentialId: fields.id,
    model: fields.model,
    defaults: {
      maxTokens: fields.maxTokens ?? SOURCE_MAX_TOKENS,
      ...(Object.keys(providerOptions).length > 0 ? { providerOptions } : {}),
    },
    ...(fields.quirks !== undefined ? { quirks: fields.quirks } : {}),
  };
}

// One configured provider the /agent modal can switch to. Derived from
// ProviderSettings so a new required field forces every catalog literal to
// supply it; `name` is required (a concrete provider id), `contextWindow` is
// dropped (settings-only, never surfaced). Carries credentials the modal
// never shows. OAuth-profile markers have no ProviderSettings counterpart
// and are never written to settings.json. Optional fields still need the
// config.test.ts round-trip: TS misses a missing optional property on an
// explicitly-typed literal.
export type ProviderCatalogEntry = Omit<
  ProviderSettings,
  "name" | "contextWindow"
> & {
  name: string;
  // Codex OAuth profile name (not an API-key provider); the send path
  // refreshes the access token with it before each turn.
  codexProfile?: string;
  // ChatGPT account id for a Codex profile, sent as the chatgpt-account-id
  // header by the Responses adapter. Codex entries only.
  codexAccountId?: string;
  // xAI/Grok OAuth profile. Still routes through openai-compatible; the
  // marker only controls token refresh and persistence.
  xaiProfile?: string;
  // Bifrost virtual key: sources use provider "bifrost" so the adapter
  // injects the x-bf-vk header; also enables /models auto-discovery scoped
  // to the key.
  bifrostVirtualKey?: boolean;
  // Anthropic Messages API (x-api-key): first-class Anthropic and OpenCode Go
  // models that speak the messages protocol.
  anthropic?: boolean;
  // OpenCode Go multi-protocol provider; per-model routing picks the adapter
  // at source-build time.
  opencodeGo?: boolean;
  // False when persisted without a passing connection test; see
  // ProviderSettings.verified in settings.ts.
  verified?: boolean;
};

// Build the InferenceSource for a Codex OAuth profile: routes to
// "codex-responses" (Codex speaks the Responses API, not Chat Completions)
// and carries the session id through providerOptions; the access token and
// account id register together in the credential cell.
export function buildCodexSource(fields: {
  id: string;
  profile: string;
  apiKey: string;
  model: string;
  sessionId: string;
  accountId?: string;
  reasoningEffort?: ReasoningEffort;
}): InferenceSource {
  const providerOptions: Record<string, unknown> = {
    [CODEX_SESSION_ID_OPTION]: fields.sessionId,
  };
  if (fields.reasoningEffort !== undefined)
    providerOptions["reasoning_effort"] = fields.reasoningEffort;
  registerSourceSecret(
    fields.id,
    fields.apiKey,
    { kind: "oauth", provider: "codex", profile: fields.profile },
    fields.accountId !== undefined
      ? { "chatgpt-account-id": fields.accountId }
      : undefined,
  );
  return {
    id: fields.id,
    provider: CODEX_RESPONSES_PROVIDER,
    baseURL: CODEX_BASE_URL,
    credentialId: fields.id,
    model: fields.model,
    defaults: { maxTokens: SOURCE_MAX_TOKENS, providerOptions },
  };
}

// Build the InferenceSource for an xAI/Grok OAuth profile: routes to
// "grok-responses" (the grok-cli proxy speaks the Responses API, not Chat
// Completions); the adapter decodes the caller's user id from the token into
// x-grok-user-id. Session id becomes prompt_cache_key so every call in the
// thread routes to the same cache shard (store:false has no other signal).
export function buildXaiSource(fields: {
  id: string;
  profile: string;
  apiKey: string;
  model: string;
  sessionId: string;
  reasoningEffort?: ReasoningEffort;
}): InferenceSource {
  const userId = xaiUserIdFromAccessToken(fields.apiKey);
  const providerOptions: Record<string, unknown> = {
    [GROK_SESSION_ID_OPTION]: fields.sessionId,
  };
  if (fields.reasoningEffort !== undefined)
    providerOptions["reasoning_effort"] = fields.reasoningEffort;
  registerSourceSecret(
    fields.id,
    fields.apiKey,
    { kind: "oauth", provider: "xai", profile: fields.profile },
    userId !== undefined ? { "x-grok-user-id": userId } : undefined,
  );
  return {
    id: fields.id,
    provider: GROK_RESPONSES_PROVIDER,
    baseURL: XAI_BASE_URL,
    credentialId: fields.id,
    model: fields.model,
    defaults: { maxTokens: SOURCE_MAX_TOKENS, providerOptions },
  };
}

// Build the InferenceSource for a Bifrost virtual-key provider. Routes to the
// "bifrost" adapter (a thin openai-compatible wrapper) which injects the
// x-bf-vk sentinel header.
export function buildBifrostSource(fields: {
  id: string;
  baseURL: string;
  apiKey?: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
}): InferenceSource {
  const overrides =
    fields.reasoningEffort !== undefined
      ? { providerOptions: { reasoning_effort: fields.reasoningEffort } }
      : {};
  registerSourceSecret(fields.id, fields.apiKey);
  return {
    id: fields.id,
    provider: BIFROST_PROVIDER,
    baseURL: normalizeOpenAICompatibleBaseURL(fields.baseURL),
    credentialId: fields.id,
    model: fields.model,
    defaults: { maxTokens: SOURCE_MAX_TOKENS, ...overrides },
  };
}

// Anthropic Messages API (native anthropic provider in intx-inference).
export function buildAnthropicSource(fields: {
  id: string;
  baseURL: string;
  apiKey?: string;
  model: string;
}): InferenceSource {
  registerSourceSecret(fields.id, fields.apiKey);
  return {
    id: fields.id,
    provider: "anthropic",
    baseURL: fields.baseURL.replace(/\/+$/, ""),
    credentialId: fields.id,
    model: fields.model,
    defaults: { maxTokens: SOURCE_MAX_TOKENS },
  };
}

// OpenCode Go: per-model protocol routing (chat completions / responses /
// messages). sessionId feeds the Responses-protocol prompt_cache_key (see
// buildXaiSource).
export function buildGoSource(fields: {
  id: string;
  apiKey?: string;
  model: string;
  sessionId: string;
  reasoningEffort?: ReasoningEffort;
}): InferenceSource {
  const endpoint = resolveGoEndpoint(fields.model);
  registerSourceSecret(fields.id, fields.apiKey);
  if (endpoint.adapter === "anthropic") {
    return {
      id: fields.id,
      provider: OPENCODE_GO_MESSAGES_PROVIDER,
      baseURL: endpoint.baseURL,
      credentialId: fields.id,
      model: fields.model,
      defaults: {
        maxTokens: SOURCE_MAX_TOKENS,
        providerOptions: {
          [OPENCODE_SESSION_ID_OPTION]: fields.sessionId,
        },
      },
    };
  }
  if (endpoint.adapter === "openai-responses") {
    return {
      id: fields.id,
      provider: OPENAI_RESPONSES_PROVIDER,
      baseURL: endpoint.baseURL,
      credentialId: fields.id,
      model: fields.model,
      defaults: {
        maxTokens: SOURCE_MAX_TOKENS,
        providerOptions: {
          [OPENAI_SESSION_ID_OPTION]: fields.sessionId,
          [OPENCODE_SESSION_ID_OPTION]: fields.sessionId,
        },
      },
    };
  }
  // chat-completions (default)
  const source = buildOpenAISource({
    id: fields.id,
    baseURL:
      endpoint.baseURL.length > 0 ? endpoint.baseURL : OPENCODE_GO_BASE_URL,
    ...(fields.apiKey !== undefined ? { apiKey: fields.apiKey } : {}),
    model: fields.model,
    ...(fields.reasoningEffort !== undefined
      ? { reasoningEffort: fields.reasoningEffort }
      : {}),
  });
  return {
    ...source,
    provider: OPENCODE_GO_PROVIDER_ID,
    defaults: {
      ...source.defaults,
      providerOptions: {
        ...(source.defaults?.providerOptions ?? {}),
        [OPENCODE_SESSION_ID_OPTION]: fields.sessionId,
      },
    },
  };
}

// OpenCode Zen: per-model protocol routing (chat completions / responses /
// messages). sessionId feeds the Responses-protocol prompt_cache_key (see
// buildXaiSource).
export function buildZenSource(fields: {
  id: string;
  apiKey?: string;
  model: string;
  sessionId: string;
  reasoningEffort?: ReasoningEffort;
}): InferenceSource {
  const endpoint = resolveZenEndpoint(fields.model);
  registerSourceSecret(fields.id, fields.apiKey);
  if (endpoint.adapter === "anthropic") {
    return {
      id: fields.id,
      provider: ZEN_MESSAGES_PROVIDER,
      baseURL: endpoint.baseURL,
      credentialId: fields.id,
      model: fields.model,
      defaults: {
        maxTokens: SOURCE_MAX_TOKENS,
        providerOptions: {
          [OPENCODE_SESSION_ID_OPTION]: fields.sessionId,
        },
      },
    };
  }
  if (endpoint.adapter === "openai-responses") {
    return {
      id: fields.id,
      provider: OPENAI_RESPONSES_PROVIDER,
      baseURL: endpoint.baseURL,
      credentialId: fields.id,
      model: fields.model,
      defaults: {
        maxTokens: SOURCE_MAX_TOKENS,
        providerOptions: {
          [OPENAI_SESSION_ID_OPTION]: fields.sessionId,
          [OPENCODE_SESSION_ID_OPTION]: fields.sessionId,
        },
      },
    };
  }
  // chat-completions (default)
  const source = buildOpenAISource({
    id: fields.id,
    baseURL:
      endpoint.baseURL.length > 0 ? endpoint.baseURL : ZEN_DEFAULT_BASE_URL,
    ...(fields.apiKey !== undefined ? { apiKey: fields.apiKey } : {}),
    model: fields.model,
    ...(fields.reasoningEffort !== undefined
      ? { reasoningEffort: fields.reasoningEffort }
      : {}),
  });
  return {
    ...source,
    defaults: {
      ...source.defaults,
      providerOptions: {
        ...(source.defaults?.providerOptions ?? {}),
        [OPENCODE_SESSION_ID_OPTION]: fields.sessionId,
      },
    },
  };
}

export interface Config {
  configured: true;
  apiKey: string;
  baseURL: string;
  model: string;
  providerName: string;
  keyless?: boolean;
  // False when the active provider's credential was persisted without a
  // passing connection test (see ProviderSettings.verified).
  verified?: boolean;
  cwd: string;
  task: string;
  dangerouslySkipPermissions: boolean;
  // Experimental prompt shrink after an Anthropic cache expiry. Off unless
  // settings set anthropicCachePrompt.
  anthropicCachePrompt: boolean;
  // True when dangerouslySkipPermissions came from the settings source rather
  // than this invocation's CLI flag; entry points use it to surface a startup
  // notice, since the persisted value is otherwise silent.
  skipPermissionsFromSettings: boolean;
  auto: boolean;
  /**
   * Exec-only chosen primary director. Omitted = dispatch (product default).
   * `--director` is rejected in TUI mode.
   */
  director?: DirectorId;
  /**
   * Entry mode. `"tui"` is the interactive Ink shell; `"exec"` is the
   * non-TUI product agent path (`corbits exec "prompt"`). Same
   * directors/tools/permissions.
   */
  command: "tui" | "exec";
  /** Active settings source, including an explicit --config path. */
  globalSettingsPath: string;
  globalDefaultProvider?: string;
  // Every provider available to switch to at runtime. From the settings file
  // when present; env-only mode has just the single resolved provider.
  providers: ProviderCatalogEntry[];
  profile?: string;
  systemPromptExtensions?: string[];
  // Guideline sub-block ids to drop from the chat system prompt (see
  // GUIDELINE_SUB_BLOCK_IDS in agent/prompts.ts); omitted = full guidelines.
  promptSectionOmit?: GuidelineSubBlockId[];
  // Per-call inactivity timeout in ms (default 120_000 in the harness). Tune
  // higher for reasoning models with long silent-thinking stretches.
  inactivityTimeoutMs?: number;
  // Per-call total wall-clock cap in ms (default 600_000 in the harness).
  totalTimeoutMs?: number;
  // Per-call wall-clock cap for the compaction summary call in ms (default
  // 90_000 in the summarizer).
  summarizerTimeoutMs?: number;
  reasoningEffort?: ReasoningEffort;
  mcpServers?: ResolvedMCPServerConfig[];
  /** Local project MCP lists replace global lists and require project trust. */
  mcpServersSource?: "local" | "global" | "none";
  /** Unexpanded owning list. Empty with source `"none"` means no list (builtin may inject). */
  mcpServerEntries: MCPServerSettingsEntry[];
  sessionId: string;
  /** When true, runTUI shows a session picker first (resume flow). */
  resumePicker?: boolean;
  /** When true, the TUI does not auto-send `task` on mount (resumed session). */
  skipInitialTask?: boolean;
  /**
   * How this process was asked to resume. `"id"` continues an explicit session
   * id; `"pick"` opens the interactive picker. Omitted for a fresh session.
   */
  resumeMode?: "id" | "pick";
  /**
   * True when this invocation passed --provider and/or --model. Resume keeps
   * the stored session's model unless this is set; the override is a
   * parse-time fact, never inferred by comparing launch values against the
   * stored record.
   */
  modelOverride?: boolean;

  // Deprecated no-op retained for CLI compatibility.
  noWorkflow: boolean;
  /**
   * Runtime settings view for provider resolution, including OAuth
   * projections never written to settings.json. Not for saveGlobalSettings —
   * rebuild with providerCatalogToSettings (or re-read disk) first.
   */
  settings?: Settings;
  /**
   * Fail-open diagnostics from local settings load (unknown keys, invalid
   * JSON, stripped credentials); shown so startup never hard-crashes.
   */
  settingsDiagnostics?: SettingsLoadDiagnostic[];
}

// Returned by loadConfig when no provider is configured and allowUnconfigured
// is true. Carries enough context for the TUI to launch the onboarding flow
// instead of exiting. Headless callers must treat this as a fatal error.
export interface UnconfiguredConfig {
  configured: false;
  cwd: string;
  task: string;
  dangerouslySkipPermissions: boolean;
  skipPermissionsFromSettings: boolean;
  auto: boolean;
  command: "tui" | "exec";
  /** Exec-only chosen primary. Omitted on the unconfigured path too. */
  director?: DirectorId;
  /** Validated appearance preference needed before first-run surfaces mount. */
  theme?: Settings["theme"];
  // Path where the onboarding flow should write the new settings.
  globalSettingsPath: string;
  /** Original CLI path, present only when --config selected the write target. */
  cliConfigPath?: string;
  /** Whether the caller requested an OAuth-isolated programmatic settings load. */
  programmaticSettingsPath: boolean;
  // The original error message, used for non-TUI (exec) error output.
  providerError: string;
  /**
   * Fail-open diagnostics from local settings load, threaded when provider
   * setup fails early so junk local files surface via stderr/banner.
   */
  settingsDiagnostics?: SettingsLoadDiagnostic[];
}

/** Printed for `corbits --help` / `-h`. Keep in sync with docs/IMPLEMENTATION.md. */
export const CLI_HELP_TEXT = `corbits — coding agent CLI

Usage:
  corbits [flags] [task...]
  corbits exec|run|-p [flags] <prompt>
  corbits resume|continue [session-id] [flags]

Continue verbs (project-keyed to this checkout's git toplevel):
  resume / continue           interactive session picker
  --resume [<session-id>]     interactive picker, or reopen a session; with exec/-p the id is required
  resume <session-id>         reopen a specific session in the TUI
  resume --pick / --list      interactive session picker
  exec --resume <session-id>  headless: continue that session and send <prompt>
  -p --resume <session-id>    same one-shot path as exec --resume

Flags:
  --cwd <dir>                 working directory (default: process.cwd())
  --config <path>             settings file (default: ~/.corbits/settings.json)
  --provider <name>           configured provider name
  --model <id>                model for the active provider
  --profile <name>            settings profile
  -p                          one-shot prompt (same as exec / run)
  --resume [<session-id>]     interactive picker, or reopen a session; with exec/-p the id is required
  --director <id>             exec-only: run as this director (default: dispatch)
  --dangerously-skip-permissions, --yolo
                               skip permission prompts for this process only (--yolo alias);
                               --auto --yolo uses yolo mode (catastrophic denials remain);
                               /yolo in the TUI persists the active settings file;
                               the default settings file is machine-wide;
                               --config selects another source
  --auto / --no-auto          auto mode on/off
  --help, -h                  show this help
  --version, -V               show version
`;

/**
 * Thrown when the operator asked for CLI help. Entry points must print
 * `message` to stdout and exit 0 — not treat this as a crash.
 */
export class CliHelpError extends Error {
  readonly exitCode = 0 as const;

  constructor(text: string = CLI_HELP_TEXT) {
    super(text);
    this.name = "CliHelpError";
  }
}

/** Printed for `corbits --version` / `-V`. Matches `package.json` version. */
export const CLI_VERSION_TEXT = `${COMMAND_NAME} v${
  typeof pkg.version === "string" ? pkg.version : "0.0.0"
}`;

/**
 * Thrown when the operator asked for the CLI version. Entry points must print
 * `message` to stdout and exit 0 — not treat this as a crash.
 */
export class CliVersionError extends Error {
  readonly exitCode = 0 as const;

  constructor(text: string = CLI_VERSION_TEXT) {
    super(text);
    this.name = "CliVersionError";
  }
}

/**
 * Thrown for a recoverable operator mistake. Entry points must print
 * `message` to stderr and exit 1 — not dump a stack.
 */
export class CliUserError extends Error {
  readonly exitCode = 1 as const;

  constructor(message: string) {
    super(message);
    this.name = "CliUserError";
  }
}

export interface LoadConfigOptions {
  // Override the default settings source (for tests / non-standard homes).
  globalSettingsPath?: string;
  // Override the home directory used for project-key session roots (tests).
  // Production callers leave this unset so sessions resolve under ~/.corbits.
  home?: string;
  // When true, a missing/unresolvable provider returns UnconfiguredConfig
  // instead of throwing; the TUI uses this to open onboarding rather than
  // exiting. Headless callers leave this false (the default).
  allowUnconfigured?: boolean;
  // Pricing metadata fetcher overrides. Tests must inject an offline fetchImpl
  // — the default hits models.dev for real, and a stray background fetch
  // inside the suite destabilizes timing-sensitive tests.
  pricing?: PricingFetcherOptions;
}

function isFlagToken(arg: string): boolean {
  return arg.startsWith("--") || arg === "-h" || arg === "-p" || arg === "-V";
}

export async function loadConfig(
  argv: readonly string[],
  options?: LoadConfigOptions & { allowUnconfigured?: false },
): Promise<Config>;
export async function loadConfig(
  argv: readonly string[],
  options: LoadConfigOptions & { allowUnconfigured: true },
): Promise<Config | UnconfiguredConfig>;
export async function loadConfig(
  argv: readonly string[],
  options: LoadConfigOptions = {},
): Promise<Config | UnconfiguredConfig> {
  // Help wins in any position, including after subcommands and immediately
  // after a value flag that would otherwise swallow the token as its value.
  if (argv.some((arg) => arg === "--help" || arg === "-h")) {
    throw new CliHelpError();
  }
  if (argv.some((arg) => arg === "--version" || arg === "-V")) {
    throw new CliVersionError();
  }

  const args = [...argv];

  // Leading subcommand: `corbits exec "prompt"` (alias: `run`). Default is TUI.
  // `corbits resume` / `continue` reopen a prior session for this project key
  // (this checkout's git toplevel — see docs/IMPLEMENTATION.md).
  let command: "tui" | "exec" = "tui";
  let resumeMode: "id" | "pick" | undefined;
  let resumeSessionId: string | undefined;
  const leading = args[0];
  if (leading === "exec" || leading === "run") {
    command = "exec";
    args.shift();
  } else if (leading === "resume" || leading === "continue") {
    command = "tui";
    args.shift();
    // Bare resume opens the list; a session id is the only direct-resume path.
    // Invalid non-flag positionals error instead of falling through (a
    // free-form token would otherwise become task while skipInitialTask is set).
    const next = args.slice()[0];
    if (next === "--pick" || next === "--list") {
      resumeMode = "pick";
      args.shift();
    } else if (next !== undefined && !isFlagToken(next)) {
      if (!isSessionId(next)) {
        throw new Error(
          `'${next}' is not a session id. Use a UUID session id or \`corbits resume\` to choose.`,
        );
      }
      resumeMode = "id";
      resumeSessionId = next;
      args.shift();
    } else {
      resumeMode = "pick";
    }
  }

  // `-p` is the exec one-shot path in any position (`-p --provider …`,
  // `--model … -p …`). Detect it before value flags so exec-only options
  // that appear before `-p` still see exec mode.
  if (args.includes("-p")) {
    if (leading === "resume" || leading === "continue") {
      throw new Error(
        `cannot combine resume with -p; use \`${COMMAND_NAME} -p --resume <session-id>\` to continue a session headlessly`,
      );
    }
    command = "exec";
  }

  let cwd = process.cwd();
  let dangerouslySkipPermissions = false;
  // Auto mode: non-destructive consequential actions (file writes/edits,
  // unconstrained shell) run unprompted; shell file-mutation stays denied and
  // installs / recursive rm / worktree / sensitive-path / opaque-wrapper
  // shell still ask. --no-auto reverts to ask-on-every-write; no in-session
  // key toggles auto (Shift+Tab cycles reasoning effort instead).
  let auto = true;
  let director: DirectorId | undefined;
  let configPath: string | undefined;
  let provider: string | undefined;
  let model: string | undefined;
  let profileFlag: string | undefined;
  let noWorkflow = false;
  const positional: string[] = [];

  const requireValue = (flag: string, value: string | undefined): string => {
    // Flag-shaped tokens are never option values. `--provider --auto` and a
    // trailing `--provider` both surface as a missing value rather than binding
    // the next flag (or accepting `--help`, which is already handled above).
    if (value === undefined || isFlagToken(value)) {
      throw new Error(`${flag} requires a value`);
    }
    return value;
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--cwd") {
      cwd = resolve(requireValue("--cwd", args[++i]));
      continue;
    }
    if (arg === "--config") {
      configPath = resolve(requireValue("--config", args[++i]));
      continue;
    }
    if (arg === "--provider") {
      provider = requireValue("--provider", args[++i]);
      continue;
    }
    if (arg === "--model") {
      model = requireValue("--model", args[++i]);
      continue;
    }
    if (arg === "--profile") {
      profileFlag = requireValue("--profile", args[++i]);
      continue;
    }
    if (arg === "--director") {
      const value = requireValue("--director", args[++i]);
      if (command !== "exec") {
        throw new Error("--director is only available in exec mode");
      }
      if (!isDirectorId(value)) {
        throw new Error(
          `Unknown director "${value}". Use one of: ${DIRECTOR_IDS.join(", ")}.`,
        );
      }
      director = value;
      continue;
    }

    if (arg === "--dangerously-skip-permissions" || arg === "--yolo") {
      dangerouslySkipPermissions = true;
      continue;
    }
    if (arg === "--auto") {
      auto = true;
      continue;
    }
    if (arg === "--no-auto") {
      auto = false;
      continue;
    }
    if (arg === "--no-workflow") {
      noWorkflow = true;
      continue;
    }
    if (arg === "-p") {
      command = "exec";
      continue;
    }
    if (arg === "--resume") {
      if (resumeMode === "id") {
        throw new Error("cannot combine a session id with --resume");
      }
      // Optional session id on the interactive path: `corbits --resume <uuid>`
      // reopens that session (alias for `corbits resume <uuid>`); bare
      // `--resume` opens the picker. Exec / `-p` require the id — headless has
      // no picker. A non-id token errors instead of leaking into task text.
      const next = args[i + 1];
      if (next !== undefined && !isFlagToken(next)) {
        if (!isSessionId(next)) {
          throw new Error(
            `'${next}' is not a session id. Use a UUID session id or \`corbits resume\` to choose.`,
          );
        }
        resumeMode = "id";
        resumeSessionId = next;
        i++;
      } else if (command === "exec") {
        throw new Error(
          `--resume requires a session id in exec mode. Use \`${COMMAND_NAME} resume\` to choose a session.`,
        );
      } else {
        resumeMode = "pick";
      }
      continue;
    }
    if ((arg === "--pick" || arg === "--list") && resumeMode !== undefined) {
      if (resumeMode === "id") {
        throw new Error("cannot combine a session id with --pick/--list");
      }
      resumeMode = "pick";
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`unrecognized flag: ${arg}`);
    }
    positional.push(arg);
  }

  const pricingCachePath = defaultPricingCachePath();

  await bootstrapPricingMetadata({
    cachePath: pricingCachePath,
    ...options.pricing,
  });

  // Resolve both settings targets from the same active source. The local schema
  // must never be read from or written to the active global-schema target.
  const effectiveSettingsPath =
    configPath ?? options.globalSettingsPath ?? globalSettingsPath();
  const localSettingsFile = resolveLocalSettingsPath(
    cwd,
    effectiveSettingsPath,
  );

  // OAuth profiles live in home-level auth stores (~/.corbits/codex-auth.json,
  // xai-auth.json), separate from settings.json. --config only overrides where
  // provider *definitions* come from, so OAuth profiles must still merge in or
  // every codex/xai OAuth run through --config reaches the provider
  // unauthenticated. Only the programmatic `globalSettingsPath` test override
  // (never a CLI flag) opts out — tests want no home-directory reads.
  const useOAuthProfiles = options.globalSettingsPath === undefined;
  const [codexProfiles, xaiProfiles]: [CodexProfile[], XaiProfile[]] =
    useOAuthProfiles
      ? await Promise.all([listCodexProfiles(), listXaiProfiles()])
      : [[], []];
  let projectedOAuthProviders = {
    ...codexProvidersAsSettings(codexProfiles),
    ...xaiProvidersAsSettings(xaiProfiles),
  };
  const settings =
    configPath !== undefined
      ? await loadSettingsRecoveringClobberedOAuthSelection(
          configPath,
          projectedOAuthProviders,
          {
            persist: false,
          },
        ).then((s) => {
          if (s === null)
            throw new Error(`--config file not found or empty: ${configPath}`);
          return s;
        })
      : await loadSettingsRecoveringClobberedOAuthSelection(
          effectiveSettingsPath,
          projectedOAuthProviders,
          { persist: true },
        );

  // True when the value came from settings, not this invocation's
  // --dangerously-skip-permissions flag (Config.skipPermissionsFromSettings).
  const skipPermissionsFromSettings =
    !dangerouslySkipPermissions &&
    settings?.dangerouslySkipPermissions === true;
  dangerouslySkipPermissions =
    dangerouslySkipPermissions || settings?.dangerouslySkipPermissions === true;
  projectedOAuthProviders = applyPersistedOAuthDefaults(
    settings,
    projectedOAuthProviders,
  );
  const liveSettings = useOAuthProfiles
    ? dropOrphanedOAuthEntries(settings, projectedOAuthProviders)
    : settings;
  const settingsForResolution: Settings | null = overlayOAuthProjections(
    liveSettings,
    projectedOAuthProviders,
  );

  // The per-repo selection file still applies on top of --config: that file
  // supplies provider definitions, .corbits/settings.json supplies the
  // provider/model selection; CLI --provider/--model override both. Fail open
  // on unknown/invalid local keys — never crash startup.
  const localResult =
    localSettingsFile === null
      ? { settings: null, diagnostics: [] }
      : await loadLocalSettingsResult(localSettingsFile);
  const local = localResult.settings;
  const settingsDiagnostics = localResult.diagnostics;

  const profile = await resolveProfile(cwd, profileFlag);

  // Apply profile as a fallback layer: profile.model fills in when neither CLI
  // nor local settings specify a model. This sits below local in precedence.
  const effectiveLocal =
    local !== null
      ? local
      : profile.model !== undefined
        ? { model: profile.model }
        : null;
  const profileLocal =
    local !== null && local.model === undefined && profile.model !== undefined
      ? { ...local, model: profile.model }
      : effectiveLocal;

  const cli: { provider?: string; model?: string } = {};
  if (provider !== undefined) cli.provider = provider;
  if (model !== undefined) cli.model = model;

  const task = positional.join(" ").trim();

  let resolved: ResolvedProvider;
  try {
    resolved = resolveProvider({
      settings: settingsForResolution,
      local: profileLocal,
      cli,
    });
  } catch (err) {
    if (!options.allowUnconfigured) throw err;
    return {
      configured: false,
      cwd,
      task,
      dangerouslySkipPermissions,
      skipPermissionsFromSettings,
      auto,
      command,
      ...(director !== undefined ? { director } : {}),
      ...(settingsForResolution?.theme !== undefined
        ? { theme: settingsForResolution.theme }
        : {}),
      globalSettingsPath: effectiveSettingsPath,
      ...(configPath !== undefined ? { cliConfigPath: configPath } : {}),
      programmaticSettingsPath: options.globalSettingsPath !== undefined,
      providerError: err instanceof Error ? err.message : String(err),
      // Keep diagnostics when provider setup fails early so junk local files
      // reach stderr (exec) / banner (TUI after onboarding).
      ...(settingsDiagnostics.length > 0 ? { settingsDiagnostics } : {}),
    };
  }

  setProviderContextWindowOverrides(
    buildProviderContextWindowOverrides(
      settingsForResolution?.providers ?? {},
      resolved.providerName,
      resolved.model,
    ),
  );

  const providers = mergeOAuthCatalog(
    settings,
    resolved,
    codexProfiles,
    xaiProfiles,
  );
  const reasoning = customReasoningSettings(
    resolved.providerName,
    settingsForResolution?.providers[resolved.providerName],
    providers.find((entry) => entry.name === resolved.providerName),
  );
  // Enforce model/effort compatibility at the boundary. The modal only offers
  // supported levels, but a hand-edited local file can pair an effort with a
  // model that rejects it; reject here rather than shipping an effort the
  // model will refuse.
  if (local?.reasoningEffort !== undefined) {
    const verdict = validateEffort(
      resolved.model,
      local.reasoningEffort,
      isCodexProviderName(resolved.providerName),
      reasoning?.reasoningEfforts,
    );
    if (!verdict.ok) {
      throw new Error(
        `Invalid reasoningEffort in local settings: ${verdict.error}`,
      );
    }
  }

  // Resume resolution: project-key sessions live under
  // ~/.corbits/projects/<key>/, keyed to this checkout's git toplevel (linked
  // worktrees do not share lists).
  let sessionId = generateSessionId();
  let skipInitialTask = false;
  let resumePicker = false;
  let resumeTask = task;
  if (resumeMode === "pick") {
    resumePicker = true;
    skipInitialTask = true;
  } else if (resumeMode === "id") {
    const id = resumeSessionId;
    if (id === undefined) {
      throw new Error("resume by id requires a session id");
    }
    await migrateLegacySessionIfNeeded(cwd, id, options.home);
    const loaded = await loadState(cwd, id, options.home);
    if (loaded.kind === "unreadable") {
      throw new CliUserError(
        `Session ${id} is unreadable. Use \`${COMMAND_NAME} resume\` to choose another.`,
      );
    }
    if (loaded.kind === "missing") {
      throw new Error(
        `No session ${id} for this project. Sessions are stored under ~/.corbits/projects/<project-key>/ (this checkout's git toplevel). Use \`${COMMAND_NAME} resume\` to choose one.`,
      );
    }
    const state = loaded.state;
    sessionId = id;
    // The TUI reopens without auto-sending. Exec must send the new prompt
    // on this session and must not substitute the stored task.
    if (command !== "exec") {
      skipInitialTask = true;
      if (task.length === 0) resumeTask = state.task;
    }
  }

  return {
    configured: true,
    ...resolved,
    cwd,
    task: resumeTask,
    dangerouslySkipPermissions,
    anthropicCachePrompt: settings?.anthropicCachePrompt === true,
    skipPermissionsFromSettings,
    auto,
    command,
    ...(director !== undefined ? { director } : {}),
    globalSettingsPath: effectiveSettingsPath,
    sessionId,
    noWorkflow,
    ...(resumeMode !== undefined
      ? {
          resumeMode,
          ...(skipInitialTask ? { skipInitialTask: true } : {}),
        }
      : {}),
    ...(resumePicker ? { resumePicker: true } : {}),
    ...(provider !== undefined || model !== undefined
      ? { modelOverride: true as const }
      : {}),
    ...(settings?.defaultProvider !== undefined
      ? { globalDefaultProvider: settings.defaultProvider }
      : {}),
    providers,
    ...(profile.profile !== undefined ? { profile: profile.profile } : {}),
    ...(profile.systemPromptExtensions !== undefined
      ? { systemPromptExtensions: profile.systemPromptExtensions }
      : {}),
    ...(profile.promptSectionOmit !== undefined
      ? { promptSectionOmit: profile.promptSectionOmit }
      : {}),
    ...(profile.inactivityTimeoutMs !== undefined
      ? { inactivityTimeoutMs: profile.inactivityTimeoutMs }
      : {}),
    ...(profile.totalTimeoutMs !== undefined
      ? { totalTimeoutMs: profile.totalTimeoutMs }
      : {}),
    ...(profile.summarizerTimeoutMs !== undefined
      ? { summarizerTimeoutMs: profile.summarizerTimeoutMs }
      : {}),
    ...(local?.reasoningEffort !== undefined
      ? { reasoningEffort: local.reasoningEffort }
      : {}),
    ...(local?.mcpServers !== undefined
      ? {
          mcpServers: resolveMcpServers(settings?.mcpServers, local.mcpServers),
          mcpServersSource: "local" as const,
          mcpServerEntries: local.mcpServers,
        }
      : settings?.mcpServers !== undefined
        ? {
            mcpServers: resolveMcpServers(settings.mcpServers, undefined),
            mcpServersSource: "global" as const,
            mcpServerEntries: settings.mcpServers,
          }
        : {
            mcpServers: resolveMcpServers(undefined, undefined),
            mcpServersSource: "none" as const,
            mcpServerEntries: [],
          }),
    // Runtime view includes OAuth projections so inference resolution can see
    // providers never written to settings.json; not safe to persist as-is
    // (use providerCatalogToSettings or re-read disk).
    ...(settingsForResolution !== null
      ? { settings: settingsForResolution }
      : {}),
    ...(settingsDiagnostics.length > 0 ? { settingsDiagnostics } : {}),
  };
}

// Settings-file providers plus Codex/xAI OAuth profile-store entries, merged
// the way loadConfig assembles Config.providers. Exposed so a live provider
// connect (mid-session, no restart) can rebuild the picker's catalog after
// writing new credentials.
//
// Rebuild-only convergence: every rebuild derives rows from the current
// settings file plus the live stores, so a provider without a credential is
// rebuilt without one and re-auth restores it on the next rebuild. Settings
// rows pass through verbatim and are never deleted — except the legacy bare
// `codex`/`xai` dedupe below. A dedicated disabled flag was rejected: no
// removal event drives a refresh (no logout/disconnect surface or auth-store
// watcher).
//
// Bare-row dedupe compares the settings baseURL with the OAuth endpoint so a
// proxy/mirror row is never mistaken for the legacy duplicate; normalization
// failures fall back to a trailing-slash-insensitive compare.
function sameEndpoint(raw: string | undefined, oauthBaseURL: string): boolean {
  if (raw === undefined) return false;
  const normalized = (value: string): string => {
    try {
      return normalizeOpenAICompatibleBaseURL(value);
    } catch {
      return value.trim().replace(/\/+$/, "");
    }
  };
  return normalized(raw) === normalized(oauthBaseURL);
}
export function mergeOAuthCatalog(
  settings: Settings | null,
  resolved: ResolvedProvider,
  codexProfiles: readonly CodexProfile[],
  xaiProfiles: readonly XaiProfile[],
): ProviderCatalogEntry[] {
  const codexEntries = codexProfilesToCatalogEntries(codexProfiles);
  const xaiEntries = xaiProfilesToCatalogEntries(xaiProfiles);
  // Legacy bare `codex`/`xai` row (the original single-instance connect key)
  // next to live credential-backed `<kind>/<profile>` entries reads as a
  // second provider. Drop it once that family has a live profile; when
  // nothing is connected the bare row is the only ChatGPT/Grok access and
  // stays. A bare row at a different endpoint is a distinct provider (see
  // sameEndpoint), so it stays too.
  const dropBare = new Set([
    ...(codexEntries.length > 0 &&
    sameEndpoint(settings?.providers["codex"]?.baseURL, CODEX_BASE_URL)
      ? ["codex"]
      : []),
    ...(xaiEntries.length > 0 &&
    sameEndpoint(settings?.providers["xai"]?.baseURL, XAI_BASE_URL)
      ? ["xai"]
      : []),
  ]);
  const settingsRows = buildProviderCatalog(settings, resolved);
  // A hand-named codex/<slug> or xai/<slug> API-key row is explicit config,
  // not an OAuth placeholder (see isHandNamedProviderEntry): keep it and skip
  // the colliding live profile projection. buildProviderCatalog
  // synthesizes a [resolved] row when settings is null/empty, and when
  // resolved is itself codex/<slug> that row carries the live apiKey with no
  // profile marker — treating it as hand-named would eject the real marked
  // entry for a stale token snapshot.
  const handNamed = new Set(
    Object.entries(settings?.providers ?? {})
      .filter(
        ([name, provider]) =>
          (isCodexProviderName(name) || isXaiProviderName(name)) &&
          isHandNamedProviderEntry(provider),
      )
      .map(([name]) => name),
  );
  return [
    ...settingsRows.filter(
      (e) =>
        handNamed.has(e.name) ||
        (!isCodexProviderName(e.name) &&
          !isXaiProviderName(e.name) &&
          !dropBare.has(e.name)),
    ),
    ...codexEntries.filter((e) => !handNamed.has(e.name)),
    ...xaiEntries.filter((e) => !handNamed.has(e.name)),
  ].map((entry) =>
    isOpenCodeGoProvider(entry)
      ? { ...entry, models: [...selectableGoModelIds()] }
      : isZenProvider(entry)
        ? { ...entry, models: [...selectableZenModelIds()] }
        : entry,
  );
}

/** Rescans home-level Codex/xAI credential stores and rebuilds the live provider catalog. */
export async function refreshLiveProviderCatalog(
  settings: Settings | null,
  resolved: ResolvedProvider,
  liveSelection?: () => Pick<ResolvedProvider, "providerName" | "model">,
): Promise<ProviderCatalogEntry[]> {
  const [codexProfiles, xaiProfiles] = await Promise.all([
    listCodexProfiles(),
    listXaiProfiles(),
  ]);
  const catalog = mergeOAuthCatalog(
    settings,
    resolved,
    codexProfiles,
    xaiProfiles,
  );
  // Discovery can finish after a model switch; never restore its old bare-model slot.
  const active = liveSelection?.() ?? resolved;
  refreshProviderContextWindows(
    settings ?? undefined,
    catalog,
    active.providerName,
    active.model,
  );
  return catalog;
}

export function refreshProviderContextWindows(
  settings: Settings | undefined,
  catalog: readonly ProviderCatalogEntry[],
  activeProvider: string,
  activeModel: string,
): void {
  // Catalog models can expand during discovery. OAuth projections deliberately
  // omit settings-only window overrides, just as startup resolution does.
  const providers = Object.fromEntries(
    catalog.map((entry) => {
      const window =
        entry.codexProfile === undefined && entry.xaiProfile === undefined
          ? settings?.providers[entry.name]?.contextWindow
          : undefined;
      return [
        entry.name,
        {
          models: entry.models,
          ...(window !== undefined ? { contextWindow: window } : {}),
        },
      ];
    }),
  );
  setProviderContextWindowOverrides(
    buildProviderContextWindowOverrides(providers, activeProvider, activeModel),
  );
}

export function catalogEntryAsProviderSettings(
  entry: ProviderCatalogEntry,
): ProviderSettings {
  // Anthropic and Go anthropic-protocol bases must not be forced through the
  // OpenAI-compatible normalizer (which assumes a /v1 chat-completions root);
  // Go identity is flag, known provider id, or Go baseURL — always force the
  // subscription base.
  const go = isOpenCodeGoProvider(entry);
  const baseURL =
    entry.anthropic === true || go
      ? (go ? OPENCODE_GO_BASE_URL : entry.baseURL).replace(/\/+$/, "")
      : normalizeOpenAICompatibleBaseURL(entry.baseURL);
  return {
    baseURL,
    ...(entry.keyless === true ? { keyless: true } : {}),
    ...(entry.apiKey !== undefined && entry.apiKey.length > 0
      ? { apiKey: entry.apiKey }
      : {}),
    models: entry.models,
    ...(entry.defaultModel !== undefined
      ? { defaultModel: entry.defaultModel }
      : {}),
    ...(entry.free !== undefined ? { free: entry.free } : {}),
    ...(entry.maxTokens !== undefined ? { maxTokens: entry.maxTokens } : {}),
    ...(entry.temperature !== undefined
      ? { temperature: entry.temperature }
      : {}),
    ...(entry.topP !== undefined ? { topP: entry.topP } : {}),
    ...(entry.bifrostVirtualKey === true ? { bifrostVirtualKey: true } : {}),
    ...(entry.anthropic === true ? { anthropic: true } : {}),
    ...(go ? { opencodeGo: true } : {}),
    ...(entry.verified === false ? { verified: false } : {}),
    ...(entry.reasoningEfforts !== undefined &&
    entry.reasoningEfforts.length > 0
      ? { reasoningEfforts: entry.reasoningEfforts }
      : {}),
    ...(entry.defaultReasoningEffort !== undefined
      ? { defaultReasoningEffort: entry.defaultReasoningEffort }
      : {}),
  };
}

// Overlay the full live catalog (including OAuth profiles) onto settings for
// runtime provider resolution. OAuth credentials live in home auth stores,
// stripped from settings.json; the catalog is the source of truth for which
// OAuth providers are available now. Persist via providerCatalogToSettings.
export function runtimeSettingsWithCatalog(
  settings: Settings | undefined,
  catalog: readonly ProviderCatalogEntry[],
): Settings {
  const fromCatalog = Object.fromEntries(
    catalog.map((entry): [string, ProviderSettings] => [
      entry.name,
      catalogEntryAsProviderSettings(entry),
    ]),
  );
  if (settings === undefined) {
    return { providers: fromCatalog };
  }
  // OAuth-marked catalog rows carry live profile tokens; they overlay
  // credential-less placeholders but never a hand-named API-key row.
  const overlaid = Object.fromEntries(
    Object.entries(fromCatalog).filter(
      ([name]) =>
        (!isCodexProviderName(name) && !isXaiProviderName(name)) ||
        !isHandNamedProviderEntry(settings.providers[name]),
    ),
  );
  return {
    ...settings,
    providers: {
      ...settings.providers,
      ...overlaid,
    },
  };
}

// The providers the /agent modal can switch between. With a settings file its
// providers are the catalog; env-only mode has just the single resolved
// provider (the modal still renders; switching is a no-op against one entry).
export function buildProviderCatalog(
  settings: Settings | null,
  resolved: ResolvedProvider,
): ProviderCatalogEntry[] {
  if (settings !== null && Object.keys(settings.providers).length > 0) {
    return Object.entries(settings.providers).map(
      ([name, p]): ProviderCatalogEntry => {
        // Heal mis-seeded Go rows on load (rule in healOpenCodeGoProviders).
        const go = isOpenCodeGoProvider({
          name,
          ...(p.opencodeGo === true ? { opencodeGo: true as const } : {}),
          baseURL: p.baseURL,
        });
        return {
          name,
          baseURL: go
            ? OPENCODE_GO_BASE_URL
            : p.anthropic === true
              ? p.baseURL.replace(/\/+$/, "")
              : normalizeOpenAICompatibleBaseURL(p.baseURL),
          ...(p.keyless === true ? { keyless: true } : {}),
          ...(p.apiKey !== undefined && p.apiKey.length > 0
            ? { apiKey: p.apiKey }
            : {}),
          models: p.models,
          ...(p.defaultModel !== undefined
            ? { defaultModel: p.defaultModel }
            : {}),
          ...(p.free !== undefined ? { free: p.free } : {}),
          ...(p.maxTokens !== undefined ? { maxTokens: p.maxTokens } : {}),
          ...(p.temperature !== undefined
            ? { temperature: p.temperature }
            : {}),
          ...(p.topP !== undefined ? { topP: p.topP } : {}),
          ...(p.bifrostVirtualKey === true ? { bifrostVirtualKey: true } : {}),
          ...(p.anthropic === true ? { anthropic: true } : {}),
          ...(go ? { opencodeGo: true } : {}),
          ...(p.verified === false ? { verified: false } : {}),
          ...(p.reasoningEfforts !== undefined && p.reasoningEfforts.length > 0
            ? { reasoningEfforts: p.reasoningEfforts }
            : {}),
          ...(p.defaultReasoningEffort !== undefined
            ? { defaultReasoningEffort: p.defaultReasoningEffort }
            : {}),
        };
      },
    );
  }
  return [
    {
      name: resolved.providerName,
      baseURL: resolved.baseURL,
      ...(resolved.keyless === true
        ? { keyless: true }
        : { apiKey: resolved.apiKey }),
      models: [resolved.model],
    },
  ];
}

export function providerCatalogToSettings(
  catalog: readonly ProviderCatalogEntry[],
  defaultProvider: string | undefined,
  existing?: Settings,
): Settings {
  // OAuth entries are credential-backed by home-level auth stores, not by
  // settings.json; exclude them so provider edits never persist short-lived
  // access tokens into the settings file.
  const persistable = catalog.filter(
    (p) => p.codexProfile === undefined && p.xaiProfile === undefined,
  );
  const providers = Object.fromEntries(
    persistable.map((p): [string, ProviderSettings] => [
      p.name,
      catalogEntryAsProviderSettings(p),
    ]),
  );
  // Spread the full existing settings so provider saves never drop plugins,
  // pluginPaths, shell, tools, or other unknown keys — only the catalog and
  // defaultProvider are replaced.
  if (existing === undefined) {
    return {
      ...(defaultProvider !== undefined ? { defaultProvider } : {}),
      providers,
    };
  }
  const {
    providers: _dropProviders,
    defaultProvider: _dropDefault,
    ...rest
  } = existing;
  return {
    ...rest,
    ...(defaultProvider !== undefined ? { defaultProvider } : {}),
    providers,
  };
}
