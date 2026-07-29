import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { type } from "arktype";

import { SETTINGS_DIR_NAME } from "../branding.js";
import { REASONING_EFFORTS, type ReasoningEffort } from "../provider/reasoning-effort.js";
import { isSessionMode, type SessionMode } from "./session-mode.js";

// A configured inference provider. `apiKey` is secret and lives only in the
// global settings file; `baseURL` is editable provider metadata that lives with
// it. `models` is always an array so single-model and multi-model providers are
// handled uniformly; `defaultModel` (or the first entry) is used when no model
// is selected.
export type ProviderSettings = {
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
};

export type ProviderTier = "fast" | "standard" | "clever";
export type TierAssignment = { provider: string; model: string; reasoningEffort?: ReasoningEffort };
export type TierSelectionMode = "pin" | "prefer";
export type TierProviderRef = { provider: string; model: string; reasoningEffort?: ReasoningEffort };
export type TierDefinition = {
  mode?: TierSelectionMode;
  order: TierProviderRef[];
};
export type TierConfig = TierAssignment | TierDefinition;

export const PROVIDER_TIERS: readonly ProviderTier[] = ["fast", "standard", "clever"];

// Global settings: the set of providers plus which one to use by default.
export type Settings = {
  defaultProvider?: string;
  providers: Record<string, ProviderSettings>;
  mcpServers?: MCPServerConfig[];
  tiers?: Partial<Record<ProviderTier, TierConfig>>;
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
  // Controls the context-compaction strategy used when the context window fills.
  // "llm" (default) generates a structured handoff summary via LLM call.
  // "pruning" uses fast deterministic pruning with no LLM call.
  compactionMode?: "llm" | "pruning";
  maxConcurrentSubAgents?: number;
  // Default inference-turn budget for leaf sub-agents (not the parent session limit).
  subagentMaxTurns?: number;
  // Primary session behavior: single agent does work in-session; orchestrator
  // delegates via task and manages a worker fleet. When unset, the TUI prompts
  // once at startup.
  sessionMode?: SessionMode;
  // When an agent profile pins a provider/model combo (via its `inference`
  // field) and none of the listed legs are available in the user's configured
  // providers, this controls what happens. "active" (default) silently falls
  // back to whatever the user's main session is currently using so the agent
  // still runs; "none" treats it as a hard error and the profile fails to load.
  agentModelFallback?: "active" | "none";
  // Shell command timeouts. `timeoutMs` is the default applied when the model
  // does not pass a per-command timeout; `maxTimeoutMs` caps any per-command
  // override so a single command cannot wait effectively unbounded.
  shell?: { timeoutMs?: number; maxTimeoutMs?: number };
  // Outer wall-clock budget for each tool `run()` (dynamic runner / agent dispatch).
  //
  // waitForApproval (default true when unset): freeze this budget while a
  // permission prompt is open so a late approve still runs the tool. When false,
  // the budget keeps ticking during the prompt; if it expires first the tool is
  // skipped and the prompt is dismissed.
  tools?: { timeoutMs?: number; maxTimeoutMs?: number; waitForApproval?: boolean };
  // Anonymous PostHog telemetry. Global only — never written to per-repo
  // local settings. `enabled` defaults to true (opt-out); `installationId`
  // is a random UUID generated once on first use; `noticeShown` stamps that
  // the first-run notice has already been shown.
  telemetry?: {
    enabled?: boolean;
    installationId?: string;
    noticeShown?: boolean;
  };
};

// Maps the settings shell block to the shape the shell-guard plugin expects.
// Returns undefined when unset so the plugin applies its own defaults.
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

// Maps the settings tools block to the shape the tool-execution watchdog expects.
// Returns undefined when nothing is configured so callers can skip the override.
export function toolWatchdogFromSettings(
  settings?: Settings | null,
): { defaultMs?: number; maxMs?: number; waitForApproval?: boolean } | undefined {
  const tools = settings?.tools;
  if (tools === undefined) return undefined;
  const hasTimeout = tools.timeoutMs !== undefined || tools.maxTimeoutMs !== undefined;
  const hasWait = tools.waitForApproval !== undefined;
  if (!hasTimeout && !hasWait) return undefined;
  return {
    ...(tools.timeoutMs !== undefined ? { defaultMs: tools.timeoutMs } : {}),
    ...(tools.maxTimeoutMs !== undefined ? { maxMs: tools.maxTimeoutMs } : {}),
    ...(tools.waitForApproval !== undefined ? { waitForApproval: tools.waitForApproval } : {}),
  };
}

