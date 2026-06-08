import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// A configured inference provider. `apiKey` is secret and lives only in the
// global settings file; `baseURL` is editable provider metadata that lives with
// it. `models` is always an array so single-model and multi-model providers are
// handled uniformly; `defaultModel` (or the first entry) is used when no model
// is selected.
export type ProviderSettings = {
  name?: string;
  baseURL: string;
  apiKey: string;
  models: string[];
  defaultModel?: string;
};

// Global settings: the set of providers plus which one to use by default.
export type Settings = {
  defaultProvider?: string;
  providers: Record<string, ProviderSettings>;
};

export type MCPServerConfig = {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

// Per-repo override. Selection only for provider/model, but may also declare
// MCP servers to connect at session start.
export type LocalSettings = {
  provider?: string;
  model?: string;
  mcpServers?: MCPServerConfig[];
};

// The provider fields the runtime consumes, identical to what the env vars used
// to supply directly.
export type ResolvedProvider = {
  apiKey: string;
  baseURL: string;
  model: string;
  providerName: string;
};

const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";

export function normalizeOpenAICompatibleBaseURL(raw: string): string {
  const trimmed = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid OpenAI-compatible baseURL "${raw}": expected an absolute URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Invalid OpenAI-compatible baseURL "${raw}": expected http or https.`);
  }

  const pathname = parsed.pathname.replace(/\/+$/, "");
  if (pathname.endsWith(CHAT_COMPLETIONS_SUFFIX)) {
    parsed.pathname = pathname.slice(0, -CHAT_COMPLETIONS_SUFFIX.length) || "/";
  } else {
    parsed.pathname = pathname || "/";
  }
  parsed.search = "";
  parsed.hash = "";

  return parsed.toString().replace(/\/$/, "");
}

export function globalSettingsPath(home: string = homedir()): string {
  return join(home, ".interchange", "settings.json");
}

export function localSettingsPath(cwd: string): string {
  return join(cwd, ".interchange", "settings.json");
}

function isENOENT(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

function isProviderSettings(value: unknown): value is ProviderSettings {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  if (typeof p.baseURL !== "string") return false;
  if (typeof p.apiKey !== "string") return false;
  if (!Array.isArray(p.models) || !p.models.every((m) => typeof m === "string")) return false;
  if (p.defaultModel !== undefined && typeof p.defaultModel !== "string") return false;
  if (p.name !== undefined && typeof p.name !== "string") return false;
  return true;
}

export function isSettings(value: unknown): value is Settings {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  if (s.defaultProvider !== undefined && typeof s.defaultProvider !== "string") return false;
  if (typeof s.providers !== "object" || s.providers === null) return false;
  return Object.values(s.providers).every(isProviderSettings);
}

function isMCPServerConfig(value: unknown): value is MCPServerConfig {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  if (typeof s.name !== "string") return false;
  if (typeof s.command !== "string") return false;
  if (s.args !== undefined && (!Array.isArray(s.args) || !s.args.every((a) => typeof a === "string"))) return false;
  if (s.env !== undefined) {
    if (typeof s.env !== "object" || s.env === null) return false;
    if (!Object.values(s.env).every((v) => typeof v === "string")) return false;
  }
  return true;
}

// Local settings are selection-only for provider/model (no credentials
// allowed). The mcpServers key is permitted because MCP server configs are
// expected to live in the repo.
export function isLocalSettings(value: unknown): value is LocalSettings {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  for (const key of Object.keys(s)) {
    if (key !== "provider" && key !== "model" && key !== "mcpServers") return false;
  }
  if (s.provider !== undefined && typeof s.provider !== "string") return false;
  if (s.model !== undefined && typeof s.model !== "string") return false;
  if (s.mcpServers !== undefined) {
    if (!Array.isArray(s.mcpServers) || !s.mcpServers.every(isMCPServerConfig)) return false;
  }
  return true;
}

export async function loadSettings(path: string): Promise<Settings | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (isENOENT(err)) return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in settings file: ${path}`);
  }
  if (!isSettings(parsed)) {
    throw new Error(
      `Invalid settings schema in ${path}: expected { providers: { <name>: { baseURL, apiKey, models: [...] } } }`,
    );
  }
  return parsed;
}

