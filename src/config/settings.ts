import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { type } from "arktype";

import { SETTINGS_DIR_NAME } from "../branding.js";
import { EXA_MCP_SERVER_NAME } from "../mcp/exa.js";
import {
  REASONING_EFFORTS,
  isReasoningEffort,
  type ReasoningEffort,
} from "../provider/reasoning-effort.js";
import type { SessionMode } from "./session-mode.js";
import { resolveDefaultModel } from "./providers.js";
import {
  OPENCODE_GO_BASE_URL,
  isOpenCodeGoProvider,
} from "../../packages/opencode-go/src/index.js";

// A configured inference provider. `apiKey` is secret and lives only in the
// global settings file; `baseURL` is editable provider metadata that lives with
// it. `models` is always an array so single-model and multi-model providers are
// handled uniformly; `defaultModel` (or the first entry) is used when no model
// is selected.
export interface ProviderSettings {
  name?: string;
  baseURL: string;
  // Optional for keyless local providers (e.g. Ollama) that require no
  // authentication. When `keyless` is true the resolution path skips the
  // non-empty apiKey check entirely.
  apiKey?: string;
  models: string[];
  defaultModel?: string;
  keyless?: boolean;
  // Manual override that suppresses the status-bar dollar cost for this
  // provider regardless of model pricing — e.g. a prepaid coding plan or a
  // gateway whose models.dev prices do not apply.
  free?: boolean;
  contextWindow?: number;
  // When true, this provider uses a Bifrost virtual key (sk-bf-...).
  // The marker causes the inference source to route through the Bifrost
  // adapter (which injects the x-bf-vk header) and enables model
  // auto-discovery via the Bifrost /v1/models endpoint.
  bifrostVirtualKey?: boolean;
  // Anthropic Messages API provider (x-api-key auth).
  anthropic?: boolean;
  // OpenCode Go multi-protocol provider; per-model adapter selection.
  opencodeGo?: boolean;
  // False when this credential was persisted without a passing connection
  // test (e.g. the onboarding "save anyway" bypass). Absent/true means either
  // the test passed or the provider is exempt from it by design. Read once at
  // startup to warn the operator instead of surfacing a raw auth error.
  //
  // Deliberately defaults to trusted: this field did not exist before it was
  // introduced, so every provider in an existing settings.json has no value
  // for it, and that must not retroactively flag every current user's
  // already-working setup as unverified. Only paths that persist a
  // credential without testing it write `false` explicitly.
  verified?: boolean;
}

// Provider+model identity used by the models-first picker (recent / favorites).
export interface ModelRef {
  provider: string;
  model: string;
}

export const DEFAULT_RECENT_MODELS_STORED = 10;
export const DEFAULT_RECENT_MODELS_SHOWN = 5;

// Global settings: the set of providers plus which one to use by default.
export interface Settings {
  defaultProvider?: string;
  providers: Record<string, ProviderSettings>;
  mcpServers?: MCPServerSettingsEntry[];
  // Per-phase model overrides for workflows. Keyed by profile name, then by
  // workflow step profile key. Example:
  //   { "fast": { "implement": "gpt-4o-mini", "review": "gpt-4o" } }
  // Each workflow step may declare a `profile` field; at execution time the
  // runtime resolves the model by looking up workflowProfiles[activeProfile][step.profile].
  workflowProfiles?: Record<string, Record<string, string>>;
  // Per-plugin configuration, keyed by plugin id. Holds the enabled flag and any
  // credentials the plugin's manifest declares (e.g. an Exa API key). Lives in
  // the global settings file because it carries secrets; the /plugins UI writes
  // it. Plugins themselves are auto-discovered from the plugins directories.
  plugins?: Record<string, PluginConfig>;
  // Explicit plugin paths (file or directory) to load in addition to the
  // auto-discovered plugin directories. Added through the /plugins UI so a
  // plugin can be registered from anywhere on disk, not just by dropping it
  // into .corbits/plugins/.
  pluginPaths?: string[];
  // Per-hook enable/disable state, keyed by LifecycleHook.id (its discovered file
  // path). Absent entry means enabled (matches discovery's default). Written by
  // the /hooks UI; discovery re-seeds each hook's initial LifecycleHookStatus from
  // this on every launch.
  hooks?: Record<string, { enabled: boolean }>;
  // When true, also discover plugins listed in ~/.claude/plugins/installed_plugins.json
  // (Claude Code marketplace installs under the cache). Default false — opt-in so
  // Corbits Code never silently imports a large third-party plugin set. Discovered
  // modules still require settings.plugins[id].enabled before agents/tools wire.
  discoverClaudePlugins?: boolean;
  // Id of the plugin (kind "web") to use as the web_search/web_fetch backend.
  // When unset, the single enabled web plugin is used; when no web plugin is
  // enabled, the built-in local provider is used.
  web?: string;