/** Default true: freeze the tool budget while a permission prompt is open. */
export function resolveWaitForApproval(settings?: Settings | null): boolean {
  return settings?.tools?.waitForApproval !== false;
}

export const DEFAULT_MAX_CONCURRENT_SUB_AGENTS = 10;

export function clampMaxConcurrentSubAgents(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_CONCURRENT_SUB_AGENTS;
  return Math.max(0, Math.floor(value));
}

export function resolveMaxConcurrentSubAgents(settings?: Settings | null): number {
  if (settings?.maxConcurrentSubAgents === undefined) {
    return DEFAULT_MAX_CONCURRENT_SUB_AGENTS;
  }
  return clampMaxConcurrentSubAgents(settings.maxConcurrentSubAgents);
}

export const DEFAULT_SUBAGENT_MAX_TURNS = 30;
export const MAX_SUBAGENT_MAX_TURNS_CAP = 100;

export function clampSubAgentMaxTurns(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SUBAGENT_MAX_TURNS;
  return Math.min(MAX_SUBAGENT_MAX_TURNS_CAP, Math.max(1, Math.floor(value)));
}

export function resolveDefaultSubAgentMaxTurns(settings?: Settings | null): number {
  if (settings?.subagentMaxTurns === undefined) {
    return DEFAULT_SUBAGENT_MAX_TURNS;
  }
  return clampSubAgentMaxTurns(settings.subagentMaxTurns);
}

export type TaskMaxTurnsValidation =
  | { ok: true; value: number }
  | { ok: false; message: string };

export function validateTaskMaxTurns(value: number): TaskMaxTurnsValidation {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    return { ok: false, message: "maxTurns must be a positive integer." };
  }
  if (value < 1) {
    return { ok: false, message: "maxTurns must be at least 1." };
  }
  if (value > MAX_SUBAGENT_MAX_TURNS_CAP) {
    return {
      ok: false,
      message: `maxTurns cannot exceed ${MAX_SUBAGENT_MAX_TURNS_CAP}.`,
    };
  }
  return { ok: true, value };
}

export function resolveSubAgentMaxTurns(input: {
  settings?: Settings | null;
  profileMaxTurns?: number;
  /** Must already pass validateTaskMaxTurns when set. */
  taskMaxTurns?: number;
}): number {
  if (input.taskMaxTurns !== undefined) {
    return input.taskMaxTurns;
  }
  if (input.profileMaxTurns !== undefined) {
    return clampSubAgentMaxTurns(input.profileMaxTurns);
  }
  return resolveDefaultSubAgentMaxTurns(input.settings);
}

export type PluginConfig = {
  enabled?: boolean;
  // One-time consent for a tool plugin (kind "tool"). Its tools add in-process
  // capabilities to the agent, so they are only wired in once the user has
  // consented in the /plugins UI. Ignored for other kinds.
  consented?: boolean;
  credentials?: Record<string, string>;
};

// An MCP server is reached one of two ways. A stdio server is launched as a
// subprocess (`command` + `args`). An http server is a remote Streamable-HTTP
// endpoint (`url`) that corbits connects to directly and authorizes via OAuth.
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
  sessionMode?: SessionMode;
};

// The provider fields the runtime consumes, identical to what the env vars used
// to supply directly.
export type ResolvedProvider = {
  apiKey: string;
  baseURL: string;
  model: string;
  providerName: string;
  keyless?: boolean;
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
  return join(home, SETTINGS_DIR_NAME, "settings.json");
}

export function localSettingsPath(cwd: string): string {
  return join(cwd, SETTINGS_DIR_NAME, "settings.json");
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
});

const TierProviderRefSchema = type({
  provider: "string",
  model: "string",
  "reasoningEffort?": type.enumerated(...REASONING_EFFORTS),
});

const TierAssignmentSchema = TierProviderRefSchema;

const TierDefinitionSchema = type({
  "mode?": "'pin' | 'prefer'",
  order: TierProviderRefSchema.array(),
});

const TierConfigSchema = TierDefinitionSchema.or(TierAssignmentSchema);

const TiersSchema = type({
  "fast?": TierConfigSchema,
  "standard?": TierConfigSchema,
  "clever?": TierConfigSchema,
});

