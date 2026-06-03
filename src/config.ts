import { resolve } from "node:path";

import {
  globalSettingsPath,
  loadLocalSettings,
  loadSettings,
  localSettingsPath,
  resolveProvider,
  type ResolvedProvider,
  type Settings,
} from "./settings.js";

// One configured provider the /agent modal can switch to. Carries credentials
// because live switching builds an InferenceSource from it; the modal only ever
// displays the name and models, never the key.
export type ProviderCatalogEntry = {
  name: string;
  baseURL: string;
  apiKey: string;
  models: string[];
  defaultModel?: string;
};

export type Config = {
  apiKey: string;
  baseURL: string;
  model: string;
  providerName: string;
  cwd: string;
  task: string;
  force: boolean;
  headless: boolean;
  dangerouslySkipPermissions: boolean;
  // Every provider available to switch to at runtime. From the settings file
  // when present; in env-only mode it is just the single resolved provider.
  providers: ProviderCatalogEntry[];
};

export type LoadConfigOptions = {
  // Override the global settings file location (for tests / non-standard homes).
  globalSettingsPath?: string;
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
  options: LoadConfigOptions = {},
): Promise<Config> {
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

  const resolved = resolveProvider({
    settings,
    local,
    env: envProvider(),
    cli,
  });

  const task = positional.join(" ").trim();

  return {
    ...resolved,
    cwd,
    task,
    force,
    headless,
    dangerouslySkipPermissions,
    providers: buildProviderCatalog(settings, resolved),
  };
}

// The set of providers the /agent modal can switch between. When a settings
// file is present its providers are the catalog. In env-only mode there is no
// file, so the single resolved provider is the whole catalog (the modal still
// renders, switching is just a no-op against one entry).
function buildProviderCatalog(
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