  // Slash commands to suppress from the command palette and completions.
  // The commands still work if typed in full; they are just not listed.
  hiddenCommands?: string[];
  // Set after the first launch's welcome animation + provider modal has been
  // shown. Controls whether subsequent launches show "Welcome to" vs "Welcome back".
  onboarded?: boolean;
  // Last package version whose release notes were shown (or stamped on first
  // interactive install). Upgrade stamps only after notes are actually shown
  // so a missing surface cannot silently swallow them (CL-5475).
  lastChangelogVersion?: string;
  // Controls the context-compaction strategy used when the context window fills.
  // "llm" (default) generates a structured handoff summary via LLM call.
  // "pruning" uses fast deterministic pruning with no LLM call.
  compactionMode?: "llm" | "pruning";
  // Deprecated (CL-5814): orchestrator is the only product path. Legacy values
  // may still appear in on-disk settings and are ignored at resolve time; new
  // writes should omit this field. Kept on the type so old files still load.
  sessionMode?: SessionMode;
  // When an agent profile pins a provider/model combo (via its `inference`
  // field) and none of the listed legs are available in the user's configured
  // providers, this controls what happens. "active" (default) silently falls
  // back to whatever the user's main session is currently using so the agent
  // still runs; "none" treats it as a hard error and the profile fails to load.
  agentModelFallback?: "active" | "none";
  // Shell command timeouts. `timeoutMs` is the optional default applied when the
  // model does not pass a per-command timeout (unset = no default timeout, match
  // Pi). `maxTimeoutMs` clamps a resolved timeout only — it alone does not invent
  // one. A single command with neither settings default nor a per-call timeout
  // runs until exit, abort, or the outer tool watchdog (when configured).
  shell?: { timeoutMs?: number; maxTimeoutMs?: number };
  // Outer wall-clock budget for each tool `run()` (dynamic runner / agent dispatch).
  //
  // waitForApproval (default true when unset): freeze this budget while a
  // permission prompt is open so a late approve still runs the tool. When false,
  // the budget keeps ticking during the prompt; if it expires first the tool is
  // skipped and the prompt is dismissed.
  tools?: { timeoutMs?: number; maxTimeoutMs?: number; waitForApproval?: boolean };
  // Wall-clock budget for MCP tool calls specifically (mcp__* names). Unlike
  // the generic `tools` budget, this one is armed by default (see
  // DEFAULT_MCP_TOOL_TIMEOUT_MS) since a wedged MCP server otherwise hangs a
  // tool call forever with nothing to bound it.
  mcp?: { timeoutMs?: number };
  // Anonymous PostHog telemetry. Global only — never written to per-repo
  // local settings. `enabled` defaults to true (opt-out); `installationId`
  // is a random UUID generated once on first use; `noticeShown` stamps that
  // the first-run notice has already been shown.
  telemetry?: {
    enabled?: boolean;
    installationId?: string;
    noticeShown?: boolean;
  };
  // Opt-in OTEL export (operator-owned collector). Separate from PostHog product
  // telemetry. Prefer OTEL_* env vars for secrets; see docs/PERFTRACE.md.
  // Local PerfTrace remains always-on regardless of this block.
  otel?: {
    enabled?: boolean;
    endpoint?: string;
    headers?: Record<string, string>;
    serviceName?: string;
    resourceAttributes?: Record<string, string>;
  };
  // Models-first /model picker: most-recently-used provider+model pairs (newest
  // first). Global preference only — no credentials. Cap stored list (~10);
  // UI surfaces fewer via listRecentModels.
  recentModels?: ModelRef[];
  // Operator-starred provider+model pairs for the models-first picker.
  favoriteModels?: ModelRef[];
  // Show the running session cost next to the context percentage in the
  // prompt border's bottom rule. Default false: `/cost` still gives the full
  // breakdown on demand, so the border only needs to opt in to the running
  // total.
  showPromptCost?: boolean;
  // User-global YOLO default; `/yolo` writes it.
  dangerouslySkipPermissions?: boolean;
}

function modelRefKey(ref: ModelRef): string {
  return `${ref.provider}\0${ref.model}`;
}

// Newest first, deduped by provider+model, capped at `max` (default 10).
export function pushRecentModel(
  settings: Settings,
  ref: ModelRef,
  max: number = DEFAULT_RECENT_MODELS_STORED,
): Settings {
  const next: ModelRef = { provider: ref.provider, model: ref.model };
  const rest = (settings.recentModels ?? []).filter((r) => modelRefKey(r) !== modelRefKey(next));
  return {
    ...settings,
    recentModels: [next, ...rest].slice(0, Math.max(0, max)),
  };
}

// Add the pair if absent; remove it if present.
export function toggleFavoriteModel(settings: Settings, ref: ModelRef): Settings {
  const next: ModelRef = { provider: ref.provider, model: ref.model };
  const key = modelRefKey(next);
  const current = settings.favoriteModels ?? [];
  const has = current.some((r) => modelRefKey(r) === key);
  return {
    ...settings,
    favoriteModels: has ? current.filter((r) => modelRefKey(r) !== key) : [...current, next],
  };
}

export function setDefaultModel(settings: Settings, ref: ModelRef): Settings {
  const next: ModelRef = { provider: ref.provider, model: ref.model };
  const existing = settings.providers[next.provider];
  return {
    ...settings,
    defaultProvider: next.provider,
    ...(existing !== undefined
      ? {
          providers: {
            ...settings.providers,
            [next.provider]: { ...existing, defaultModel: next.model },
          },
        }
      : {}),
  };
}

export function listRecentModels(
  settings: Settings,
  max: number = DEFAULT_RECENT_MODELS_SHOWN,
): ModelRef[] {
  return (settings.recentModels ?? []).slice(0, Math.max(0, max));
}

export function listFavoriteModels(settings: Settings): ModelRef[] {
  return settings.favoriteModels ?? [];
}

// Maps the settings shell block to the shape the shell-guard plugin expects.
// Returns undefined when unset so the plugin arms no default timeout.
export function shellTimeoutFromSettings(
  settings?: Settings | null,
): { defaultMs?: number; maxMs?: number } | undefined {
  const shell = settings?.shell;
  if (shell === undefined) return undefined;
  return {
    ...(shell.timeoutMs !== undefined ? { defaultMs: shell.timeoutMs } : {}),
    ...(shell.maxTimeoutMs !== undefined ? { maxMs: shell.maxTimeoutMs } : {}),
  };
}

