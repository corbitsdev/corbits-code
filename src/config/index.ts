import { join, resolve } from "node:path";

import type { InferenceSource } from "@intx/types/runtime";
import { generateSessionId } from "../session/index.js";
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
import { GROK_RESPONSES_PROVIDER, GROK_USER_ID_OPTION } from "../provider/grok-responses-adapter.js";
import { BIFROST_PROVIDER } from "../provider/bifrost-adapter.js";
import { xaiUserIdFromAccessToken } from "../auth/xai/session.js";

import {
  globalSettingsPath,
  loadLocalSettings,
  loadLocalSettingsResult,
  type SettingsLoadDiagnostic,
  loadSettings,
  localSettingsPath,
  normalizeOpenAICompatibleBaseURL,
  resolveProvider,
  type MCPServerConfig,
  type ProviderTier,
  type TierAssignment,
  type TierConfig,
  type TierDefinition,
  type ResolvedProvider,
  type Settings,
  type ProviderSettings,
} from "./settings.js";
import { resolveProfile } from "./profiles.js";

// The per-call token ceiling for the inference source. Lives here so agent
// creation (runner.tsx) and live provider switching (the /agent
// modal) all build the source the same way and a live switch can never silently
// revert the ceiling.
export const SOURCE_MAX_TOKENS = 16384;

// Placeholder sent in the Authorization header for keyless local providers
// (e.g. Ollama). The runtime's InferenceSource type requires a non-empty
// apiKey string; the value is injected as `Bearer <key>` by the harness but
// keyless servers ignore it entirely.
export const KEYLESS_API_KEY = "keyless";

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
    apiKey: fields.apiKey !== undefined && fields.apiKey.length > 0 ? fields.apiKey : KEYLESS_API_KEY,
    model: fields.model,
    defaults: { maxTokens: SOURCE_MAX_TOKENS, ...overrides },
  };
}

// One configured provider the /agent modal can switch to. Carries credentials
// because live switching builds an InferenceSource from it; the modal only ever
// receives fields needed for provider management, never the key.
export type ProviderCatalogEntry = {
  name: string;
  baseURL: string;
  // Absent for keyless providers (see `keyless`). When present, carries the
  // secret key the harness injects as a Bearer credential.
  apiKey?: string;
  models: string[];
  defaultModel?: string;
  // True for local providers that require no authentication (e.g. Ollama).
  // When set, `apiKey` is omitted and resolution skips the key check.
  keyless?: boolean;
  // Manual override suppressing the status-bar dollar cost for this provider.
  free?: boolean;
  // Set when this entry is a Codex OAuth profile rather than an API-key
  // provider. Holds the profile name; the send path uses it to refresh the
  // access token before each turn. Such entries are never written to
  // settings.json (their credentials live in the Codex auth store).
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
  if (fields.reasoningEffort !== undefined) providerOptions["reasoning_effort"] = fields.reasoningEffort;
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
export function buildXaiSource(fields: {
  id: string;
  apiKey: string;
  model: string;
}): InferenceSource {
  const userId = xaiUserIdFromAccessToken(fields.apiKey);
  const providerOptions: Record<string, unknown> = {};
  if (userId !== undefined) providerOptions[GROK_USER_ID_OPTION] = userId;
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
    apiKey: fields.apiKey !== undefined && fields.apiKey.length > 0 ? fields.apiKey : KEYLESS_API_KEY,
    model: fields.model,
    defaults: { maxTokens: SOURCE_MAX_TOKENS, ...overrides },
  };
}