export async function loadLocalSettings(path: string): Promise<LocalSettings | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (isENOENT(err)) return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in local settings file: ${path}`);
  }
  if (!isLocalSettings(parsed)) {
    throw new Error(
      `Invalid local settings in ${path}: only "provider" and "model" are allowed (no credentials).`,
    );
  }
  return parsed;
}

// Persist the global settings file. Validates before writing so a written file
// always round-trips back through loadSettings, and written via temp-file +
// rename so a concurrent reader never sees a torn file.
export async function saveGlobalSettings(path: string, settings: Settings): Promise<void> {
  if (!isSettings(settings)) {
    throw new Error(`Refusing to write invalid global settings.`);
  }
  const payload = JSON.stringify(settings, null, 2);
  const tmp = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmp, payload);
  await rename(tmp, path);
}

// Persist the per-repo provider/model selection. This is where the /agent modal
// writes a "default for this project": selection only, never credentials, so
// the file stays safe to leave gitignored in the repo. Validated before writing
// so a written file always round-trips back through loadLocalSettings, and
// written via temp-file + rename so a concurrent reader never sees a torn file.
export async function saveLocalSettings(path: string, local: LocalSettings): Promise<void> {
  if (!isLocalSettings(local)) {
    throw new Error(`Refusing to write invalid local settings: only "provider" and "model" are allowed.`);
  }
  const payload = JSON.stringify(local, null, 2);
  const tmp = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmp, payload);
  await rename(tmp, path);
}

export type ResolveInput = {
  // Provider definitions, from the --config file when given, otherwise global.
  settings: Settings | null;
  // Per-repo selection override.
  local: LocalSettings | null;
  // Env override fields; each present value overrides the file-derived one.
  env: Partial<ResolvedProvider>;
  // Highest-priority selection from CLI flags.
  cli: { provider?: string; model?: string };
};

// Resolve the active provider. Precedence per field (highest first):
//   providerName: --provider > env > local > settings.defaultProvider > sole provider
//   model:        --model    > env > local > provider.defaultModel    > provider.models[0]
//   baseURL/apiKey: env > selected provider (no CLI flags for credentials)
// When the resolved providerName is not a configured provider (e.g. pure env
// mode with no settings file), credentials come entirely from env.
export function resolveProvider(input: ResolveInput): ResolvedProvider {
  const { settings, local, env, cli } = input;
  const providers = settings?.providers ?? {};
  const providerKeys = Object.keys(providers);
  const soleKey = providerKeys.length === 1 ? providerKeys[0] : undefined;

  if (cli.provider !== undefined && settings !== null && providers[cli.provider] === undefined) {
    const available = providerKeys.length > 0 ? providerKeys.join(", ") : "none";
    throw new Error(`Provider "${cli.provider}" not found in settings (available: ${available}).`);
  }

  const providerName =
    cli.provider ?? env.providerName ?? local?.provider ?? settings?.defaultProvider ?? soleKey;

  const selected = providerName !== undefined ? providers[providerName] : undefined;

  const baseURL = env.baseURL ?? selected?.baseURL;
  const apiKey = env.apiKey ?? selected?.apiKey;
  const model =
    cli.model ?? env.model ?? local?.model ?? selected?.defaultModel ?? selected?.models[0];

  // A provider name was selected (from local file or defaultProvider) but is not
  // actually configured — distinguish this from "nothing configured at all" so
  // the operator gets an actionable message instead of a generic missing-creds one.
  const selectedMissing =
    providerName !== undefined && settings !== null && providers[providerName] === undefined;

  if (
    providerName === undefined ||
    providerName.length === 0 ||
    baseURL === undefined ||
    baseURL.length === 0 ||
    apiKey === undefined ||
    apiKey.length === 0 ||
    model === undefined ||
    model.length === 0
  ) {
    const missing: string[] = [];
    if (providerName === undefined || providerName.length === 0) missing.push("provider");
    if (baseURL === undefined || baseURL.length === 0) missing.push("baseURL");
    if (apiKey === undefined || apiKey.length === 0) missing.push("apiKey");
    if (model === undefined || model.length === 0) missing.push("model");
    const detail = selectedMissing
      ? ` Selected provider "${providerName}" is not configured in settings (available: ${
          Object.keys(providers).join(", ") || "none"
        }).`
      : "";
    throw new Error(
      `Could not resolve an inference provider (missing: ${missing.join(", ")}).${detail} ` +
        `Configure ${globalSettingsPath()} or set the OPENAI_COMPATIBLE_* env vars. ` +
        `See docs/IMPLEMENTATION.md.`,
    );
  }

  return { providerName, baseURL: normalizeOpenAICompatibleBaseURL(baseURL), apiKey, model };
}