// Maps the settings tools/mcp blocks to the shape the tool-execution watchdog
// expects. Returns undefined only when nothing at all is configured so callers
// can skip the override; mcp.timeoutMs alone (with no tools.* set) still
// produces a config, since MCP timeouts are armed unconditionally.
export function toolWatchdogFromSettings(
  settings?: Settings | null,
):
  | { defaultMs?: number; maxMs?: number; waitForApproval?: boolean; mcpTimeoutMs?: number }
  | undefined {
  const tools = settings?.tools;
  const mcpTimeoutMs = settings?.mcp?.timeoutMs;
  const hasTimeout = tools?.timeoutMs !== undefined || tools?.maxTimeoutMs !== undefined;
  const hasWait = tools?.waitForApproval !== undefined;
  if (!hasTimeout && !hasWait && mcpTimeoutMs === undefined) return undefined;
  return {
    ...(tools?.timeoutMs !== undefined ? { defaultMs: tools.timeoutMs } : {}),
    ...(tools?.maxTimeoutMs !== undefined ? { maxMs: tools.maxTimeoutMs } : {}),
    ...(tools?.waitForApproval !== undefined ? { waitForApproval: tools.waitForApproval } : {}),
    ...(mcpTimeoutMs !== undefined ? { mcpTimeoutMs } : {}),
  };
}

// Maps settings.env (per-project) to the extra env vars the shell-guard plugin
// merges into the run_shell spawn environment. Returns undefined when unset so
// callers can skip the override and inherit process.env unmodified.
export function shellEnvFromSettings(
  local?: LocalSettings | null,
): Record<string, string> | undefined {
  return local?.env;
}

export interface PluginConfig {
  enabled?: boolean;
  // One-time consent for a tool plugin (kind "tool"). Its tools add in-process
  // capabilities to the agent, so they are only wired in once the user has
  // consented in the /plugins UI. Ignored for other kinds.
  consented?: boolean;
  credentials?: Record<string, string>;
}

// An MCP server is reached one of two ways. A stdio server is launched as a
// subprocess (`command` + `args`). An http server is a remote Streamable-HTTP
// endpoint (`url`) that corbits connects to directly and authorizes via OAuth.
// `type` defaults to "stdio" when `command` is set and "http" when only `url` is.
export interface MCPServerConfig {
  name: string;
  type?: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export interface ExaMCPPresetConfig {
  name: typeof EXA_MCP_SERVER_NAME;
  enabled: boolean;
}

export type MCPServerSettingsEntry = MCPServerConfig | ExaMCPPresetConfig;

// Per-repo override. Selection only for provider/model, but may also declare
// MCP servers to connect at session start.
export interface LocalSettings {
  provider?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  mcpServers?: MCPServerSettingsEntry[];
  sessionMode?: SessionMode;
  // Per-project env vars applied to the run_shell tool's spawn environment (in
  // addition to the process's own inherited environment). Configuration
  // instead of a shell command that mutates the environment mid-session.
  env?: Record<string, string>;
}

// The provider fields the runtime consumes, identical to what the env vars used
// to supply directly.
export interface ResolvedProvider {
  apiKey: string;
  baseURL: string;
  model: string;
  providerName: string;
  keyless?: boolean;
  verified?: boolean;
}

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
  return join(home, SETTINGS_DIR_NAME, "settings.json");
}

export function localSettingsPath(cwd: string): string {
  return join(cwd, SETTINGS_DIR_NAME, "settings.json");
}

function physicalPathIdentity(path: string): string {
  let candidate = resolve(path);
  const missingSegments: string[] = [];

  while (true) {
    try {
      return join(realpathSync.native(candidate), ...missingSegments.reverse());
    } catch (err) {
      if (!isENOENT(err)) throw err;
      const parent = dirname(candidate);
      if (parent === candidate) return resolve(path);
      missingSegments.push(basename(candidate));
      candidate = parent;
    }
  }
}

export function resolveLocalSettingsPath(cwd: string, globalPath: string): string | null {
  const localPath = localSettingsPath(cwd);
  return physicalPathIdentity(localPath) === physicalPathIdentity(globalPath) ? null : localPath;
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
  "apiKey?": "string",
  models: "string[]",
  "defaultModel?": "string",
  "keyless?": "boolean",
  "free?": "boolean",
  "contextWindow?": "number",
  "bifrostVirtualKey?": "boolean",
  "anthropic?": "boolean",
  "opencodeGo?": "boolean",
  "verified?": "boolean",
});

const ModelRefSchema = type({
  provider: "string",
  model: "string",
});

const SettingsSchema = type({
  "defaultProvider?": "string",
  providers: type({ "[string]": ProviderSettingsSchema }),
  // mcpServers accepts both array and object forms, so it is validated by
  // normalizeMcpServers rather than expressed structurally here.
  "mcpServers?": "unknown",
  // Model tiers were removed; an older settings file may still carry this key.
  // Accepted and ignored so the file still loads, then dropped on next save.
  "tiers?": "unknown",
  "workflowProfiles?": type({ "[string]": type({ "[string]": "string" }) }),
  "plugins?": type({
    "[string]": type({
      "enabled?": "boolean",
      "consented?": "boolean",
      "credentials?": type({ "[string]": "string" }),
    }),
  }),
  "pluginPaths?": "string[]",
  "hooks?": type({ "[string]": type({ enabled: "boolean" }) }),
  "discoverClaudePlugins?": "boolean",
  "web?": "string",
  "hiddenCommands?": "string[]",
  "onboarded?": "boolean",
  "lastChangelogVersion?": "string",
  "compactionMode?": "'llm' | 'pruning'",
  // Legacy disk values still load; product resolve ignores them (CL-5814).
  "sessionMode?": "'single' | 'orchestrator'",

  "agentModelFallback?": "'active' | 'none'",
  "shell?": type({ "timeoutMs?": "number", "maxTimeoutMs?": "number" }),
  "tools?": type({
    "timeoutMs?": "number",
    "maxTimeoutMs?": "number",
    "waitForApproval?": "boolean",
  }),
  "mcp?": type({
    "timeoutMs?": "number",
  }),
  "telemetry?": type({
    "enabled?": "boolean",
    "installationId?": "string",
    "noticeShown?": "boolean",
  }),
  "otel?": type({
    "enabled?": "boolean",
    "endpoint?": "string",
    "headers?": "Record<string, string>",
    "serviceName?": "string",
    "resourceAttributes?": "Record<string, string>",
  }),
  "recentModels?": ModelRefSchema.array(),
  "favoriteModels?": ModelRefSchema.array(),
  "showPromptCost?": "boolean",
  "dangerouslySkipPermissions?": "boolean",
});

