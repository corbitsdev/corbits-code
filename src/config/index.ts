import { resolve } from "node:path";

import type { InferenceSource } from "@intx/types/runtime";
import { generateSessionId, isSessionId, migrateLegacySessionIfNeeded } from "../session/index.js";
import { loadState } from "../session/state.js";

import { isDirectorId } from "../agent/directors/registry.js";
import { DIRECTOR_IDS, type DirectorId } from "../agent/directors/types.js";
import { validateEffort, type ReasoningEffort } from "../provider/reasoning-effort.js";
import { bootstrapPricingMetadata } from "../cost/pricing-metadata.js";
import { defaultPricingCachePath, type PricingFetcherOptions } from "../cost/pricing-fetcher.js";
import { listCodexProfiles, type CodexProfile } from "../auth/codex/store.js";
import { listXaiProfiles, type XaiProfile } from "../auth/xai/store.js";
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

export { fetchBifrostModels };
import { CODEX_BASE_URL } from "../auth/codex/constants.js";
import { XAI_BASE_URL } from "../auth/xai/constants.js";
import {
  CODEX_RESPONSES_PROVIDER,
  CODEX_ACCOUNT_ID_OPTION,
  CODEX_SESSION_ID_OPTION,
} from "../provider/codex-responses-adapter.js";
import {
  GROK_RESPONSES_PROVIDER,
  GROK_SESSION_ID_OPTION,
  GROK_USER_ID_OPTION,
} from "../provider/grok-responses-adapter.js";
import { BIFROST_PROVIDER } from "../provider/bifrost-adapter.js";
import {
  OPENAI_RESPONSES_PROVIDER,
  OPENAI_SESSION_ID_OPTION,
} from "../provider/openai-responses-adapter.js";
import { xaiUserIdFromAccessToken } from "../auth/xai/session.js";
import {
  OPENCODE_GO_BASE_URL,
  isOpenCodeGoProvider,
  resolveGoEndpoint,
} from "../../packages/opencode-go/src/index.js";

