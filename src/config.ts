import { resolve } from "node:path";

import type { InferenceSource } from "@intx/types/runtime";

import {
  globalSettingsPath,
  loadLocalSettings,
  loadSettings,
  localSettingsPath,
  resolveProvider,
  type ResolvedProvider,
  type Settings,
} from "./settings.js";

// The per-call token ceiling for the inference source. Lives here so agent
// creation (runner.tsx, run-agent.ts) and live provider switching (the /agent
// modal) all build the source the same way and a live switch can never silently
// revert the ceiling.
export const SOURCE_MAX_TOKENS = 16384;
export const SOURCE_INACTIVITY_TIMEOUT_MS = 60_000;
export const SOURCE_TOTAL_TIMEOUT_MS = 300_000;

// Build the OpenAI-compatible InferenceSource the runtime consumes. `id` is the
// source's routing key (the provider name); credentials and model come from the
// resolved provider or a catalog entry.
export function buildOpenAISource(fields: {
  id: string;
  baseURL: string;
  apiKey: string;
  model: string;
}): InferenceSource {
  return {
    id: fields.id,
    provider: "openai",
    baseURL: fields.baseURL,
    apiKey: fields.apiKey,
    model: fields.model,
    defaults: {
      maxTokens: SOURCE_MAX_TOKENS,
      inactivityTimeoutMs: SOURCE_INACTIVITY_TIMEOUT_MS,
      totalTimeoutMs: SOURCE_TOTAL_TIMEOUT_MS,
    },
  };
}

// One configured provider the /agent modal can switch to. Carries credentials
// because live switching builds an InferenceSource from it; the modal only ever
// receives fields needed for provider management, never the key.
export type ProviderCatalogEntry = {
  name: string;
  baseURL: string;
  apiKey: string;
  models: string[];
  defaultModel?: string;
};

export type Config = {
  configured: true;
  apiKey: string;
  baseURL: string;
  model: string;
  providerName: string;
  cwd: string;
  task: string;
  force: boolean;
  headless: boolean;
  dangerouslySkipPermissions: boolean;
  globalSettingsPath: string;
  globalDefaultProvider?: string;
  // Every provider available to switch to at runtime. From the settings file
  // when present; in env-only mode it is just the single resolved provider.
  providers: ProviderCatalogEntry[];
};

// Returned by loadConfig when no provider is configured and allowUnconfigured is
// true. Carries enough context for the TUI to launch the onboarding flow instead
// of exiting. Headless callers must treat this as a fatal error.
export type UnconfiguredConfig = {
  configured: false;
  cwd: string;
  task: string;
  force: boolean;
  headless: boolean;
  dangerouslySkipPermissions: boolean;
  // Path where the onboarding flow should write the new settings.
  globalSettingsPath: string;
  // The original error message, used for headless error output.
  providerError: string;
};

export type LoadConfigOptions = {
  // Override the global settings file location (for tests / non-standard homes).
  globalSettingsPath?: string;
  // When true, a missing/unresolvable provider returns an UnconfiguredConfig
  // instead of throwing. The TUI uses this to open the onboarding flow rather
  // than exiting. Headless callers should leave this false (the default).
  allowUnconfigured?: boolean;
};

function envProvider(): Partial<ResolvedProvider> {
  const env = (name: string): string | undefined => {
    const value = process.env[name];
    return value !== undefined && value.length > 0 ? value : undefined;
  };
  const result: Partial<ResolvedProvider> = {};
  const apiKey = env("OPENAI_COMPATIBLE_API_KEY");
  const baseURL = env("OPENAI_COMPATIBLE_BASE_URL");
  const model = env("OPENAI_COMPATIBLE_MODEL");
  const providerName = env("OPENAI_COMPATIBLE_PROVIDER_NAME");
  if (apiKey !== undefined) result.apiKey = apiKey;
  if (baseURL !== undefined) result.baseURL = baseURL;
  if (model !== undefined) result.model = model;
  if (providerName !== undefined) result.providerName = providerName;
  return result;
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

  let cwd = process.cwd();
  let force = false;
  let headless = false;
  let dangerouslySkipPermissions = false;
  let configPath: string | undefined;
  let provider: string | undefined;
  let model: string | undefined;
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
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--headless" || arg === "-h") {
      headless = true;
      continue;
    }
    if (arg === "--dangerously-skip-permissions") {
      dangerouslySkipPermissions = true;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`unrecognized flag: ${arg}`);
    }
    positional.push(arg);
  }

  const settings =
    configPath !== undefined
      ? await loadSettings(configPath).then((s) => {
          if (s === null) throw new Error(`--config file not found or empty: ${configPath}`);
          return s;
        })
      : await loadSettings(options.globalSettingsPath ?? globalSettingsPath());

  // The per-repo selection file still applies on top of a --config source: that
  // file supplies provider definitions, while .interchange/settings.json supplies
  // the provider/model selection. CLI --provider/--model override both.
  const local = await loadLocalSettings(localSettingsPath(cwd));

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
      settings,
      local,
      env: envProvider(),
      cli,
    });
  } catch (err) {
    if (!options.allowUnconfigured) throw err;
    return {
      configured: false,
      cwd,
      task,
      force,
      headless,
      dangerouslySkipPermissions,
      globalSettingsPath: effectiveSettingsPath,
      providerError: err instanceof Error ? err.message : String(err),
    };
  }

  return {
    configured: true,
    ...resolved,
    cwd,
    task,
    force,
    headless,
    dangerouslySkipPermissions,
    globalSettingsPath: effectiveSettingsPath,
    ...(settings?.defaultProvider !== undefined ? { globalDefaultProvider: settings.defaultProvider } : {}),
    providers: buildProviderCatalog(settings, resolved),
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
    return Object.entries(settings.providers).map(([name, p]) => ({
      name,
      baseURL: p.baseURL,
      apiKey: p.apiKey,
      models: p.models,
      ...(p.defaultModel !== undefined ? { defaultModel: p.defaultModel } : {}),
    }));
  }
  return [
    {
      name: resolved.providerName,
      baseURL: resolved.baseURL,
      apiKey: resolved.apiKey,
      models: [resolved.model],
    },
  ];
}

export function providerCatalogToSettings(
  catalog: readonly ProviderCatalogEntry[],
  defaultProvider: string | undefined,
): Settings {
  return {
    ...(defaultProvider !== undefined ? { defaultProvider } : {}),
    providers: Object.fromEntries(
      catalog.map((p) => [
        p.name,
        {
          baseURL: p.baseURL,
          apiKey: p.apiKey,
          models: p.models,
          ...(p.defaultModel !== undefined ? { defaultModel: p.defaultModel } : {}),
        },
      ]),
    ),
  };
}