// Per-entry MCP shape without the name key. The "exactly one transport" rule is
// a cross-field constraint enforced after the structural check.
const McpEntrySchema = type({
  "enabled?": "boolean",
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
  // Legacy disk values still load; product resolve ignores them (CL-5814).
  "sessionMode?": "'single' | 'orchestrator'",

  "env?": "Record<string, string>",
  // Reject any other key so local settings can never smuggle credentials.
  "+": "reject",
});

export function isSettings(value: unknown): value is Settings {
  if (!SettingsSchema.allows(value)) return false;
  const s = value as Record<string, unknown>;
  if (s.mcpServers !== undefined && normalizeMcpServers(s.mcpServers) === undefined) return false;
  // Legacy "single" | "orchestrator" still load; product resolve ignores them.
  if (
    s.sessionMode !== undefined &&
    s.sessionMode !== "single" &&
    s.sessionMode !== "orchestrator"
  ) {
    return false;
  }

  return true;
}

function isMCPServerConfigEntry(
  name: string,
  value: unknown,
): value is Omit<MCPServerSettingsEntry, "name"> {
  if (!McpEntrySchema.allows(value)) return false;
  const s = value as Record<string, unknown>;
  if (s.enabled !== undefined) {
    return (
      name === EXA_MCP_SERVER_NAME &&
      s.type === undefined &&
      s.command === undefined &&
      s.args === undefined &&
      s.env === undefined &&
      s.url === undefined
    );
  }
  // Exactly one transport must be specified.
  const isHttp = s.type === "http" || (s.type === undefined && typeof s.url === "string");
  return isHttp ? typeof s.url === "string" : typeof s.command === "string";
}

function isMCPServerConfigWithKey(value: unknown): value is MCPServerSettingsEntry {
  if (typeof value !== "object" || value === null) return false;
  const name = (value as Record<string, unknown>).name;
  if (typeof name !== "string") return false;
  return isMCPServerConfigEntry(name, value);
}

function normalizeMcpEntry(name: string, entry: Record<string, unknown>): MCPServerSettingsEntry {
  if (entry.enabled !== undefined) {
    return { name: EXA_MCP_SERVER_NAME, enabled: entry.enabled as boolean };
  }
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
export function normalizeMcpServers(value: unknown): MCPServerSettingsEntry[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    if (!value.every(isMCPServerConfigWithKey)) return undefined;
    return value.map((v) => {
      const entry = v as unknown as Record<string, unknown>;
      return normalizeMcpEntry(entry.name as string, entry);
    });
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const entries: MCPServerSettingsEntry[] = [];
    for (const [key, val] of Object.entries(obj)) {
      if (typeof key !== "string") return undefined;
      if (!isMCPServerConfigEntry(key, val)) return undefined;
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
  // Legacy "single" | "orchestrator" still load; product resolve ignores them.
  if (
    s.sessionMode !== undefined &&
    s.sessionMode !== "single" &&
    s.sessionMode !== "orchestrator"
  ) {
    return false;
  }

  return true;
}

// Drop keys whose value is undefined so JSON omit + optional Settings fields stay
// aligned. Value transforms (normalize, clamp, enum checks) happen before this —
// the helper only filters undefined, it does not validate.
type DefinedFields<T> = {
  [K in keyof T as undefined extends T[K] ? (T[K] extends undefined ? never : K) : K]: Exclude<
    T[K],
    undefined
  >;
};

function pickDefined<T extends Record<string, unknown>>(fields: T): DefinedFields<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) out[key] = value;
  }
  return out as DefinedFields<T>;
}

// Every optional Settings key must appear here so a new type field without a
// load-path assignment fails at compile time instead of silently dropping on
// the next load/save cycle.
type OptionalSettingsFields = {
  [K in Exclude<keyof Settings, "providers">]: Settings[K] | undefined;
};

type OptionalLocalSettingsFields = {
  [K in keyof LocalSettings]: LocalSettings[K] | undefined;
};

/** Optional global settings keys the load path is required to consider. */
export const GLOBAL_SETTINGS_OPTIONAL_KEYS = [
  "defaultProvider",
  "mcpServers",
  "workflowProfiles",
  "plugins",
  "pluginPaths",
  "hooks",
  "discoverClaudePlugins",
  "web",
  "hiddenCommands",
  "onboarded",
  "lastChangelogVersion",
  "compactionMode",
  "sessionMode",
  "agentModelFallback",
  "shell",
  "tools",
  "telemetry",
  "otel",
  "recentModels",
  "favoriteModels",
  "dangerouslySkipPermissions",
] as const satisfies readonly (keyof OptionalSettingsFields)[];

/** Optional local settings keys the load path is required to consider. */
export const LOCAL_SETTINGS_OPTIONAL_KEYS = [
  "provider",
  "model",
  "reasoningEffort",
  "mcpServers",
  "sessionMode",
  "env",
] as const satisfies readonly (keyof OptionalLocalSettingsFields)[];

/**
 * Hard-cutover heal: any provider that is Go by flag, known id/label, or
 * `/zen/go` baseURL gets `opencodeGo: true` and the canonical Go baseURL.
 * Mutates `settings.providers` only when at least one entry changes.
 * Returns the names of providers that were mutated (empty when no-op).
 */