const SettingsSchema = type({
  "defaultProvider?": "string",
  providers: type({ "[string]": ProviderSettingsSchema }),
  // mcpServers accepts both array and object forms, so it is validated by
  // normalizeMcpServers rather than expressed structurally here.
  "mcpServers?": "unknown",
  "tiers?": TiersSchema,
  "workflowProfiles?": type({ "[string]": type({ "[string]": "string" }) }),
  "plugins?": type({ "[string]": type({ "enabled?": "boolean", "consented?": "boolean", "credentials?": type({ "[string]": "string" }) }) }),
  "pluginPaths?": "string[]",
  "discoverClaudePlugins?": "boolean",
  "web?": "string",
  "hiddenCommands?": "string[]",
  "onboarded?": "boolean",
  "compactionMode?": "'llm' | 'pruning'",
  "maxConcurrentSubAgents?": "number",
  "subagentMaxTurns?": "number",
  "sessionMode?": "'single' | 'orchestrator'",
  "agentModelFallback?": "'active' | 'none'",
  "shell?": type({ "timeoutMs?": "number", "maxTimeoutMs?": "number" }),
  "tools?": type({
    "timeoutMs?": "number",
    "maxTimeoutMs?": "number",
    "waitForApproval?": "boolean",
  }),
  "telemetry?": type({
    "enabled?": "boolean",
    "installationId?": "string",
    "noticeShown?": "boolean",
  }),
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
  "sessionMode?": "'single' | 'orchestrator'",
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
  if (s.maxConcurrentSubAgents !== undefined) {
    const n = s.maxConcurrentSubAgents;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) return false;
  }
  if (s.subagentMaxTurns !== undefined) {
    const n = s.subagentMaxTurns;
    if (
      typeof n !== "number" ||
      !Number.isInteger(n) ||
      n < 1 ||
      n > MAX_SUBAGENT_MAX_TURNS_CAP
    ) {
      return false;
    }
  }
  if (s.sessionMode !== undefined && !isSessionMode(s.sessionMode)) return false;
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
  if (s.sessionMode !== undefined && !isSessionMode(s.sessionMode)) return false;
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
  // These keys were removed when plugins moved to discovery; they are now
  // silently dropped on the next save. Warn so a user who relied on them knows
  // to re-enable the equivalent plugins in /plugins instead of losing the
  // feature without a trace.
  if (s.workflowPlugins !== undefined || s.agentPlugins !== undefined) {
    process.stderr.write(
      `settings: "workflowPlugins"/"agentPlugins" are no longer supported and will be dropped. Install those plugins under .corbits/plugins/ (or via /plugins "add by path") and enable them in /plugins.\n`,
    );
  }
  return {
    providers: s.providers as Settings["providers"],
    ...(s.defaultProvider !== undefined ? { defaultProvider: s.defaultProvider as string } : {}),
    ...(s.mcpServers !== undefined ? { mcpServers: normalizeMcpServers(s.mcpServers) } : {}),
    ...(s.tiers !== undefined ? { tiers: s.tiers as Settings["tiers"] } : {}),
    ...(s.workflowProfiles !== undefined ? { workflowProfiles: s.workflowProfiles as Settings["workflowProfiles"] } : {}),
    ...(s.plugins !== undefined ? { plugins: s.plugins as Settings["plugins"] } : {}),
    ...(s.pluginPaths !== undefined ? { pluginPaths: s.pluginPaths as string[] } : {}),
    ...(s.discoverClaudePlugins === true ? { discoverClaudePlugins: true } : {}),
    ...(s.web !== undefined ? { web: s.web as string } : {}),
    ...(s.hiddenCommands !== undefined ? { hiddenCommands: s.hiddenCommands as string[] } : {}),
    ...(s.onboarded !== undefined ? { onboarded: Boolean(s.onboarded) } : {}),
    ...(s.compactionMode === "llm" || s.compactionMode === "pruning"
      ? { compactionMode: s.compactionMode }
      : {}),
    ...(s.maxConcurrentSubAgents !== undefined
      ? { maxConcurrentSubAgents: clampMaxConcurrentSubAgents(s.maxConcurrentSubAgents as number) }
      : {}),
    ...(s.subagentMaxTurns !== undefined
      ? { subagentMaxTurns: clampSubAgentMaxTurns(s.subagentMaxTurns as number) }
      : {}),
    ...(s.sessionMode === "single" || s.sessionMode === "orchestrator"
      ? { sessionMode: s.sessionMode }
      : {}),
    ...(s.agentModelFallback === "active" || s.agentModelFallback === "none"
      ? { agentModelFallback: s.agentModelFallback }
      : {}),
    ...(s.shell !== undefined ? { shell: s.shell as Settings["shell"] } : {}),
    ...(s.tools !== undefined ? { tools: s.tools as Settings["tools"] } : {}),
    ...(s.telemetry !== undefined ? { telemetry: s.telemetry as Settings["telemetry"] } : {}),
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
      `Invalid local settings in ${path}: only "provider", "model", "reasoningEffort", "mcpServers", and "sessionMode" are allowed (no credentials).`,
    );
  }
  const s = parsed as Record<string, unknown>;
  return {
    ...(s.provider !== undefined ? { provider: s.provider as string } : {}),
    ...(s.model !== undefined ? { model: s.model as string } : {}),
    ...(s.reasoningEffort !== undefined ? { reasoningEffort: s.reasoningEffort as ReasoningEffort } : {}),
    ...(s.mcpServers !== undefined ? { mcpServers: normalizeMcpServers(s.mcpServers) } : {}),
    ...(s.sessionMode === "single" || s.sessionMode === "orchestrator"
      ? { sessionMode: s.sessionMode }
      : {}),
  } as LocalSettings;
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