export type Config = {
  configured: true;
  apiKey: string;
  baseURL: string;
  model: string;
  providerName: string;
  keyless?: boolean;
  cwd: string;
  task: string;
  force: boolean;
  dangerouslySkipPermissions: boolean;
  auto: boolean;
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
  maxTurns?: number;
  // Per-call inactivity timeout in ms (default 120_000 in the harness). Tune
  // higher for reasoning models with long silent-thinking stretches.
  inactivityTimeoutMs?: number;
  // Per-call total wall-clock cap in ms (default 600_000 in the harness).
  totalTimeoutMs?: number;
  reasoningEffort?: ReasoningEffort;
  mcpServers?: MCPServerConfig[];
  /**
   * Where `mcpServers` came from. Local project settings replace global MCP
   * entirely; only `"local"` sources require project trust before connect.
   */
  mcpServersSource?: "local" | "global" | "none";
  sessionId: string;
  /** When true, runTUI shows a session picker first (resume flow). */
  resumePicker?: boolean;
  /** When true, the TUI does not auto-send `task` on mount (resumed session). */
  skipInitialTask?: boolean;
  // Deprecated workflow profile metadata; workflows are manual-only slash commands.
  workflow?: string;
  // Deprecated no-op retained for CLI compatibility.
  noWorkflow: boolean;
  tiers?: Partial<Record<ProviderTier, import("./settings.js").TierConfig>>;
  /**
   * Runtime settings view for tier/provider resolution. Includes OAuth provider
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
};

// Returned by loadConfig when no provider is configured and allowUnconfigured is
// true. Carries enough context for the TUI to launch the onboarding flow instead
// of exiting. Headless callers must treat this as a fatal error.
export type UnconfiguredConfig = {
  configured: false;
  cwd: string;
  task: string;
  force: boolean;
  dangerouslySkipPermissions: boolean;
  auto: boolean;
  command: "tui" | "exec";
  // Path where the onboarding flow should write the new settings.
  globalSettingsPath: string;
  // The original error message, used for non-TUI (exec) error output.
  providerError: string;
};

export type LoadConfigOptions = {
  // Override the global settings file location (for tests / non-standard homes).
  globalSettingsPath?: string;
  // When true, a missing/unresolvable provider returns an UnconfiguredConfig
  // instead of throwing. The TUI uses this to open the onboarding flow rather
  // than exiting. Headless callers should leave this false (the default).
  allowUnconfigured?: boolean;
  // Pricing metadata fetcher overrides. Tests must inject an offline fetchImpl
  // here — the default performs a real request to models.dev, and a stray
  // background fetch inside the suite destabilizes timing-sensitive tests.
  pricing?: PricingFetcherOptions;
};

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
  let command: "tui" | "exec" = "tui";
  if (args[0] === "exec" || args[0] === "run") {
    command = "exec";
    args.shift();
  }

  let cwd = process.cwd();
  let force = false;
  let dangerouslySkipPermissions = false;
  // Auto mode is the default: non-destructive consequential actions (file
  // writes/edits and unconstrained shell) run without prompting, while shell
  // file-mutation stays denied and installs / recursive rm / worktree /
  // sensitive-path / opaque-wrapper shell still ask. Pass --no-auto to revert
  // to ask-on-every-write, or toggle live in the TUI with SHIFT+TAB.
  let auto = true;
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
    if (arg.startsWith("--")) {
      throw new Error(`unrecognized flag: ${arg}`);
    }
    positional.push(arg);
  }

  const pricingCachePath = defaultPricingCachePath();

  await bootstrapPricingMetadata({ cachePath: pricingCachePath, ...options.pricing });

  const settings =
    configPath !== undefined
      ? await loadSettings(configPath).then((s) => {
          if (s === null) throw new Error(`--config file not found or empty: ${configPath}`);
          return s;
        })
      : await loadSettings(options.globalSettingsPath ?? globalSettingsPath());

  // OAuth profiles live in home-level auth stores, not in settings files. They
  // are merged in only for the real default settings path: an explicit --config
  // or test override selects a controlled provider set that should not pull in
  // home credentials. Profiles surface as "provider/<name>" so selection and the
  // picker treat them like any other provider.
  const useOAuthProfiles = configPath === undefined && options.globalSettingsPath === undefined;
  const [codexProfiles, xaiProfiles]: [CodexProfile[], XaiProfile[]] = useOAuthProfiles
    ? await Promise.all([listCodexProfiles(), listXaiProfiles()])
    : [[], []];
  const codexProviderSettings = codexProvidersAsSettings(codexProfiles);
  const xaiProviderSettings = xaiProvidersAsSettings(xaiProfiles);
  const oauthProviderSettings = { ...codexProviderSettings, ...xaiProviderSettings };
  const settingsForResolution: Settings | null =
    Object.keys(oauthProviderSettings).length > 0
      ? { ...(settings ?? { providers: {} }), providers: { ...(settings?.providers ?? {}), ...oauthProviderSettings } }
      : settings;

  // The per-repo selection file still applies on top of a --config source: that
  // file supplies provider definitions, while .corbits/settings.json supplies
  // the provider/model selection. CLI --provider/--model override both.
  // Fail open on unknown/invalid local keys — never crash startup.
  const localResult = await loadLocalSettingsResult(localSettingsPath(cwd));
  const local = localResult.settings;
  const settingsDiagnostics = localResult.diagnostics;

  const profile = await resolveProfile(cwd, profileFlag);

  // Apply profile as a fallback layer: profile.model fills in when neither CLI
  // nor local settings specify a model. This sits below local in precedence.
  const effectiveLocal = local !== null
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

  // When --config is given, onboarding must write to and reload from that
  // same file, not the global default. Prefer configPath, then the caller
  // override, then the real global default.
  const effectiveSettingsPath = configPath ?? options.globalSettingsPath ?? globalSettingsPath();
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
      auto,
      command,
      globalSettingsPath: effectiveSettingsPath,
      providerError: err instanceof Error ? err.message : String(err),
    };
  }

  // Enforce model/effort compatibility at the boundary. The modal only offers
  // supported levels, but a hand-edited local settings file can pair an effort
  // with a model that does not accept it; reject it here rather than shipping an
  // effort the model will refuse. Pricing metadata was seeded above from cache.
  if (local?.reasoningEffort !== undefined) {
    const verdict = validateEffort(resolved.model, local.reasoningEffort, isCodexProviderName(resolved.providerName));
    if (!verdict.ok) {
      throw new Error(`Invalid reasoningEffort in local settings: ${verdict.error}`);
    }
  }

  return {
    configured: true,
    ...resolved,
    cwd,
    task,
    force,
    dangerouslySkipPermissions,
    auto,
    command,
    globalSettingsPath: effectiveSettingsPath,
    sessionId: generateSessionId(),
    noWorkflow,
    ...(profile.workflow !== undefined ? { workflow: profile.workflow } : {}),
    ...(settings?.defaultProvider !== undefined ? { globalDefaultProvider: settings.defaultProvider } : {}),
    providers: [
      ...buildProviderCatalog(settings, resolved).filter((e) => !isCodexProviderName(e.name) && !isXaiProviderName(e.name)),
      ...codexProfilesToCatalogEntries(codexProfiles),
      ...xaiProfilesToCatalogEntries(xaiProfiles),
    ],
    ...(profile.profile !== undefined ? { profile: profile.profile } : {}),
    ...(profile.systemPromptExtensions !== undefined
      ? { systemPromptExtensions: profile.systemPromptExtensions }
      : {}),
    ...(profile.maxTurns !== undefined ? { maxTurns: profile.maxTurns } : {}),
    ...(profile.inactivityTimeoutMs !== undefined ? { inactivityTimeoutMs: profile.inactivityTimeoutMs } : {}),
    ...(profile.totalTimeoutMs !== undefined ? { totalTimeoutMs: profile.totalTimeoutMs } : {}),
    ...(local?.reasoningEffort !== undefined ? { reasoningEffort: local.reasoningEffort } : {}),
    ...(local?.mcpServers !== undefined
      ? { mcpServers: local.mcpServers, mcpServersSource: "local" as const }
      : settings?.mcpServers !== undefined
        ? { mcpServers: settings.mcpServers, mcpServersSource: "global" as const }
        : { mcpServersSource: "none" as const }),
    ...(settings?.tiers !== undefined ? { tiers: settings.tiers } : {}),
    // Runtime view includes OAuth projections so tier resolution can see
    // Codex/xAI providers that are never written to settings.json. Not safe
    // to persist as-is — use providerCatalogToSettings or re-read disk.
    ...(settingsForResolution !== null ? { settings: settingsForResolution } : {}),
    ...(settingsDiagnostics.length > 0 ? { settingsDiagnostics } : {}),
  };
}

export function catalogEntryAsProviderSettings(entry: ProviderCatalogEntry): ProviderSettings {
  return {
    baseURL: normalizeOpenAICompatibleBaseURL(entry.baseURL),
    ...(entry.keyless === true ? { keyless: true } : {}),
    ...(entry.apiKey !== undefined && entry.apiKey.length > 0 ? { apiKey: entry.apiKey } : {}),
    models: entry.models,
    ...(entry.defaultModel !== undefined ? { defaultModel: entry.defaultModel } : {}),
    ...(entry.free !== undefined ? { free: entry.free } : {}),
    ...(entry.bifrostVirtualKey === true ? { bifrostVirtualKey: true } : {}),
  };
}

// Overlay the full live catalog (including OAuth profiles) onto settings for
// runtime tier/provider resolution. OAuth credentials live in home auth stores
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
    return Object.entries(settings.providers).map(([name, p]): ProviderCatalogEntry => ({
      name,
      baseURL: normalizeOpenAICompatibleBaseURL(p.baseURL),
      ...(p.keyless === true ? { keyless: true } : {}),
      ...(p.apiKey !== undefined && p.apiKey.length > 0 ? { apiKey: p.apiKey } : {}),
      models: p.models,
      ...(p.defaultModel !== undefined ? { defaultModel: p.defaultModel } : {}),
      ...(p.free !== undefined ? { free: p.free } : {}),
      ...(p.bifrostVirtualKey === true ? { bifrostVirtualKey: true } : {}),
    }));
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
  // settings.json. Exclude them so provider edits never persist short-lived
  // access tokens into the settings file.
  const persistable = catalog.filter((p) => p.codexProfile === undefined && p.xaiProfile === undefined);
  const providers = Object.fromEntries(
    persistable.map((p): [string, ProviderSettings] => [
      p.name,
      catalogEntryAsProviderSettings(p),
    ]),
  );
  // Spread the full existing settings so provider saves never drop plugins,
  // pluginPaths, sessionMode, shell, tools, etc. Only the catalog and
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