export function healOpenCodeGoProviders(settings: Settings): string[] {
  const healed: string[] = [];
  const next: Record<string, ProviderSettings> = {};
  for (const [name, provider] of Object.entries(settings.providers)) {
    const go = isOpenCodeGoProvider({
      name,
      ...(provider.opencodeGo === true ? { opencodeGo: true as const } : {}),
      baseURL: provider.baseURL,
    });
    if (!go) {
      next[name] = provider;
      continue;
    }
    const needsFlag = provider.opencodeGo !== true;
    const needsBase = provider.baseURL !== OPENCODE_GO_BASE_URL;
    if (!needsFlag && !needsBase) {
      next[name] = provider;
      continue;
    }
    healed.push(name);
    next[name] = {
      ...provider,
      baseURL: OPENCODE_GO_BASE_URL,
      opencodeGo: true,
    };
  }
  if (healed.length > 0) {
    settings.providers = next;
  }
  return healed;
}

function isClobberedLocalSelection(value: unknown): value is { provider: string; model: string } {
  if (!LocalSettingsSchema.allows(value) || typeof value !== "object" || value === null) {
    return false;
  }
  const selection = value as Record<string, unknown>;
  return (
    Object.keys(selection).length === 2 &&
    typeof selection.provider === "string" &&
    selection.provider.length > 0 &&
    typeof selection.model === "string" &&
    selection.model.length > 0
  );
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
    if (isClobberedLocalSelection(parsed)) {
      const recovered: Settings = { providers: {} };
      await saveGlobalSettings(path, recovered);
      return recovered;
    }
    throw new Error(
      `Invalid settings schema in ${path}: expected { providers: { <name>: { baseURL, apiKey, models: [...] } } }`,
    );
  }
  const s = parsed as unknown as Record<string, unknown>;
  // These keys were removed when plugins moved to discovery; they are now
  // silently dropped on the next save. Warn so a user who relied on them knows
  // to re-enable the equivalent plugins in /plugins instead of losing the
  // feature without a trace.
  if (s.workflowPlugins !== undefined || s.agentPlugins !== undefined) {
    process.stderr.write(
      `settings: "workflowPlugins"/"agentPlugins" are no longer supported and will be dropped. Install those plugins under .corbits/plugins/ (or via /plugins "add by path") and enable them in /plugins.\n`,
    );
  }
  if (s.tiers !== undefined) {
    process.stderr.write(
      `settings: "tiers" is no longer supported and will be dropped. Model tiers were removed; use /model to pick a provider and model directly.\n`,
    );
  }
  // Transforms (normalize/clamp/enum) first; pickDefined only drops undefined.
  const optional: OptionalSettingsFields = {
    defaultProvider: s.defaultProvider as string | undefined,
    mcpServers: s.mcpServers !== undefined ? normalizeMcpServers(s.mcpServers) : undefined,
    workflowProfiles: s.workflowProfiles as Settings["workflowProfiles"] | undefined,
    plugins: s.plugins as Settings["plugins"] | undefined,
    pluginPaths: s.pluginPaths as string[] | undefined,
    hooks: s.hooks as Settings["hooks"] | undefined,
    discoverClaudePlugins: s.discoverClaudePlugins === true ? true : undefined,
    web: s.web as string | undefined,
    hiddenCommands: s.hiddenCommands as string[] | undefined,
    onboarded: s.onboarded !== undefined ? Boolean(s.onboarded) : undefined,
    lastChangelogVersion:
      typeof s.lastChangelogVersion === "string" && s.lastChangelogVersion.trim().length > 0
        ? s.lastChangelogVersion.trim()
        : undefined,
    compactionMode:
      s.compactionMode === "llm" || s.compactionMode === "pruning" ? s.compactionMode : undefined,
    // CL-5814: drop legacy "single"; only keep explicit orchestrator if present.
    sessionMode: s.sessionMode === "orchestrator" ? "orchestrator" : undefined,
    agentModelFallback:
      s.agentModelFallback === "active" || s.agentModelFallback === "none"
        ? s.agentModelFallback
        : undefined,
    shell: s.shell as Settings["shell"] | undefined,
    tools: s.tools as Settings["tools"] | undefined,
    mcp: s.mcp as Settings["mcp"] | undefined,
    telemetry: s.telemetry as Settings["telemetry"] | undefined,
    otel: s.otel as Settings["otel"] | undefined,
    recentModels: s.recentModels as Settings["recentModels"] | undefined,
    favoriteModels: s.favoriteModels as Settings["favoriteModels"] | undefined,
    showPromptCost: s.showPromptCost !== undefined ? Boolean(s.showPromptCost) : undefined,
    dangerouslySkipPermissions:
      s.dangerouslySkipPermissions !== undefined
        ? Boolean(s.dangerouslySkipPermissions)
        : undefined,
  };
  const settings: Settings = {
    providers: s.providers as Settings["providers"],
    ...pickDefined(optional),
  };
  // Hard cutover: pin Go flag + canonical baseURL on disk when any Go signal matches.
  // Only rewrite disk when heal actually mutates (no write-on-read for no-op reloads).
  // Fail open on save: keep the in-memory heal so startup is not bricked by a
  // read-only or otherwise unwritable settings path.
  const healedIds = healOpenCodeGoProviders(settings);
  if (healedIds.length > 0) {
    process.stderr.write(
      `settings: healed OpenCode Go providers (${healedIds.join(", ")}) in ${path}\n`,
    );
    try {
      await saveGlobalSettings(path, settings);
    } catch {
      process.stderr.write(
        `settings: failed to persist OpenCode Go provider heal for ${path}; continuing with in-memory settings.\n`,
      );
    }
  }
  return settings;
}

