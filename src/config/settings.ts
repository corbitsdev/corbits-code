import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { type } from "arktype";

import { REASONING_EFFORTS, type ReasoningEffort } from "../provider/reasoning-effort.js";

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

export type ProviderTier = "fast" | "standard" | "clever";
export type TierAssignment = { provider: string; model: string };

export const PROVIDER_TIERS: readonly ProviderTier[] = ["fast", "standard", "clever"];

// Global settings: the set of providers plus which one to use by default.
export type Settings = {
  defaultProvider?: string;
  providers: Record<string, ProviderSettings>;
  mcpServers?: MCPServerConfig[];
  tiers?: Partial<Record<ProviderTier, TierAssignment>>;
};

// An MCP server is reached one of two ways. A stdio server is launched as a
// subprocess (`command` + `args`). An http server is a remote Streamable-HTTP
// endpoint (`url`) that intercode connects to directly and authorizes via OAuth.
// `type` defaults to "stdio" when `command` is set and "http" when only `url` is.
export type MCPServerConfig = {
  name: string;
  type?: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
};

// Per-repo override. Selection only for provider/model, but may also declare
// MCP servers to connect at session start.
export type LocalSettings = {
  provider?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
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
  return join(home, ".intercode", "settings.json");
}

export function localSettingsPath(cwd: string): string {
  return join(cwd, ".intercode", "settings.json");
}

function isENOENT(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

// arktype is the single validation vocabulary for config boundaries (see
// AGENTS.md). The schemas below own structural validation; the imperative
// helpers that remain (transport selection, dual array/object MCP format) are
// normalization and cross-field business rules, not type checks.
const ProviderSettingsSchema = type({
  "name?": "string",
  baseURL: "string",
  apiKey: "string",
  models: "string[]",
  "defaultModel?": "string",
});

const TierAssignmentSchema = type({
  provider: "string",
  model: "string",
});

const TiersSchema = type({
  "fast?": TierAssignmentSchema,
  "standard?": TierAssignmentSchema,
  "clever?": TierAssignmentSchema,
});

const SettingsSchema = type({
  "defaultProvider?": "string",
  providers: type({ "[string]": ProviderSettingsSchema }),
  // mcpServers accepts both array and object forms, so it is validated by
  // normalizeMcpServers rather than expressed structurally here.
  "mcpServers?": "unknown",
  "tiers?": TiersSchema,
});

// Per-entry MCP shape without the name key. The "exactly one transport" rule is
// a cross-field constraint enforced after the structural check.
const McpEntrySchema = type({
  "type?": "'stdio' | 'http'",
  "command?": "string",
  "args?": "string[]",
  "env?": "Record<string, string>",
  "url?": "string",
});

const LocalSettingsSchema = type({
  "provider?": "string",
  "model?": "string",
  "reasoningEffort?": type.enumerated(...REASONING_EFFORTS),
  "mcpServers?": "unknown",
  // Reject any other key so local settings can never smuggle credentials.
  "+": "reject",
});

function isProviderSettings(value: unknown): value is ProviderSettings {
  return ProviderSettingsSchema.allows(value);
}

export function isSettings(value: unknown): value is Settings {
  if (!SettingsSchema.allows(value)) return false;
  const s = value as Record<string, unknown>;
  if (s.mcpServers !== undefined && normalizeMcpServers(s.mcpServers) === undefined) return false;
  return true;
}

function isMCPServerConfigEntry(value: unknown): value is Omit<MCPServerConfig, "name"> {
  if (!McpEntrySchema.allows(value)) return false;
  const s = value as Record<string, unknown>;
  // Exactly one transport must be specified.
  const isHttp = s.type === "http" || (s.type === undefined && typeof s.url === "string");
  return isHttp ? typeof s.url === "string" : typeof s.command === "string";
}

function isMCPServerConfigWithKey(value: unknown): value is MCPServerConfig {
  if (typeof value !== "object" || value === null) return false;
  if (typeof (value as Record<string, unknown>).name !== "string") return false;
  return isMCPServerConfigEntry(value);
}

function normalizeMcpEntry(name: string, entry: Record<string, unknown>): MCPServerConfig {
  return {
    name,
    ...(entry.type !== undefined ? { type: entry.type as "stdio" | "http" } : {}),
    ...(entry.command !== undefined ? { command: entry.command as string } : {}),
    ...(entry.url !== undefined ? { url: entry.url as string } : {}),
    ...(entry.args !== undefined ? { args: entry.args as string[] } : {}),
    ...(entry.env !== undefined ? { env: entry.env as Record<string, string> } : {}),
  };
}

// Accepts both array format [{ name, command, ... }] and object format
// { "name": { command, ... } }. Returns the normalized array.
export function normalizeMcpServers(value: unknown): MCPServerConfig[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    if (!value.every(isMCPServerConfigWithKey)) return undefined;
    return value.map((v) => {
      const entry = v as Record<string, unknown>;
      return normalizeMcpEntry(entry.name as string, entry);
    });
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const entries: MCPServerConfig[] = [];
    for (const [key, val] of Object.entries(obj)) {
      if (typeof key !== "string") return undefined;
      if (!isMCPServerConfigEntry(val)) return undefined;
      entries.push(normalizeMcpEntry(key, val as Record<string, unknown>));
    }
    return entries;
  }
  return undefined;
}

// Local settings are selection-only for provider/model (no credentials
// allowed). The mcpServers key is permitted because MCP server configs are
// expected to live in the repo.
export function isLocalSettings(value: unknown): value is LocalSettings {
  if (!LocalSettingsSchema.allows(value)) return false;
  const s = value as Record<string, unknown>;
  if (s.mcpServers !== undefined && normalizeMcpServers(s.mcpServers) === undefined) return false;
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
  const s = parsed as Record<string, unknown>;
  return {
    providers: s.providers as Settings["providers"],
    ...(s.defaultProvider !== undefined ? { defaultProvider: s.defaultProvider as string } : {}),
    ...(s.mcpServers !== undefined ? { mcpServers: normalizeMcpServers(s.mcpServers) } : {}),
    ...(s.tiers !== undefined ? { tiers: s.tiers as Settings["tiers"] } : {}),
  } as Settings;
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
      `Invalid local settings in ${path}: only "provider", "model", and "reasoningEffort" are allowed (no credentials).`,
    );
  }
  const s = parsed as Record<string, unknown>;
  return {
    ...(s.provider !== undefined ? { provider: s.provider as string } : {}),
    ...(s.model !== undefined ? { model: s.model as string } : {}),
    ...(s.reasoningEffort !== undefined ? { reasoningEffort: s.reasoningEffort as ReasoningEffort } : {}),
    ...(s.mcpServers !== undefined ? { mcpServers: normalizeMcpServers(s.mcpServers) } : {}),
  } as LocalSettings;
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
    throw new Error(
      `Refusing to write invalid local settings: only "provider", "model", and "reasoningEffort" are allowed.`,
    );
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

// Walk the fallback chain fast → standard → clever and return the first
// TierAssignment that is configured and references an existing provider.
// Returns null if no tier in the chain is configured.
export function resolveTier(tier: ProviderTier, settings: Settings): TierAssignment | null {
  const chain: ProviderTier[] = ["fast", "standard", "clever"];
  const start = chain.indexOf(tier);
  if (start === -1) return null;
  for (let i = start; i < chain.length; i++) {
    const t = chain[i] as ProviderTier;
    const assignment = settings.tiers?.[t];
    if (assignment !== undefined && settings.providers[assignment.provider] !== undefined) {
      return assignment;
    }
  }
  return null;
}