import {
  globalSettingsPath,
  loadLocalSettingsResult,
  type SettingsLoadDiagnostic,
  loadSettingsRecoveringClobberedOAuthSelection,
  resolveLocalSettingsPath,
  normalizeOpenAICompatibleBaseURL,
  resolveProvider,
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

// The per-call token ceiling for the inference source. Lives here so agent
// creation (runner.ts) and live provider switching (the /agent
// modal) all build the source the same way and a live switch can never silently
// revert the ceiling.
export const SOURCE_MAX_TOKENS = 16384;

// Placeholder sent in the Authorization header for keyless local providers
// (e.g. Ollama). The runtime's InferenceSource type requires a non-empty
// apiKey string; the value is injected as `Bearer <key>` by the harness but
// keyless servers ignore it entirely.
export const KEYLESS_API_KEY = "keyless";

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

function hasExaEntry(servers: MCPServerSettingsEntry[] | undefined): boolean {
  return servers?.some((server) => server.name === EXA_MCP_SERVER_NAME) === true;
}

function globalExaSuppressesBuiltin(servers: MCPServerSettingsEntry[] | undefined): boolean {
  return (
    servers?.some(
      (server) =>
        server.name === EXA_MCP_SERVER_NAME && (!("enabled" in server) || !server.enabled),
    ) === true
  );
}

function expandMcpServers(servers: MCPServerSettingsEntry[]): ResolvedMCPServerConfig[] {
  return servers.flatMap((server) => {
    if (!("enabled" in server)) return [server];
    return server.enabled ? [createExaMCPServerConfig()] : [];
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
// user-facing name for this source (e.g. "zen"); `provider` is always
// "openai-compatible" so the inference registry routes it to the right adapter.
export function buildOpenAISource(fields: {
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
  return {
    id: fields.id,
    provider: "openai-compatible",
    baseURL: normalizeOpenAICompatibleBaseURL(fields.baseURL),
    apiKey:
      fields.apiKey !== undefined && fields.apiKey.length > 0 ? fields.apiKey : KEYLESS_API_KEY,
    model: fields.model,
    defaults: { maxTokens: SOURCE_MAX_TOKENS, ...overrides },
  };
}

// One configured provider the /agent modal can switch to. Carries credentials
// because live switching builds an InferenceSource from it; the modal only ever
// receives fields needed for provider management, never the key. Derived from
// ProviderSettings (the persisted record) so the field *set* stays tied to it:
// a newly required ProviderSettings field forces every catalog-entry literal
// to supply it. `name` becomes required (every catalog entry is resolved to a
// concrete provider id) and `contextWindow` is dropped (it is a settings-only
// override, never surfaced to the /agent modal). The OAuth-profile markers
// below have no ProviderSettings counterpart because such entries are never
// written to settings.json (their credentials live in the Codex/xAI auth
// stores). Optional fields still need the round-trip test in config.test.ts —
// TS does not flag a missing optional property against an explicitly-typed
// object literal, so forwarding of an optional field can only be caught at
// runtime.
export type ProviderCatalogEntry = Omit<ProviderSettings, "name" | "contextWindow"> & {
  name: string;
  // Set when this entry is a Codex OAuth profile rather than an API-key
  // provider. Holds the profile name; the send path uses it to refresh the
  // access token before each turn.
  codexProfile?: string;
  // ChatGPT account id for a Codex profile, sent as the chatgpt-account-id
  // header by the Responses adapter. Present only on Codex entries.
  codexAccountId?: string;
  // Set when this entry is an xAI/Grok OAuth profile. It still routes through
  // openai-compatible; the marker only controls token refresh and persistence.
  xaiProfile?: string;
  // When true this provider is backed by a Bifrost virtual key. Inference
  // sources for it are built with provider "bifrost" so the adapter can
  // inject the x-bf-vk header (in addition to Authorization). The flag is
  // also used to enable /models auto-discovery scoped to the key.
  bifrostVirtualKey?: boolean;
  // Anthropic Messages API (x-api-key). Used by first-class Anthropic and by
  // OpenCode Go models that speak the messages protocol.
  anthropic?: boolean;
  // OpenCode Go multi-protocol provider. Per-model routing picks
  // openai-compatible, openai-responses, or anthropic at source-build time.
  opencodeGo?: boolean;
  // False when this credential was persisted without a passing connection
  // test. See ProviderSettings.verified in settings.ts.
  verified?: boolean;
};

// Build the InferenceSource for a Codex OAuth profile. Routes to the
// "codex-responses" adapter (the Codex backend speaks the Responses API, not
// Chat Completions) and carries the account id + a session id through
// providerOptions, where the adapter lifts them into request headers. The
// access token is the apiKey; the harness injects it as the bearer credential.
export function buildCodexSource(fields: {
  id: string;
  apiKey: string;
  model: string;
  sessionId: string;
  accountId?: string;
  reasoningEffort?: ReasoningEffort;
}): InferenceSource {
  const providerOptions: Record<string, unknown> = { [CODEX_SESSION_ID_OPTION]: fields.sessionId };
  if (fields.accountId !== undefined) providerOptions[CODEX_ACCOUNT_ID_OPTION] = fields.accountId;
  if (fields.reasoningEffort !== undefined)
    providerOptions["reasoning_effort"] = fields.reasoningEffort;
  return {
    id: fields.id,
    provider: CODEX_RESPONSES_PROVIDER,
    baseURL: CODEX_BASE_URL,
    apiKey: fields.apiKey,
    model: fields.model,
    defaults: { maxTokens: SOURCE_MAX_TOKENS, providerOptions },
  };
}

// Build the InferenceSource for an xAI/Grok OAuth profile. Routes to the
// "grok-responses" adapter (the grok-cli proxy speaks the Responses API, not
// Chat Completions). The access token is the apiKey; the caller's user id is
// decoded from it and lifted into the x-grok-user-id header by the adapter.
// The session id becomes the request's prompt_cache_key so every call in the
// thread routes to the same cache shard (store:false has no other signal).
export function buildXaiSource(fields: {
  id: string;
  apiKey: string;
  model: string;
  sessionId: string;
  reasoningEffort?: ReasoningEffort;
}): InferenceSource {
  const userId = xaiUserIdFromAccessToken(fields.apiKey);
  const providerOptions: Record<string, unknown> = {
    [GROK_SESSION_ID_OPTION]: fields.sessionId,
  };
  if (userId !== undefined) providerOptions[GROK_USER_ID_OPTION] = userId;
  if (fields.reasoningEffort !== undefined)
    providerOptions["reasoning_effort"] = fields.reasoningEffort;
  return {
    id: fields.id,
    provider: GROK_RESPONSES_PROVIDER,
    baseURL: XAI_BASE_URL,
    apiKey: fields.apiKey,
    model: fields.model,
    defaults: { maxTokens: SOURCE_MAX_TOKENS, providerOptions },
  };
}

// Build the InferenceSource for a Bifrost virtual-key provider.
// Routes to the "bifrost" adapter (a thin wrapper around openai-compatible)
// which injects the x-bf-vk sentinel header.
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
  return {
    id: fields.id,
    provider: BIFROST_PROVIDER,
    baseURL: normalizeOpenAICompatibleBaseURL(fields.baseURL),
    apiKey:
      fields.apiKey !== undefined && fields.apiKey.length > 0 ? fields.apiKey : KEYLESS_API_KEY,
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
  return {
    id: fields.id,
    provider: "anthropic",
    baseURL: fields.baseURL.replace(/\/+$/, ""),
    apiKey:
      fields.apiKey !== undefined && fields.apiKey.length > 0 ? fields.apiKey : KEYLESS_API_KEY,
    model: fields.model,
    defaults: { maxTokens: SOURCE_MAX_TOKENS },
  };
}

// OpenCode Go: per-model protocol routing (chat completions / responses / messages).
// sessionId feeds the Responses-protocol prompt_cache_key (see buildXaiSource).
export function buildGoSource(fields: {
  id: string;
  apiKey?: string;
  model: string;
  sessionId?: string;
  reasoningEffort?: ReasoningEffort;
}): InferenceSource {
  const endpoint = resolveGoEndpoint(fields.model);
  const apiKey =
    fields.apiKey !== undefined && fields.apiKey.length > 0 ? fields.apiKey : KEYLESS_API_KEY;
  if (endpoint.adapter === "anthropic") {
    return buildAnthropicSource({
      id: fields.id,
      baseURL: endpoint.baseURL,
      apiKey,
      model: fields.model,
    });
  }
  if (endpoint.adapter === "openai-responses") {
    return {
      id: fields.id,
      provider: OPENAI_RESPONSES_PROVIDER,
      baseURL: endpoint.baseURL,
      apiKey,
      model: fields.model,
      defaults: {
        maxTokens: SOURCE_MAX_TOKENS,
        ...(fields.sessionId !== undefined
          ? { providerOptions: { [OPENAI_SESSION_ID_OPTION]: fields.sessionId } }
          : {}),
      },
    };
  }
  // chat-completions (default)
  return buildOpenAISource({
    id: fields.id,
    baseURL: endpoint.baseURL.length > 0 ? endpoint.baseURL : OPENCODE_GO_BASE_URL,
    apiKey,
    model: fields.model,
    ...(fields.reasoningEffort !== undefined ? { reasoningEffort: fields.reasoningEffort } : {}),
  });
}

export interface Config {
  configured: true;
  apiKey: string;
  baseURL: string;
  model: string;
  providerName: string;
  keyless?: boolean;
  // False when the active provider's credential was persisted without a
  // passing connection test. See ProviderSettings.verified in settings.ts.
  verified?: boolean;
  cwd: string;
  task: string;
  force: boolean;
  dangerouslySkipPermissions: boolean;
  // True when dangerouslySkipPermissions came from the persisted global
  // default rather than this invocation's CLI flag. Entry points use this to
  // surface a startup notice since the persisted default is otherwise silent.
  skipPermissionsFromSettings: boolean;
  auto: boolean;
  /**
   * Exec-only chosen primary director. Omitted = Skywalker (product default).
   * `--director` is rejected in TUI mode.
   */
  director?: DirectorId;
  /**
   * Entry mode. `"tui"` is the interactive Ink shell; `"exec"` is the non-TUI
   * product agent path (`corbits exec "prompt"`). Same directors/tools/permissions.
   */
  command: "tui" | "exec";
  globalSettingsPath: string;
  globalDefaultProvider?: string;
  // Every provider available to switch to at runtime. From the settings file
  // when present; in env-only mode it is just the single resolved provider.
  providers: ProviderCatalogEntry[];
  profile?: string;
  systemPromptExtensions?: string[];
  // Per-call inactivity timeout in ms (default 120_000 in the harness). Tune
  // higher for reasoning models with long silent-thinking stretches.
  inactivityTimeoutMs?: number;
  // Per-call total wall-clock cap in ms (default 600_000 in the harness).
  totalTimeoutMs?: number;
  reasoningEffort?: ReasoningEffort;
  mcpServers?: ResolvedMCPServerConfig[];
  /** Local project MCP lists replace global lists and require project trust. */
  mcpServersSource?: "local" | "global" | "none";
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

  // Deprecated workflow profile metadata; workflows are manual-only slash commands.
  workflow?: string;
  // Deprecated no-op retained for CLI compatibility.
  noWorkflow: boolean;
  /**
   * Runtime settings view for provider resolution. Includes OAuth provider
   * projections from the live catalog that are never written to settings.json.
   * Do not pass this object to saveGlobalSettings — rebuild with
   * providerCatalogToSettings (or re-read disk) before any persist.
   */
  settings?: Settings;
  /**
   * Fail-open diagnostics from local settings load (unknown keys, invalid JSON,
   * stripped credentials). Shown on the main TUI so startup never hard-crashes.
   */
  settingsDiagnostics?: SettingsLoadDiagnostic[];
}

// Returned by loadConfig when no provider is configured and allowUnconfigured is
// true. Carries enough context for the TUI to launch the onboarding flow instead
// of exiting. Headless callers must treat this as a fatal error.
export interface UnconfiguredConfig {
  configured: false;
  cwd: string;
  task: string;
  force: boolean;
  dangerouslySkipPermissions: boolean;
  skipPermissionsFromSettings: boolean;
  auto: boolean;
  command: "tui" | "exec";
  /** Exec-only chosen primary. Omitted on the unconfigured path too. */
  director?: DirectorId;
  // Path where the onboarding flow should write the new settings.
  globalSettingsPath: string;
  /** Original CLI path, present only when --config selected the write target. */
  cliConfigPath?: string;
  /** Whether the caller requested an OAuth-isolated programmatic settings load. */
  programmaticSettingsPath: boolean;
  // The original error message, used for non-TUI (exec) error output.
  providerError: string;
  /**
   * Fail-open diagnostics from local settings load. Still threaded on the
   * unconfigured path so junk local files surface via stderr/banner rather
   * than disappearing when provider setup fails early.
   */
  settingsDiagnostics?: SettingsLoadDiagnostic[];
}

/** Printed for `corbits --help` / `-h`. Keep in sync with docs/IMPLEMENTATION.md. */
export const CLI_HELP_TEXT = `corbits — coding agent CLI

Usage:
  corbits [flags] [task...]
  corbits exec|run [flags] <prompt>
  corbits resume|continue [session-id] [flags]

Continue verbs (project-keyed to this checkout's git toplevel):
  resume / continue           interactive session picker
  --resume                    interactive session picker
  resume <session-id>         reopen a specific session
  resume --pick / --list      interactive session picker

Flags:
  --cwd <dir>                 working directory (default: process.cwd())
  --config <path>             settings file (default: ~/.corbits/settings.json)
  --provider <name>           configured provider name
  --model <id>                model for the active provider
  --profile <name>            settings profile
  --resume                    interactive session picker
  --force                     override an existing run state
  --director <id>             exec-only: run as this director (default: skywalker)
  --dangerously-skip-permissions
                               skip permission prompts for this run only;
                               /yolo in the TUI instead persists the default
                               machine-wide in ~/.corbits/settings.json
  --auto / --no-auto          auto mode on/off
  --help, -h                  show this help
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

export interface LoadConfigOptions {
  // Override the global settings file location (for tests / non-standard homes).
  globalSettingsPath?: string;
  // Override the home directory used for project-key session roots (tests).
  // Production callers leave this unset so sessions resolve under ~/.corbits.
  home?: string;
  // When true, a missing/unresolvable provider returns an UnconfiguredConfig
  // instead of throwing. The TUI uses this to open the onboarding flow rather
  // than exiting. Headless callers should leave this false (the default).
  allowUnconfigured?: boolean;
  // Pricing metadata fetcher overrides. Tests must inject an offline fetchImpl
  // here — the default performs a real request to models.dev, and a stray
  // background fetch inside the suite destabilizes timing-sensitive tests.
  pricing?: PricingFetcherOptions;
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
    // Bare resume opens the list. A session id is the only direct-resume path.
    // Invalid non-flag positionals error instead of falling through to last
    // (a free-form token would otherwise become task while skipInitialTask is set).
    const next = args.slice()[0];
    if (next === "--pick" || next === "--list") {
      resumeMode = "pick";
      args.shift();
    } else if (next !== undefined && !next.startsWith("--")) {
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

  if (args[0] === "--help" || args[0] === "-h") {
    throw new CliHelpError();
  }

  let cwd = process.cwd();
  let force = false;
  let dangerouslySkipPermissions = false;
  // Auto mode is the default: non-destructive consequential actions (file
  // writes/edits and unconstrained shell) run without prompting, while shell
  // file-mutation stays denied and installs / recursive rm / worktree /
  // sensitive-path / opaque-wrapper shell still ask. Pass --no-auto to revert
  // to ask-on-every-write. There is currently no in-session key to toggle auto;
  // Shift+Tab in the TUI cycles reasoning effort instead.
  let auto = true;
  let director: DirectorId | undefined;
  let configPath: string | undefined;
  let provider: string | undefined;
  let model: string | undefined;
  let profileFlag: string | undefined;
  let noWorkflow = false;
  const positional: string[] = [];

  const requireValue = (flag: string, value: string | undefined): string => {
    if (value === undefined) {
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
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--director") {
      const value = requireValue("--director", args[++i]);
      if (command !== "exec") {
        throw new Error("--director is only available in exec mode");
      }
      if (!isDirectorId(value)) {
        throw new Error(`Unknown director "${value}". Use one of: ${DIRECTOR_IDS.join(", ")}.`);
      }
      director = value;
      continue;
    }

    if (arg === "--dangerously-skip-permissions") {
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
    if (arg === "--resume") {
      if (command === "exec") {
        throw new Error("--resume is only available in interactive mode");
      }
      if (resumeMode === "id") {
        throw new Error("cannot combine a session id with --resume");
      }
      resumeMode = "pick";
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

  await bootstrapPricingMetadata({ cachePath: pricingCachePath, ...options.pricing });

  // Resolve both settings targets from the same effective global path. The
  // local schema must never be read from or written to that global target.
  const effectiveSettingsPath = configPath ?? options.globalSettingsPath ?? globalSettingsPath();
  const localSettingsFile = resolveLocalSettingsPath(cwd, effectiveSettingsPath);

  // OAuth profiles live in home-level auth stores (~/.corbits/codex-auth.json,
  // xai-auth.json), entirely separate from settings.json. --config only
  // overrides where provider *definitions* come from, so it must still merge
  // in OAuth profiles or every codex/xai OAuth run through --config reaches
  // the provider unauthenticated (CL-6973: HTTP 426/404 before a single
  // turn). Only the programmatic `globalSettingsPath` test override — never
  // exposed as a CLI flag — opts out, for tests that want a fully controlled
  // provider set with no home-directory reads at all.
  const useOAuthProfiles = options.globalSettingsPath === undefined;
  const [codexProfiles, xaiProfiles]: [CodexProfile[], XaiProfile[]] = useOAuthProfiles
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
        ).then((s) => {
          if (s === null) throw new Error(`--config file not found or empty: ${configPath}`);
          return s;
        })
      : await loadSettingsRecoveringClobberedOAuthSelection(
          effectiveSettingsPath,
          projectedOAuthProviders,
        );

  // Track whether the effective value came from the persisted global default
  // rather than this invocation's --dangerously-skip-permissions flag, so the
  // TUI/exec entry points can surface a startup notice for the silent case.
  const skipPermissionsFromSettings =
    !dangerouslySkipPermissions && settings?.dangerouslySkipPermissions === true;
  dangerouslySkipPermissions =
    dangerouslySkipPermissions || settings?.dangerouslySkipPermissions === true;
  projectedOAuthProviders = applyPersistedOAuthDefaults(settings, projectedOAuthProviders);
  const settingsForResolution: Settings | null =
    Object.keys(projectedOAuthProviders).length > 0
      ? {
          ...(settings ?? { providers: {} }),
          providers: { ...(settings?.providers ?? {}), ...projectedOAuthProviders },
        }
      : settings;

  // The per-repo selection file still applies on top of a --config source: that
  // file supplies provider definitions, while .corbits/settings.json supplies
  // the provider/model selection. CLI --provider/--model override both.
  // Fail open on unknown/invalid local keys — never crash startup.
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
    local !== null ? local : profile.model !== undefined ? { model: profile.model } : null;
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
      force,
      dangerouslySkipPermissions,
      skipPermissionsFromSettings,
      auto,
      command,
      ...(director !== undefined ? { director } : {}),
      globalSettingsPath: effectiveSettingsPath,
      ...(configPath !== undefined ? { cliConfigPath: configPath } : {}),
      programmaticSettingsPath: options.globalSettingsPath !== undefined,
      providerError: err instanceof Error ? err.message : String(err),
      // Keep diagnostics even when provider setup fails early so junk local
      // files still reach stderr (exec) / banner (TUI after onboarding).
      ...(settingsDiagnostics.length > 0 ? { settingsDiagnostics } : {}),
    };
  }

  // Enforce model/effort compatibility at the boundary. The modal only offers
  // supported levels, but a hand-edited local settings file can pair an effort
  // with a model that does not accept it; reject it here rather than shipping an
  // effort the model will refuse. Pricing metadata was seeded above from cache.
  if (local?.reasoningEffort !== undefined) {
    const verdict = validateEffort(
      resolved.model,
      local.reasoningEffort,
      isCodexProviderName(resolved.providerName),
    );
    if (!verdict.ok) {
      throw new Error(`Invalid reasoningEffort in local settings: ${verdict.error}`);
    }
  }

  // Resume resolution: project-key sessions live under ~/.corbits/projects/<key>/
  // keyed to this checkout's git toplevel (linked worktrees do not share lists).
  let sessionId = generateSessionId();
  let skipInitialTask = false;
  let resumePicker = false;
  let resumeTask = task;
  if (resumeMode === "pick") {
    resumePicker = true;
    skipInitialTask = true;
  } else if (resumeMode === "id") {
    const id = resumeSessionId!;
    await migrateLegacySessionIfNeeded(cwd, id, options.home);
    const state = await loadState(cwd, id, options.home);
    if (state === null) {
      throw new Error(
        `No session ${id} for this project. Sessions are stored under ~/.corbits/projects/<project-key>/ (this checkout's git toplevel). Use \`corbits resume\` to choose one.`,
      );
    }
    sessionId = id;
    skipInitialTask = true;
    if (task.length === 0) resumeTask = state.task;
  }

  return {
    configured: true,
    ...resolved,
    cwd,
    task: resumeTask,
    force,
    dangerouslySkipPermissions,
    skipPermissionsFromSettings,
    auto,
    command,
    ...(director !== undefined ? { director } : {}),
    globalSettingsPath: effectiveSettingsPath,
    sessionId,
    noWorkflow,
    ...(resumeMode !== undefined ? { resumeMode, skipInitialTask } : {}),
    ...(resumePicker ? { resumePicker: true } : {}),
    ...(profile.workflow !== undefined ? { workflow: profile.workflow } : {}),
    ...(settings?.defaultProvider !== undefined
      ? { globalDefaultProvider: settings.defaultProvider }
      : {}),
    providers: mergeOAuthCatalog(settings, resolved, codexProfiles, xaiProfiles),
    ...(profile.profile !== undefined ? { profile: profile.profile } : {}),
    ...(profile.systemPromptExtensions !== undefined
      ? { systemPromptExtensions: profile.systemPromptExtensions }
      : {}),
    ...(profile.inactivityTimeoutMs !== undefined
      ? { inactivityTimeoutMs: profile.inactivityTimeoutMs }
      : {}),
    ...(profile.totalTimeoutMs !== undefined ? { totalTimeoutMs: profile.totalTimeoutMs } : {}),
    ...(local?.reasoningEffort !== undefined ? { reasoningEffort: local.reasoningEffort } : {}),
    ...(local?.mcpServers !== undefined
      ? {
          mcpServers: resolveMcpServers(settings?.mcpServers, local.mcpServers),
          mcpServersSource: "local" as const,
        }
      : settings?.mcpServers !== undefined
        ? {
            mcpServers: resolveMcpServers(settings.mcpServers, undefined),
            mcpServersSource: "global" as const,
          }
        : {
            mcpServers: resolveMcpServers(undefined, undefined),
            mcpServersSource: "none" as const,
          }),
    // Runtime view includes OAuth projections so inference resolution can see
    // Codex/xAI providers that are never written to settings.json. Not safe
    // to persist as-is — use providerCatalogToSettings or re-read disk.
    ...(settingsForResolution !== null ? { settings: settingsForResolution } : {}),
    ...(settingsDiagnostics.length > 0 ? { settingsDiagnostics } : {}),
  };
}

// Settings-file providers plus Codex/xAI OAuth profile-store entries, merged
// the same way loadConfig assembles Config.providers. Exposed so a live
// provider connect (mid-session, no restart) can rebuild the picker's
// catalog after writing new credentials, instead of only taking effect on
// the next process start.
function mergeOAuthCatalog(
  settings: Settings | null,
  resolved: ResolvedProvider,
  codexProfiles: readonly CodexProfile[],
  xaiProfiles: readonly XaiProfile[],
): ProviderCatalogEntry[] {
  return [
    ...buildProviderCatalog(settings, resolved).filter(
      (e) => !isCodexProviderName(e.name) && !isXaiProviderName(e.name),
    ),
    ...codexProfilesToCatalogEntries(codexProfiles),
    ...xaiProfilesToCatalogEntries(xaiProfiles),
  ];
}

/** Rescans home-level Codex/xAI credential stores and rebuilds the live provider catalog. */
export async function refreshLiveProviderCatalog(
  settings: Settings | null,
  resolved: ResolvedProvider,
): Promise<ProviderCatalogEntry[]> {
  const [codexProfiles, xaiProfiles] = await Promise.all([listCodexProfiles(), listXaiProfiles()]);
  return mergeOAuthCatalog(settings, resolved, codexProfiles, xaiProfiles);
}

export function catalogEntryAsProviderSettings(entry: ProviderCatalogEntry): ProviderSettings {
  // Anthropic and Go anthropic-protocol bases must not be forced through the
  // OpenAI-compatible normalizer (which assumes a /v1 chat-completions root).
  // Go identity is flag, known provider id, or Go baseURL — always force
  // subscription base.
  const go = isOpenCodeGoProvider(entry);
  const baseURL =
    entry.anthropic === true || go
      ? (go ? OPENCODE_GO_BASE_URL : entry.baseURL).replace(/\/+$/, "")
      : normalizeOpenAICompatibleBaseURL(entry.baseURL);
  return {
    baseURL,
    ...(entry.keyless === true ? { keyless: true } : {}),
    ...(entry.apiKey !== undefined && entry.apiKey.length > 0 ? { apiKey: entry.apiKey } : {}),
    models: entry.models,
    ...(entry.defaultModel !== undefined ? { defaultModel: entry.defaultModel } : {}),
    ...(entry.free !== undefined ? { free: entry.free } : {}),
    ...(entry.bifrostVirtualKey === true ? { bifrostVirtualKey: true } : {}),
    ...(entry.anthropic === true ? { anthropic: true } : {}),
    ...(go ? { opencodeGo: true } : {}),
    ...(entry.verified === false ? { verified: false } : {}),
  };
}

// Overlay the full live catalog (including OAuth profiles) onto settings for
// runtime provider resolution. OAuth credentials live in home auth stores
// and are stripped from settings.json; the catalog is the source of truth for
// which OAuth providers are available right now. Never pass the result to a
// disk write path — use providerCatalogToSettings for persistence.
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
  return {
    ...settings,
    providers: {
      ...settings.providers,
      ...fromCatalog,
    },
  };
}

// The set of providers the /agent modal can switch between. When a settings
// file is present its providers are the catalog. In env-only mode there is no
// file, so the single resolved provider is the whole catalog (the modal still
// renders, switching is just a no-op against one entry).
export function buildProviderCatalog(
  settings: Settings | null,
  resolved: ResolvedProvider,
): ProviderCatalogEntry[] {
  if (settings !== null && Object.keys(settings.providers).length > 0) {
    return Object.entries(settings.providers).map(([name, p]): ProviderCatalogEntry => {
      // Heal mis-seeded Go rows on load: known id/label, flag, or Go baseURL →
      // pin baseURL + flag.
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
        ...(p.apiKey !== undefined && p.apiKey.length > 0 ? { apiKey: p.apiKey } : {}),
        models: p.models,
        ...(p.defaultModel !== undefined ? { defaultModel: p.defaultModel } : {}),
        ...(p.free !== undefined ? { free: p.free } : {}),
        ...(p.bifrostVirtualKey === true ? { bifrostVirtualKey: true } : {}),
        ...(p.anthropic === true ? { anthropic: true } : {}),
        ...(go ? { opencodeGo: true } : {}),
        ...(p.verified === false ? { verified: false } : {}),
      };
    });
  }
  return [
    {
      name: resolved.providerName,
      baseURL: resolved.baseURL,
      ...(resolved.keyless === true ? { keyless: true } : { apiKey: resolved.apiKey }),
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
  // settings.json. Exclude them so provider edits never persist short-lived
  // access tokens into the settings file.
  const persistable = catalog.filter(
    (p) => p.codexProfile === undefined && p.xaiProfile === undefined,
  );
  const providers = Object.fromEntries(
    persistable.map((p): [string, ProviderSettings] => [p.name, catalogEntryAsProviderSettings(p)]),
  );
  // Spread the full existing settings so provider saves never drop plugins,
  // pluginPaths, shell, tools, or other unknown keys. Only the catalog and
  // defaultProvider are replaced. A hand-picked allowlist previously missed
  // fields and could wipe unrelated settings after a /model save.
  if (existing === undefined) {
    return {
      ...(defaultProvider !== undefined ? { defaultProvider } : {}),
      providers,
    };
  }
  const { providers: _dropProviders, defaultProvider: _dropDefault, ...rest } = existing;
  return {
    ...rest,
    ...(defaultProvider !== undefined ? { defaultProvider } : {}),
    providers,
  };
}