/** Diagnostic produced when settings fail open instead of crashing startup. */
export interface SettingsLoadDiagnostic {
  path: string;
  message: string;
  /** Actionable recommendation for the user. */
  fix: string;
}

export interface LocalSettingsLoadResult {
  settings: LocalSettings | null;
  diagnostics: SettingsLoadDiagnostic[];
}

const LOCAL_ALLOWED_KEYS = new Set<string>(LOCAL_SETTINGS_OPTIONAL_KEYS);
const LOCAL_CREDENTIAL_KEYS = new Set([
  "apiKey",
  "api_key",
  "token",
  "secret",
  "password",
  "authorization",
]);

/** Pick known local-settings fields from a raw object (strict or fail-open). */
function pickLocalFields(
  s: Record<string, unknown>,
  mode: "strict" | "coerce",
): OptionalLocalSettingsFields {
  if (mode === "strict") {
    return {
      provider: s.provider as string | undefined,
      model: s.model as string | undefined,
      reasoningEffort: s.reasoningEffort as ReasoningEffort | undefined,
      mcpServers: s.mcpServers !== undefined ? normalizeMcpServers(s.mcpServers) : undefined,
      sessionMode: s.sessionMode === "orchestrator" ? "orchestrator" : undefined,
      env: s.env as Record<string, string> | undefined,
    };
  }
  return {
    provider: typeof s.provider === "string" ? s.provider : undefined,
    model: typeof s.model === "string" ? s.model : undefined,
    reasoningEffort: isReasoningEffort(s.reasoningEffort) ? s.reasoningEffort : undefined,
    mcpServers: s.mcpServers !== undefined ? normalizeMcpServers(s.mcpServers) : undefined,
    sessionMode: s.sessionMode === "orchestrator" ? "orchestrator" : undefined,
    env:
      s.env !== undefined && typeof s.env === "object" && s.env !== null && !Array.isArray(s.env)
        ? Object.fromEntries(
            Object.entries(s.env as Record<string, unknown>).filter(
              (e): e is [string, string] => typeof e[1] === "string",
            ),
          )
        : undefined,
  };
}

function coerceLocalSettings(path: string, parsed: unknown): LocalSettingsLoadResult {
  const diagnostics: SettingsLoadDiagnostic[] = [];
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      settings: null,
      diagnostics: [
        {
          path,
          message: `Local settings in ${path} is not a JSON object.`,
          fix: `Edit ${path} to a JSON object with only: provider, model, reasoningEffort, mcpServers, sessionMode, env.`,
        },
      ],
    };
  }
  const s = parsed as Record<string, unknown>;
  // Valid strict path still returns cleanly with no diagnostics.
  if (isLocalSettings(parsed)) {
    return { settings: pickDefined(pickLocalFields(s, "strict")), diagnostics: [] };
  }

  const unknownKeys = Object.keys(s).filter((k) => !LOCAL_ALLOWED_KEYS.has(k));
  const credentialKeys = unknownKeys.filter(
    (k) => LOCAL_CREDENTIAL_KEYS.has(k) || /key|token|secret|password/i.test(k),
  );
  const otherUnknown = unknownKeys.filter((k) => !credentialKeys.includes(k));
  if (credentialKeys.length > 0) {
    diagnostics.push({
      path,
      message: `Ignored credential field(s) in local settings (${credentialKeys.join(", ")}).`,
      fix: "Keep credentials out of local .corbits/settings.json — store API keys via provider settings / keychain, not local selection files.",
    });
  }
  if (otherUnknown.length > 0) {
    diagnostics.push({
      path,
      message: `Ignored unknown local settings key(s): ${otherUnknown.join(", ")}.`,
      fix: `Remove unknown keys from ${path}. Allowed keys: ${[...LOCAL_ALLOWED_KEYS].join(", ")}.`,
    });
  }

  const optional = pickLocalFields(s, "coerce");
  if (s.mcpServers !== undefined && optional.mcpServers === undefined) {
    diagnostics.push({
      path,
      message: `mcpServers in ${path} was invalid and was ignored.`,
      fix: "Use an object map of MCP server entries (command/args or url).",
    });
  }
  if (s.reasoningEffort !== undefined && optional.reasoningEffort === undefined) {
    diagnostics.push({
      path,
      message: `reasoningEffort in ${path} was invalid and was ignored.`,
      fix: `Use one of: ${REASONING_EFFORTS.join(", ")}.`,
    });
  }
  if (diagnostics.length === 0) {
    // Shape failed isLocalSettings for another reason (e.g. wrong types).
    diagnostics.push({
      path,
      message: `Local settings in ${path} had invalid values and were partially ignored.`,
      fix: `Edit ${path}: only "provider", "model", "reasoningEffort", "mcpServers", "sessionMode", and "env" are allowed (no credentials).`,
    });
  }
  const settings = pickDefined(optional);
  return { settings: Object.keys(settings).length > 0 ? settings : null, diagnostics };
}

export async function loadLocalSettingsResult(path: string): Promise<LocalSettingsLoadResult> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (isENOENT(err)) return { settings: null, diagnostics: [] };
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      settings: null,
      diagnostics: [
        {
          path,
          message: `Invalid JSON in local settings file: ${path}`,
          fix: `Fix JSON syntax in ${path}, or delete the file to fall back to global settings only.`,
        },
      ],
    };
  }
  return coerceLocalSettings(path, parsed);
}

export async function loadLocalSettings(path: string): Promise<LocalSettings | null> {
  // Fail open: never throw for schema/unknown-key problems. Callers that need
  // diagnostics should use loadLocalSettingsResult.
  const { settings } = await loadLocalSettingsResult(path);
  return settings;
}