export type ResolveInput = {
  // Provider definitions, from the --config file when given, otherwise global.
  settings: Settings | null;
  // Per-repo selection override.
  local: LocalSettings | null;
  // Highest-priority selection from CLI flags.
  cli: { provider?: string; model?: string };
};

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

  const providerName =
    cli.provider ?? local?.provider ?? settings?.defaultProvider ?? soleKey;

  const selected = providerName !== undefined ? providers[providerName] : undefined;

  const baseURL = selected?.baseURL;
  const apiKey = selected?.apiKey;
  const keyless = selected?.keyless === true;
  const model = cli.model ?? local?.model ?? selected?.defaultModel ?? selected?.models[0];

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
    baseURL: normalizeOpenAICompatibleBaseURL(baseURL),
    apiKey: apiKey ?? "",
    model,
    ...(keyless ? { keyless: true } : {}),
  };
}

function isTierDefinitionConfig(raw: TierConfig): raw is TierDefinition {
  return "order" in raw && Array.isArray(raw.order);
}

function tierConfigToDefinition(raw: TierConfig): TierDefinition | null {
  if (isTierDefinitionConfig(raw)) {
    const order = raw.order.filter((r) => r.provider.length > 0 && r.model.length > 0);
    if (order.length === 0) return null;
    return { mode: raw.mode ?? "prefer", order };
  }
  const leg = raw;
  if (leg.provider.length === 0 || leg.model.length === 0) return null;
  return { mode: "pin", order: [{ provider: leg.provider, model: leg.model }] };
}

/** Tier config at the given name only (no fast → standard → clever walk). */
export function tierDefinitionAt(
  tier: ProviderTier,
  settings: Settings,
): TierDefinition | null {
  const raw = settings.tiers?.[tier];
  if (raw === undefined) return null;
  const def = tierConfigToDefinition(raw);
  if (def === null) return null;
  const viable = def.order.filter((r) => settings.providers[r.provider] !== undefined);
  if (viable.length === 0) return null;
  return { mode: def.mode ?? "prefer", order: viable };
}

export function resolveTierDefinition(
  tier: ProviderTier,
  settings: Settings,
): TierDefinition | null {
  const chain: ProviderTier[] = ["fast", "standard", "clever"];
  const start = chain.indexOf(tier);
  if (start === -1) return null;
  for (let i = start; i < chain.length; i++) {
    const t = chain[i] as ProviderTier;
    const raw = settings.tiers?.[t];
    if (raw === undefined) continue;
    const def = tierConfigToDefinition(raw);
    if (def === null) continue;
    const viable = def.order.filter((r) => settings.providers[r.provider] !== undefined);
    if (viable.length === 0) continue;
    const mode: TierSelectionMode = def.mode ?? "prefer";
    return { mode, order: viable };
  }
  return null;
}

// Walk the fallback chain fast → standard → clever and return the first
// provider/model in the resolved tier chain.
export function resolveTier(tier: ProviderTier, settings: Settings): TierAssignment | null {
  const def = resolveTierDefinition(tier, settings);
  const first = def?.order[0];
  if (first === undefined) return null;
  return {
    provider: first.provider,
    model: first.model,
    ...(first.reasoningEffort !== undefined ? { reasoningEffort: first.reasoningEffort } : {}),
  };
}

import type { InferenceSpec } from "../agent/profile-types.js";

// A resolved inference leg, with reasoningEffort threaded through.
export type ResolvedInference = {
  provider: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
};

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
//                       caller falls through to tier / active session).
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