// Resolve the base for a read-modify-write of the local selection file.
// Absent file → empty base (create OK). Partial fail-open → cleaned fields.
// Invalid JSON / unreadable / fully unusable → null so the caller skips the
// write instead of collapsing to {} and wiping the file.
export async function loadLocalSettingsWriteBase(path: string): Promise<LocalSettings | null> {
  try {
    const result = await loadLocalSettingsResult(path);
    if (result.settings !== null) return result.settings;
    // Absent (ENOENT) returns null settings with empty diagnostics.
    if (result.diagnostics.length === 0) return {};
    return null;
  } catch {
    return null;
  }
}

// Resolve the base for a read-modify-write of the global settings file.
// An absent file yields a fresh minimal base; an unreadable or invalid file
// yields null so the caller skips the write — falling back to a minimal base
// there would overwrite the whole file to flip one key.
export async function loadGlobalSettingsWriteBase(path: string): Promise<Settings | null> {
  try {
    return (await loadSettings(path)) ?? { providers: {} };
  } catch {
    return null;
  }
}

// Upsert one provider onto existing settings without dropping plugins,
// pluginPaths, sessionMode, shell, tools, or any other non-provider field.
// Used by first-run onboarding (and any similar single-provider write).
export function mergeProviderIntoSettings(
  existing: Settings | null | undefined,
  providerName: string,
  provider: ProviderSettings,
): Settings {
  const base: Settings = existing ?? { providers: {} };
  return {
    ...base,
    defaultProvider: providerName,
    providers: { ...base.providers, [providerName]: provider },
  };
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

// Silent helper: callers log or notice. Skips when the write base is null so a
// corrupt settings file is never replaced with a one-key rewrite.
export async function persistSkipPermissionsDefault(
  path: string,
  value: boolean,
): Promise<"ok" | "skipped"> {
  const base = await loadGlobalSettingsWriteBase(path);
  if (base === null) return "skipped";
  await saveGlobalSettings(path, { ...base, dangerouslySkipPermissions: value });
  return "ok";
}

// Stamp the global `onboarded` flag. Reads the on-disk global settings fresh
// (never an in-memory Settings that may carry injected OAuth provider entries
// with short-lived access tokens) and re-saves with onboarded set. When the
// file is absent a minimal valid Settings is written, so no provider — and thus
// no credential — is ever invented here.
export async function markOnboarded(path: string): Promise<void> {
  const onDisk = await loadSettings(path);
  const base: Settings = onDisk ?? { providers: {} };
  await saveGlobalSettings(path, { ...base, onboarded: true });
}

/** Persist the package version whose release notes were last shown (or stamped on first install). */
export async function markLastChangelogVersion(path: string, version: string): Promise<void> {
  const trimmed = version.trim();
  if (trimmed.length === 0) return;
  const onDisk = await loadSettings(path);
  const base: Settings = onDisk ?? { providers: {} };
  if (base.lastChangelogVersion === trimmed) return;
  await saveGlobalSettings(path, { ...base, lastChangelogVersion: trimmed });
}

// Ensure a persisted telemetry installationId exists, generating and saving
// one on first use. Reads the on-disk global settings fresh (same rationale
// as markOnboarded: never trust an in-memory Settings that may carry injected
// credentials). Returns the settings with telemetry.installationId set.
export async function ensureTelemetrySettings(path: string): Promise<Settings> {
  const onDisk = await loadSettings(path);
  const base: Settings = onDisk ?? { providers: {} };
  // Read-then-write, not read-then-lock: two concurrent first launches could
  // each generate a different installationId and the second save wins. This
  // only matters once, at first run, and the cost of colliding is a rare
  // duplicate distinct_id rather than any correctness or security issue, so
  // it's accepted rather than adding cross-process locking for it.
  if (base.telemetry?.installationId !== undefined) return base;
  const next: Settings = {
    ...base,
    telemetry: { ...base.telemetry, installationId: randomUUID() },
  };
  await saveGlobalSettings(path, next);
  return next;
}

// Stamp the global telemetry first-run notice as shown, without disturbing
// any other telemetry field or settings.
export async function markTelemetryNoticeShown(path: string): Promise<void> {
  const onDisk = await loadSettings(path);
  const base: Settings = onDisk ?? { providers: {} };
  if (base.telemetry?.noticeShown === true) return;
  await saveGlobalSettings(path, {
    ...base,
    telemetry: { ...base.telemetry, noticeShown: true },
  });
}

// Persist the per-repo provider/model selection. This is where the /agent modal
// writes a "default for this project": selection only, never credentials, so
// the file stays safe to leave gitignored in the repo. Validated before writing
// so a written file always round-trips back through loadLocalSettings, and
// written via temp-file + rename so a concurrent reader never sees a torn file.
export async function saveLocalSettings(path: string, local: LocalSettings): Promise<void> {
  if (!isLocalSettings(local)) {
    throw new Error(
      `Refusing to write invalid local settings: only "provider", "model", "reasoningEffort", "mcpServers", and "sessionMode" are allowed.`,
    );
  }
  const payload = JSON.stringify(local, null, 2);
  const tmp = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmp, payload);
  await rename(tmp, path);
}

export interface ResolveInput {
  // Provider definitions, from the --config file when given, otherwise global.
  settings: Settings | null;
  // Per-repo selection override.
  local: LocalSettings | null;
  // Highest-priority selection from CLI flags.
  cli: { provider?: string; model?: string };
}

// Resolve the active provider. Precedence per field (highest first):
//   providerName: --provider > local > settings.defaultProvider > sole provider
//   model:        --model    > local > provider.defaultModel    > provider.models[0]
//   baseURL/apiKey: from the selected provider only
// Credentials and provider definitions come exclusively from the settings
// catalog; environment variables have no influence on resolution.
export function resolveProvider(input: ResolveInput): ResolvedProvider {
  const { settings, local, cli } = input;
  const providers = settings?.providers ?? {};
  const providerKeys = Object.keys(providers);
  const soleKey = providerKeys.length === 1 ? providerKeys[0] : undefined;

  if (cli.provider !== undefined && settings !== null && providers[cli.provider] === undefined) {
    const available = providerKeys.length > 0 ? providerKeys.join(", ") : "none";
    throw new Error(`Provider "${cli.provider}" not found in settings (available: ${available}).`);
  }

  const providerName = cli.provider ?? local?.provider ?? settings?.defaultProvider ?? soleKey;

  const selected = providerName !== undefined ? providers[providerName] : undefined;

  const go = isOpenCodeGoProvider({
    ...(providerName !== undefined ? { name: providerName } : {}),
    ...(selected?.opencodeGo === true ? { opencodeGo: true as const } : {}),
    ...(selected?.baseURL !== undefined ? { baseURL: selected.baseURL } : {}),
  });
  const baseURL = go ? OPENCODE_GO_BASE_URL : selected?.baseURL;
  const apiKey = selected?.apiKey;
  const keyless = selected?.keyless === true;
  const model = cli.model ?? local?.model ?? resolveDefaultModel(selected);

  // A provider name was selected (from local file or defaultProvider) but is not
  // actually configured — distinguish this from "nothing configured at all" so
  // the operator gets an actionable message instead of a generic missing-creds one.
  const selectedMissing =
    providerName !== undefined && settings !== null && providers[providerName] === undefined;

  const missingApiKey = !keyless && (apiKey === undefined || apiKey.length === 0);
  if (
    providerName === undefined ||
    providerName.length === 0 ||
    baseURL === undefined ||
    baseURL.length === 0 ||
    missingApiKey ||
    model === undefined ||
    model.length === 0
  ) {
    const missing: string[] = [];
    if (providerName === undefined || providerName.length === 0) missing.push("provider");
    if (baseURL === undefined || baseURL.length === 0) missing.push("baseURL");
    if (missingApiKey) missing.push("apiKey");
    if (model === undefined || model.length === 0) missing.push("model");
    const detail = selectedMissing
      ? ` Selected provider "${providerName}" is not configured in settings (available: ${
          Object.keys(providers).join(", ") || "none"
        }).`
      : "";
    throw new Error(
      `Could not resolve an inference provider (missing: ${missing.join(", ")}).${detail} ` +
        `Configure a provider in ${globalSettingsPath()}. ` +
        `See docs/IMPLEMENTATION.md.`,
    );
  }

  return {
    providerName,
    baseURL: go ? OPENCODE_GO_BASE_URL : normalizeOpenAICompatibleBaseURL(baseURL),
    apiKey: apiKey ?? "",
    model,
    ...(keyless ? { keyless: true } : {}),
    ...(selected?.verified === false ? { verified: false } : {}),
  };
}

import type { InferenceSpec } from "../agent/profile-types.js";

// A resolved inference leg, with reasoningEffort threaded through.
export interface ResolvedInference {
  provider: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
}

// True when the configured providers actually expose this provider+model.
function isLegViable(leg: { provider: string; model: string }, settings: Settings): boolean {
  const p = settings.providers[leg.provider];
  if (p === undefined) return false;
  // Empty models list = accept anything (e.g. an unrestricted gateway).
  if (p.models.length === 0) return true;
  return p.models.includes(leg.model);
}

// The dispatch-time outcome of resolving an agent's inference spec. `kind`
// tells the caller what to do when no leg was viable, taking the spec's
// `mode` and the global `agentModelFallback` setting into account:
//
//   - "resolved"      — a viable leg was found, returned in `value`.
//   - "fallback"      — no viable leg, but the agent permits fallback (the
//                       caller falls through to the active session's model).
//   - "unavailable"   — no viable leg, and the spec forbids fallback
//                       (`mode: "pin"` or `agentModelFallback: "none"`). The
//                       caller must surface this as an error rather than
//                       silently run on the wrong provider.
export type ResolvedInferenceOutcome =
  | { kind: "resolved"; value: ResolvedInference }
  | { kind: "fallback" }
  | { kind: "unavailable"; reason: string };

// Resolve an agent's pinned inference spec against the configured providers.
// See ResolvedInferenceOutcome for the policy encoded in the result kind.
export function resolveInferenceSpec(
  spec: InferenceSpec | undefined,
  settings: Settings,
): ResolvedInference | null {
  if (spec === undefined) return null;
  for (const leg of spec.order) {
    if (isLegViable(leg, settings)) {
      return {
        provider: leg.provider,
        model: leg.model,
        ...(leg.reasoningEffort !== undefined ? { reasoningEffort: leg.reasoningEffort } : {}),
      };
    }
  }
  return null;
}

// Resolve with policy. Used by the sub-agent dispatcher to decide between
// fallback and hard failure based on the spec's mode and the user's setting.
export function resolveInferenceWithPolicy(
  spec: InferenceSpec | undefined,
  settings: Settings,
): ResolvedInferenceOutcome {
  if (spec === undefined) return { kind: "fallback" };
  const resolved = resolveInferenceSpec(spec, settings);
  if (resolved !== null) return { kind: "resolved", value: resolved };

  // No viable leg. `mode: "pin"` and `agentModelFallback: "none"` both mean
  // "do not silently fall through"; any other combination permits fallback.
  const forbidFallback = spec.mode === "pin" || settings.agentModelFallback === "none";
  if (forbidFallback) {
    const legs = spec.order.map((l) => `${l.provider}/${l.model}`).join(", ");
    return {
      kind: "unavailable",
      reason: `none of the configured providers expose the requested model(s): ${legs}`,
    };
  }
  return { kind: "fallback" };
}
