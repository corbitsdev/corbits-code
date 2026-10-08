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
import type { OtelSettings } from "../perf/otel-config.js";
import type { SessionMode } from "./session-mode.js";
import { resolveDefaultModel } from "./providers.js";
import { ProviderInferenceOptionsSchema } from "./provider-inference-options.js";
import {
  OPENCODE_GO_BASE_URL,
  isOpenCodeGoProvider,
} from "../../packages/opencode-go/src/index.js";

// A configured inference provider. `apiKey` is secret (global settings file
// only); `models` is always an array so single- and multi-model providers are
// handled uniformly; `defaultModel` (or the first entry) is the default.
export interface ProviderSettings {
  name?: string;
  baseURL: string;
  // Optional for keyless local providers (e.g. Ollama); `keyless` skips the
  // non-empty apiKey check entirely.
  apiKey?: string;
  models: string[];
  defaultModel?: string;
  keyless?: boolean;
  // Hides the status-bar dollar cost regardless of model pricing — e.g. a
  // prepaid coding plan or a gateway whose models.dev prices do not apply.
  free?: boolean;
  // Token-window override for compaction and the status-bar meter, applied at
  // load into contextWindowFor; OAuth-projected Codex/xAI entries drop it.
  contextWindow?: number;
  // Per-call output cap, overriding SOURCE_MAX_TOKENS when set.
  maxTokens?: number;
  // Sampling temperature (0..2, OpenAI-compatible); mutually exclusive with
  // topP — never send both on the wire.
  temperature?: number;
  // Sampling top-p (0..1, OpenAI-compatible); mutually exclusive with
  // temperature — never send both on the wire.
  topP?: number;
  // Bifrost virtual key (sk-bf-...): routes through the Bifrost adapter
  // (injects the x-bf-vk header) and enables /v1/models auto-discovery.
  bifrostVirtualKey?: boolean;
  // Anthropic Messages API provider (x-api-key auth).
  anthropic?: boolean;
  // OpenCode Go multi-protocol provider; per-model adapter selection.
  opencodeGo?: boolean;
  // False when persisted without a passing connection test ("save anyway"
  // bypass); absent/true means tested. Defaults to trusted so existing files
  // are not flagged; only untested persists write `false`.
  verified?: boolean;
  // Custom reasoning-effort ladder; when present the runtime uses exactly
  // these levels instead of the family table. Absent means "family table".
  reasoningEfforts?: ReasoningEffort[];
  // Starting level for new sessions; only meaningful alongside
  // `reasoningEfforts`.
  defaultReasoningEffort?: ReasoningEffort;
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
  // Per-phase model overrides for workflows. Keyed by profile name, then
  // workflow step profile key; a step's `profile` field selects the entry.
  workflowProfiles?: Record<string, Record<string, string>>;
  // Per-plugin config keyed by plugin id: enabled flag plus manifest-declared
  // credentials (e.g. an Exa API key). Global-only because it carries secrets;
  // the /plugins UI writes it.
  plugins?: Record<string, PluginConfig>;
  // Extra plugin paths beyond the auto-discovered plugin directories; the
  // /plugins UI writes here so a plugin can register from anywhere on disk.
  pluginPaths?: string[];
  // Per-hook enable/disable state keyed by LifecycleHook.id (its discovered
  // file path). Absent means enabled; the /hooks UI writes it.
  hooks?: Record<string, { enabled: boolean }>;
  // Also discover plugins from ~/.claude/plugins/installed_plugins.json (Claude
  // Code marketplace installs). Default false — opt-in so we never silently
  // import third-party plugins; they still need settings.plugins[id].enabled.
  discoverClaudePlugins?: boolean;
  // Plugin (kind "web") used as the web_search/web_fetch backend. When unset:
  // the single enabled web plugin, else the built-in local provider.
  web?: string;

  // Slash commands hidden from the command palette and completions; they
  // still work if typed in full.
  hiddenCommands?: string[];
  // Set after the first launch's welcome animation + provider modal. Controls
  // whether subsequent launches show "Welcome to" vs "Welcome back".
  onboarded?: boolean;
  // Last package version whose release notes were shown (or stamped on first
  // interactive install). Stamps only after notes are actually shown.
  lastChangelogVersion?: string;
  // Deprecated: compaction is always the evidence-backed LLM handoff now.
  // Legacy values still load but are ignored; new writes omit this field.
  compactionMode?: "llm" | "pruning";
  // Deprecated: orchestrator is the only product path. Legacy values still
  // load but are ignored; kept on the type so old files load.
  sessionMode?: SessionMode;
  // When a pinned agent profile has no viable provider leg: "active" (default)
  // falls back to the user's main session so the agent still runs; "none"
  // fails the profile load.
  agentModelFallback?: "active" | "none";
  // Shell command timeouts. `timeoutMs` overrides the 120s foreground run_shell
  // default when the model omits a per-command timeout; `maxTimeoutMs` clamps
  // that default path only — a per-call timeout is the bound, no ceiling.
  // Background run_shell has no default.
  shell?: { timeoutMs?: number; maxTimeoutMs?: number };
  // Outer wall-clock budget for each tool run(). waitForApproval (default true)
  // freezes the budget while a permission prompt is open so a late approve
  // still runs the tool; false keeps ticking and expiry skips the tool.
  tools?: {
    timeoutMs?: number;
    maxTimeoutMs?: number;
    waitForApproval?: boolean;
  };
  // Wall-clock budget for MCP tool calls (mcp__* names). Armed by default
  // (DEFAULT_MCP_TOOL_TIMEOUT_MS); a wedged MCP server would otherwise hang a
  // tool call forever.
  mcp?: { timeoutMs?: number };
  // Anonymous PostHog telemetry, global only — never written to per-repo local
  // settings. `enabled` defaults to true (opt-out); `installationId` is a
  // UUID generated once on first use; `noticeShown` marks the first-run notice.
  telemetry?: {
    enabled?: boolean;
    installationId?: string;
    noticeShown?: boolean;
  };
  // Opt-in OTEL export (operator-owned collector), separate from PostHog.
  // Prefer OTEL_* env vars for secrets; see docs/PERFTRACE.md. Local PerfTrace
  // stays always-on regardless of this block.
  otel?: OtelSettings;
  // Models-first /model picker recents (newest first). Global preference only
  // — no credentials. Stored list capped (~10); UI shows fewer via
  // listRecentModels.
  recentModels?: ModelRef[];
  // Operator-starred provider+model pairs for the models-first picker.
  favoriteModels?: ModelRef[];
  // Show session cost next to the context percentage in the prompt border's
  // bottom rule. Default false — `/cost` still gives the full breakdown.
  showPromptCost?: boolean;
  // User-global YOLO default; `/yolo` writes it.
  dangerouslySkipPermissions?: boolean;
  // Experimental. When true, an expired Anthropic prompt cache stubs old
  // tool results on the outgoing prompt only. Default off.
  anthropicCachePrompt?: boolean;
  // Terminal palette selection. "auto" (default when unset) follows the
  // terminal/OS detection chain; "light"/"dark" pin the palette.
  theme?: "auto" | "light" | "dark";
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
  const rest = (settings.recentModels ?? []).filter(
    (r) => modelRefKey(r) !== modelRefKey(next),
  );
  return {
    ...settings,
    recentModels: [next, ...rest].slice(0, Math.max(0, max)),
  };
}

// Add the pair if absent; remove it if present.
export function toggleFavoriteModel(
  settings: Settings,
  ref: ModelRef,
): Settings {
  const next: ModelRef = { provider: ref.provider, model: ref.model };
  const key = modelRefKey(next);
  const current = settings.favoriteModels ?? [];
  const has = current.some((r) => modelRefKey(r) === key);
  return {
    ...settings,
    favoriteModels: has
      ? current.filter((r) => modelRefKey(r) !== key)
      : [...current, next],
  };
}

function providerSelectionMetadata(
  provider: ProviderSettings,
  model: string,
): ProviderSettings {
  return {
    ...(provider.name !== undefined ? { name: provider.name } : {}),
    baseURL: provider.baseURL,
    models: [model],
    defaultModel: model,
    ...(provider.keyless === true ? { keyless: true } : {}),
    ...(provider.free === true ? { free: true } : {}),
    ...(provider.contextWindow !== undefined
      ? { contextWindow: provider.contextWindow }
      : {}),
    ...(provider.maxTokens !== undefined
      ? { maxTokens: provider.maxTokens }
      : {}),
    ...(provider.temperature !== undefined
      ? { temperature: provider.temperature }
      : {}),
    ...(provider.topP !== undefined ? { topP: provider.topP } : {}),
    ...(provider.bifrostVirtualKey === true ? { bifrostVirtualKey: true } : {}),
    ...(provider.anthropic === true ? { anthropic: true } : {}),
    ...(provider.opencodeGo === true ? { opencodeGo: true } : {}),
    ...(provider.verified !== undefined ? { verified: provider.verified } : {}),
    ...(provider.reasoningEfforts !== undefined
      ? { reasoningEfforts: provider.reasoningEfforts }
      : {}),
    ...(provider.defaultReasoningEffort !== undefined
      ? { defaultReasoningEffort: provider.defaultReasoningEffort }
      : {}),
  };
}

export function setDefaultModel(
  settings: Settings,
  ref: ModelRef,
  projectedProvider?: ProviderSettings,
): Settings {
  const next: ModelRef = { provider: ref.provider, model: ref.model };
  const existing = settings.providers[next.provider];
  const provider = existing ?? projectedProvider;
  if (provider === undefined) {
    return { ...settings, defaultProvider: next.provider };
  }
  const persistedProvider =
    existing !== undefined
      ? { ...existing, defaultModel: next.model }
      : providerSelectionMetadata(provider, next.model);
  return {
    ...settings,
    defaultProvider: next.provider,
    providers: {
      ...settings.providers,
      [next.provider]: persistedProvider,
    },
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

// Removal report for removeProviderFromSettings, so the caller can build a
// truthful notice without re-deriving what changed.
export interface ProviderRemovalRepair {
  /** True when defaultProvider pointed at the removed provider. */
  removedDefault: boolean;
  /** Repointed default; absent when the default was unset instead. */
  newDefaultProvider?: string;
  droppedRecents: number;
  droppedFavorites: number;
}

// Delete one provider catalog entry plus every reference to it (recents,
// favorites, default). Unknown names are a no-op returning the input
// unchanged. Default repair is deterministic: the live session's provider if
// still configured, else the newest surviving recent whose provider still
// exists, else the sole remaining provider, else unset (valid — optional).
// Pure: no disk I/O, no auth-store knowledge.
export function removeProviderFromSettings(
  settings: Settings,
  providerName: string,
  liveProvider?: string,
): {
  settings: Settings;
  removed: boolean;
  repair: ProviderRemovalRepair;
} {
  const emptyRepair: ProviderRemovalRepair = {
    removedDefault: false,
    droppedRecents: 0,
    droppedFavorites: 0,
  };
  if (settings.providers[providerName] === undefined) {
    return { settings, removed: false, repair: emptyRepair };
  }
  const remaining = Object.fromEntries(
    Object.entries(settings.providers).filter(
      ([name]) => name !== providerName,
    ),
  );
  const recents = settings.recentModels ?? [];
  const keptRecents = recents.filter((r) => r.provider !== providerName);
  const favorites = settings.favoriteModels ?? [];
  const keptFavorites = favorites.filter((r) => r.provider !== providerName);
  let next: Settings = {
    ...settings,
    providers: remaining,
    ...(settings.recentModels !== undefined
      ? { recentModels: keptRecents }
      : {}),
    ...(settings.favoriteModels !== undefined
      ? { favoriteModels: keptFavorites }
      : {}),
  };
  const repair: ProviderRemovalRepair = {
    removedDefault: settings.defaultProvider === providerName,
    droppedRecents: recents.length - keptRecents.length,
    droppedFavorites: favorites.length - keptFavorites.length,
  };
  if (settings.defaultProvider === providerName) {
    const remainingNames = Object.keys(remaining);
    const newestSurvivor = keptRecents.find(
      (r) => remaining[r.provider] !== undefined,
    )?.provider;
    const nextDefault =
      liveProvider !== undefined && remaining[liveProvider] !== undefined
        ? liveProvider
        : (newestSurvivor ??
          (remainingNames.length === 1 ? remainingNames[0] : undefined));
    if (nextDefault === undefined) {
      const { defaultProvider: _dropped, ...withoutDefault } = next;
      void _dropped;
      next = withoutDefault;
    } else {
      next = { ...next, defaultProvider: nextDefault };
      repair.newDefaultProvider = nextDefault;
    }
  }
  return { settings: next, removed: true, repair };
}

// Maps the settings shell block to the shape the shell-guard plugin expects.
// Returns undefined when unset so the plugin applies the 120s foreground
// default itself. timeoutMs overrides that default; maxTimeoutMs clamps the
// default path only.
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
export function toolWatchdogFromSettings(settings?: Settings | null):
  | {
      defaultMs?: number;
      maxMs?: number;
      waitForApproval?: boolean;
      mcpTimeoutMs?: number;
      shellDefaultMs?: number;
      shellMaxMs?: number;
    }
  | undefined {
  const tools = settings?.tools;
  const mcpTimeoutMs = settings?.mcp?.timeoutMs;
  const shellDefaultMs = settings?.shell?.timeoutMs;
  const shellMaxMs = settings?.shell?.maxTimeoutMs;
  const hasTimeout =
    tools?.timeoutMs !== undefined || tools?.maxTimeoutMs !== undefined;
  const hasWait = tools?.waitForApproval !== undefined;
  const hasShell = shellDefaultMs !== undefined || shellMaxMs !== undefined;
  if (!hasTimeout && !hasWait && mcpTimeoutMs === undefined && !hasShell) {
    return undefined;
  }
  return {
    ...(tools?.timeoutMs !== undefined ? { defaultMs: tools.timeoutMs } : {}),
    ...(tools?.maxTimeoutMs !== undefined ? { maxMs: tools.maxTimeoutMs } : {}),
    ...(tools?.waitForApproval !== undefined
      ? { waitForApproval: tools.waitForApproval }
      : {}),
    ...(mcpTimeoutMs !== undefined ? { mcpTimeoutMs } : {}),
    ...(shellDefaultMs !== undefined ? { shellDefaultMs } : {}),
    ...(shellMaxMs !== undefined ? { shellMaxMs } : {}),
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
  // One-time consent for a tool plugin (kind "tool"): its tools add
  // in-process capabilities, so they wire in only once the user has consented
  // in the /plugins UI. Ignored for other kinds.
  consented?: boolean;
  credentials?: Record<string, string>;
}

// An MCP server is reached one of two ways: a stdio server is launched as a
// subprocess (`command` + `args`); an http server is a remote Streamable-HTTP
// endpoint (`url`) corbits connects to directly and authorizes via OAuth.
// `type` defaults to "stdio" when `command` is set and "http" when only
// `url` is.
export interface MCPServerConfig {
  name: string;
  type?: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export interface MCPServerSettingsTransport extends MCPServerConfig {
  enabled?: boolean;
}

export interface ExaMCPPresetConfig {
  name: typeof EXA_MCP_SERVER_NAME;
  enabled: boolean;
}

export type MCPServerSettingsEntry =
  | MCPServerSettingsTransport
  | ExaMCPPresetConfig;

export function hasMcpTransport(entry: {
  name?: unknown;
  type?: unknown;
  command?: unknown;
  url?: unknown;
  args?: unknown;
  env?: unknown;
}): boolean {
  return (
    entry.type !== undefined ||
    entry.command !== undefined ||
    entry.url !== undefined ||
    entry.args !== undefined ||
    entry.env !== undefined
  );
}

export function isExaMCPPreset(
  entry: MCPServerSettingsEntry,
): entry is ExaMCPPresetConfig {
  return entry.name === EXA_MCP_SERVER_NAME && !hasMcpTransport(entry);
}

// Per-repo override. Selection only for provider/model, but may also declare
// MCP servers to connect at session start.
export interface LocalSettings {
  provider?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  mcpServers?: MCPServerSettingsEntry[];
  sessionMode?: SessionMode;
  // Per-project env vars applied to the run_shell tool's spawn environment,
  // on top of the process's inherited environment. Configuration instead of a
  // shell command that mutates the environment mid-session.
  env?: Record<string, string>;
  // Tool names always advertised on the wire for this project — e.g. hot MCP
  // integrations that should never need a tool_search activation round-trip.
  // Names that resolve to no registered tool are inert.
  pinnedTools?: string[];
}

// The provider fields the runtime consumes, identical to what the env vars
// used to supply directly.
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
    throw new Error(
      `Invalid OpenAI-compatible baseURL "${raw}": expected an absolute URL.`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Invalid OpenAI-compatible baseURL "${raw}": expected http or https.`,
    );
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
      // Anything but a missing segment (ENOTDIR, EACCES, ...) is not aliasable;
      // fall back to the lexical path so the fail-open loader sees it.
      if (!isENOENT(err)) return resolve(path);
      const parent = dirname(candidate);
      if (parent === candidate) return resolve(path);
      missingSegments.push(basename(candidate));
      candidate = parent;
    }
  }
}

export function resolveLocalSettingsPath(
  cwd: string,
  globalPath: string,
): string | null {
  const localPath = localSettingsPath(cwd);
  return physicalPathIdentity(localPath) === physicalPathIdentity(globalPath)
    ? null
    : localPath;
}

// True when `settingsPath` is a distinct settings file from the default home
// path. Symlink and lexical aliases of the default path are not overrides —
// treating them as such would suppress OAuth profile projection after setup.
export function isProgrammaticSettingsOverride(
  settingsPath: string,
  defaultGlobalPath: string = globalSettingsPath(),
): boolean {
  return (
    physicalPathIdentity(settingsPath) !==
    physicalPathIdentity(defaultGlobalPath)
  );
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
// AGENTS.md). The schemas own structural validation; the imperative helpers
// that remain (transport selection, dual array/object MCP format) are
// normalization and cross-field business rules, not type checks.
const ProviderSettingsSchema = type({
  "name?": "string",
  baseURL: "string",
  "apiKey?": "string",
  models: "string[]",
  "defaultModel?": "string",
  "keyless?": "boolean",
  "free?": "boolean",
  "bifrostVirtualKey?": "boolean",
  "anthropic?": "boolean",
  "opencodeGo?": "boolean",
  "verified?": "boolean",
  "reasoningEfforts?": type
    .enumerated(...REASONING_EFFORTS)
    .array()
    .narrow(
      (levels, ctx) =>
        levels.length > 0 || ctx.reject("at least one reasoning effort"),
    ),
  "defaultReasoningEffort?": type.enumerated(...REASONING_EFFORTS),
})
  .and(ProviderInferenceOptionsSchema)
  .narrow(
    (provider, ctx) =>
      provider.defaultReasoningEffort === undefined ||
      provider.reasoningEfforts?.includes(provider.defaultReasoningEffort) ===
        true ||
      ctx.reject("a default reasoning effort from the enabled levels"),
  );

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
  // Model tiers were removed; older files may still carry this key. Accepted
  // and ignored so the file loads, then dropped on next save.
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
  // Legacy disk values still load; product resolve ignores them.
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
  "anthropicCachePrompt?": "boolean",
  "theme?": "'auto' | 'light' | 'dark'",
});

// Per-entry MCP shape without the name key. "Exactly one transport" is a
// cross-field constraint enforced after the structural check.
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
  // Legacy disk values still load; product resolve ignores them.
  "sessionMode?": "'single' | 'orchestrator'",

  "env?": "Record<string, string>",
  "pinnedTools?": "string[]",
  // Reject any other key so local settings can never smuggle credentials.
  "+": "reject",
});

export function isSettings(value: unknown): value is Settings {
  if (!SettingsSchema.allows(value)) return false;
  const s = value as Record<string, unknown>;
  if (
    s.mcpServers !== undefined &&
    normalizeMcpServers(s.mcpServers) === undefined
  )
    return false;
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
  if (!hasMcpTransport(s)) {
    return name === EXA_MCP_SERVER_NAME && typeof s.enabled === "boolean";
  }
  // Exactly one transport must be specified.
  const isHttp =
    s.type === "http" || (s.type === undefined && typeof s.url === "string");
  return isHttp ? typeof s.url === "string" : typeof s.command === "string";
}

function isMCPServerConfigWithKey(
  value: unknown,
): value is MCPServerSettingsEntry {
  if (typeof value !== "object" || value === null) return false;
  const name = (value as Record<string, unknown>).name;
  if (typeof name !== "string") return false;
  return isMCPServerConfigEntry(name, value);
}

function normalizeMcpEntry(
  name: string,
  entry: Record<string, unknown>,
): MCPServerSettingsEntry {
  if (!hasMcpTransport(entry) && entry.enabled !== undefined) {
    return { name: EXA_MCP_SERVER_NAME, enabled: entry.enabled as boolean };
  }
  return {
    name,
    ...(entry.type !== undefined
      ? { type: entry.type as "stdio" | "http" }
      : {}),
    ...(entry.command !== undefined
      ? { command: entry.command as string }
      : {}),
    ...(entry.url !== undefined ? { url: entry.url as string } : {}),
    ...(entry.args !== undefined ? { args: entry.args as string[] } : {}),
    ...(entry.env !== undefined
      ? { env: entry.env as Record<string, string> }
      : {}),
    ...(entry.enabled !== undefined
      ? { enabled: entry.enabled as boolean }
      : {}),
  };
}

// Accepts both array [{ name, ... }] and object { name: {...} } formats;
// returns the normalized array.
export function normalizeMcpServers(
  value: unknown,
): MCPServerSettingsEntry[] | undefined {
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
// allowed); mcpServers is permitted because MCP server configs are expected
// to live in the repo.
export function isLocalSettings(value: unknown): value is LocalSettings {
  if (!LocalSettingsSchema.allows(value)) return false;
  const s = value as Record<string, unknown>;
  if (
    s.mcpServers !== undefined &&
    normalizeMcpServers(s.mcpServers) === undefined
  )
    return false;
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

// Drop undefined keys so JSON omit + optional Settings fields stay aligned.
// Transforms run before this; the helper only filters undefined, it does not
// validate.
type DefinedFields<T> = {
  [
    K in keyof T as undefined extends T[K]
      ? T[K] extends undefined
        ? never
        : K
      : K
  ]: Exclude<T[K], undefined>;
};

function pickDefined<T extends Record<string, unknown>>(
  fields: T,
): DefinedFields<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) out[key] = value;
  }
  return out as DefinedFields<T>;
}

// Every optional Settings key must appear here so a new field without a
// load-path assignment fails at compile time instead of silently dropping.
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
  "anthropicCachePrompt",
  "theme",
] as const satisfies readonly (keyof OptionalSettingsFields)[];

/** Optional local settings keys the load path is required to consider. */
export const LOCAL_SETTINGS_OPTIONAL_KEYS = [
  "provider",
  "model",
  "reasoningEffort",
  "mcpServers",
  "sessionMode",
  "env",
  "pinnedTools",
] as const satisfies readonly (keyof OptionalLocalSettingsFields)[];

/**
 * Hard-cutover heal: any provider that is Go by flag, known id/label, or
 * `/zen/go` baseURL gets `opencodeGo: true` and the canonical Go baseURL.
 * Mutates only when at least one entry changes; returns the mutated names.
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

const ClobberedLocalSelectionSchema = type({
  provider: "string>0",
  model: "string>0",
  "+": "reject",
});

function isClobberedLocalSelection(
  value: unknown,
): value is { provider: string; model: string } {
  return ClobberedLocalSelectionSchema.allows(value);
}

function recoverClobberedOAuthSelection(
  selection: { provider: string; model: string },
  projected: Record<string, ProviderSettings>,
): Settings | undefined {
  const provider = projected[selection.provider];
  // Auth-profile presence is enough: the selected model may be outside the
  // projected fallback catalog (CODEX_DEFAULT_MODELS / xAI equivalents).
  if (provider === undefined) return undefined;
  return {
    defaultProvider: selection.provider,
    providers: {
      [selection.provider]: providerSelectionMetadata(
        provider,
        selection.model,
      ),
    },
  };
}

async function loadSettingsJSON(path: string): Promise<unknown | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (isENOENT(err)) return null;
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in settings file: ${path}`);
  }
}

function settingsSchemaError(path: string): Error {
  return new Error(
    `Invalid settings schema in ${path}: expected { providers: { <name>: { baseURL, apiKey, models: [...] } } }`,
  );
}

// Provider blocks from some external tools carry fields Corbits does not
// honor: compat.supportsReasoningEffort, supportsThinkingTokenBudget,
// thinkingLevelMap, samplingParams. ProviderSettingsSchema does not reject
// unknown keys, so they pass validation and are silently dropped. Warn when
// any are present so the ignore is never silent.
const IGNORED_PROVIDER_FIELDS: {
  display: string;
  path: (p: Record<string, unknown>) => unknown;
}[] = [
  {
    display: "supportsThinkingTokenBudget",
    path: (p) => p.supportsThinkingTokenBudget,
  },
  {
    display: "thinkingLevelMap",
    path: (p) => p.thinkingLevelMap,
  },
  {
    display: "samplingParams",
    path: (p) => p.samplingParams,
  },
  {
    // Rendered as the nested arrow form so it is not mistaken for a bare
    // provider-level key (the JSON nests it under the provider's "compat").
    display: "compat → supportsReasoningEffort",
    path: (p) => {
      const compat = p.compat as Record<string, unknown> | undefined;
      return compat?.supportsReasoningEffort;
    },
  },
];

function warnOnIgnoredProviderFields(
  path: string,
  providers: Record<string, ProviderSettings>,
): void {
  for (const [name, provider] of Object.entries(providers)) {
    const p = provider as unknown as Record<string, unknown>;
    const present = IGNORED_PROVIDER_FIELDS.filter(
      (field) => field.path(p) !== undefined,
    ).map((field) => field.display);
    if (present.length > 0) {
      process.stderr.write(
        `settings: ${path}: provider "${name}" sets fields that are not honored by Corbits and will be ignored: ${present.join(", ")}. These fields are not yet supported; configure effort/thinking via provider/model-level settings.\n`,
      );
    }
  }
}

function normalizeParsedSettings(path: string, parsed: unknown): Settings {
  if (!isSettings(parsed)) {
    throw settingsSchemaError(path);
  }
  const s = parsed as unknown as Record<string, unknown>;
  warnOnIgnoredProviderFields(path, parsed.providers);
  // These keys were removed when plugins moved to discovery; they are now
  // dropped on the next save. Warn so a user who relied on them re-enables
  // the equivalent plugins in /plugins instead of losing the feature silently.
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
    mcpServers:
      s.mcpServers !== undefined
        ? normalizeMcpServers(s.mcpServers)
        : undefined,
    workflowProfiles: s.workflowProfiles as
      | Settings["workflowProfiles"]
      | undefined,
    plugins: s.plugins as Settings["plugins"] | undefined,
    pluginPaths: s.pluginPaths as string[] | undefined,
    hooks: s.hooks as Settings["hooks"] | undefined,
    discoverClaudePlugins: s.discoverClaudePlugins === true ? true : undefined,
    web: s.web as string | undefined,
    hiddenCommands: s.hiddenCommands as string[] | undefined,
    onboarded: s.onboarded !== undefined ? Boolean(s.onboarded) : undefined,
    lastChangelogVersion:
      typeof s.lastChangelogVersion === "string" &&
      s.lastChangelogVersion.trim().length > 0
        ? s.lastChangelogVersion.trim()
        : undefined,
    compactionMode:
      s.compactionMode === "llm" || s.compactionMode === "pruning"
        ? s.compactionMode
        : undefined,
    // Drop legacy "single"; keep only explicit orchestrator if present.
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
    showPromptCost:
      s.showPromptCost !== undefined ? Boolean(s.showPromptCost) : undefined,
    dangerouslySkipPermissions:
      s.dangerouslySkipPermissions !== undefined
        ? Boolean(s.dangerouslySkipPermissions)
        : undefined,
    anthropicCachePrompt:
      s.anthropicCachePrompt !== undefined
        ? Boolean(s.anthropicCachePrompt)
        : undefined,
    theme:
      s.theme === "light" || s.theme === "dark" || s.theme === "auto"
        ? s.theme
        : undefined,
  };
  return {
    providers: s.providers as Settings["providers"],
    ...pickDefined(optional),
  };
}

async function loadStrictSettings(
  path: string,
  parsed: unknown,
): Promise<Settings> {
  const settings = normalizeParsedSettings(path, parsed);
  // Pin the Go flag + canonical baseURL on disk when any Go signal matches.
  // Fail open on save: keep the in-memory heal so a read-only settings path
  // cannot brick startup.
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

export async function loadSettings(path: string): Promise<Settings | null> {
  const parsed = await loadSettingsJSON(path);
  return parsed === null ? null : await loadStrictSettings(path, parsed);
}

export async function loadSettingsRecoveringClobberedOAuthSelection(
  path: string,
  recoverableOAuthProviders: Record<string, ProviderSettings>,
  options: { persist: boolean },
): Promise<Settings | null> {
  const parsed = await loadSettingsJSON(path);
  if (parsed === null) return null;
  if (isClobberedLocalSelection(parsed)) {
    const recovered = recoverClobberedOAuthSelection(
      parsed,
      recoverableOAuthProviders,
    );
    if (recovered === undefined) throw settingsSchemaError(path);
    if (options.persist) await saveGlobalSettings(path, recovered);
    return recovered;
  }
  return loadStrictSettings(path, parsed);
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
      mcpServers:
        s.mcpServers !== undefined
          ? normalizeMcpServers(s.mcpServers)
          : undefined,
      sessionMode:
        s.sessionMode === "orchestrator" ? "orchestrator" : undefined,
      env: s.env as Record<string, string> | undefined,
      pinnedTools: s.pinnedTools as string[] | undefined,
    };
  }
  return {
    provider: typeof s.provider === "string" ? s.provider : undefined,
    model: typeof s.model === "string" ? s.model : undefined,
    reasoningEffort: isReasoningEffort(s.reasoningEffort)
      ? s.reasoningEffort
      : undefined,
    mcpServers:
      s.mcpServers !== undefined
        ? normalizeMcpServers(s.mcpServers)
        : undefined,
    sessionMode: s.sessionMode === "orchestrator" ? "orchestrator" : undefined,
    env:
      s.env !== undefined &&
      typeof s.env === "object" &&
      s.env !== null &&
      !Array.isArray(s.env)
        ? Object.fromEntries(
            Object.entries(s.env as Record<string, unknown>).filter(
              (e): e is [string, string] => typeof e[1] === "string",
            ),
          )
        : undefined,
    pinnedTools: Array.isArray(s.pinnedTools)
      ? s.pinnedTools.filter((name): name is string => typeof name === "string")
      : undefined,
  };
}

function coerceLocalSettings(
  path: string,
  parsed: unknown,
): LocalSettingsLoadResult {
  const diagnostics: SettingsLoadDiagnostic[] = [];
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      settings: null,
      diagnostics: [
        {
          path,
          message: `Local settings in ${path} is not a JSON object.`,
          fix: `Edit ${path} to a JSON object with only: provider, model, reasoningEffort, mcpServers, sessionMode, env, pinnedTools.`,
        },
      ],
    };
  }
  const s = parsed as Record<string, unknown>;
  // Valid strict path still returns cleanly with no diagnostics.
  if (isLocalSettings(parsed)) {
    return {
      settings: pickDefined(pickLocalFields(s, "strict")),
      diagnostics: [],
    };
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
  if (
    s.reasoningEffort !== undefined &&
    optional.reasoningEffort === undefined
  ) {
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
      fix: `Edit ${path}: only "provider", "model", "reasoningEffort", "mcpServers", "sessionMode", "env", and "pinnedTools" are allowed (no credentials).`,
    });
  }
  const settings = pickDefined(optional);
  return {
    settings: Object.keys(settings).length > 0 ? settings : null,
    diagnostics,
  };
}

export async function loadLocalSettingsResult(
  path: string,
): Promise<LocalSettingsLoadResult> {
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

export async function loadLocalSettings(
  path: string,
): Promise<LocalSettings | null> {
  // Fail open: never throw for schema/unknown-key problems; callers needing
  // diagnostics use loadLocalSettingsResult.
  const { settings } = await loadLocalSettingsResult(path);
  return settings;
}

// Read-modify-write base for the local selection file. Absent file → empty
// base (create OK); partial fail-open → cleaned fields; unreadable/unusable
// → null so the caller skips the write instead of wiping the file.
export async function loadLocalSettingsWriteBase(
  path: string,
): Promise<LocalSettings | null> {
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

// Read-modify-write base for the global settings file. Absent file → fresh
// minimal base; unreadable/invalid → null so the caller skips the write (a
// minimal base would overwrite the whole file to flip one key).
export async function loadGlobalSettingsWriteBase(
  path: string,
): Promise<Settings | null> {
  try {
    return (await loadSettings(path)) ?? { providers: {} };
  } catch {
    return null;
  }
}

// Upsert one provider without dropping plugins, pluginPaths, sessionMode,
// shell, tools, or any other non-provider field. Used by first-run onboarding
// and similar single-provider writes.
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

// Persist the global settings file. Validates before writing so the file
// always round-trips through loadSettings; writes via temp-file + rename so a
// concurrent reader never sees a torn file.
export async function saveGlobalSettings(
  path: string,
  settings: Settings,
): Promise<void> {
  if (!isSettings(settings)) {
    throw new Error(`Refusing to write invalid global settings.`);
  }
  const payload = JSON.stringify(settings, null, 2);
  const tmp = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmp, payload);
  await rename(tmp, path);
}

// Silent helper: callers log or notice. Skips when the write base is null so
// a corrupt settings file is never replaced with a one-key rewrite.
export async function persistSkipPermissionsDefault(
  path: string,
  value: boolean,
): Promise<"ok" | "skipped"> {
  const base = await loadGlobalSettingsWriteBase(path);
  if (base === null) return "skipped";
  await saveGlobalSettings(path, {
    ...base,
    dangerouslySkipPermissions: value,
  });
  return "ok";
}

// Stamp the global `onboarded` flag. Reads on-disk settings fresh (never an
// in-memory Settings that may carry injected OAuth entries with short-lived
// access tokens) and re-saves with onboarded set. Absent file → minimal valid
// Settings; no provider or credential is ever invented here.
export async function markOnboarded(path: string): Promise<void> {
  const onDisk = await loadSettings(path);
  const base: Settings = onDisk ?? { providers: {} };
  await saveGlobalSettings(path, { ...base, onboarded: true });
}

/** Persist the package version whose release notes were last shown (or
 * stamped on first install). */
export async function markLastChangelogVersion(
  path: string,
  version: string,
): Promise<void> {
  const trimmed = version.trim();
  if (trimmed.length === 0) return;
  const onDisk = await loadSettings(path);
  const base: Settings = onDisk ?? { providers: {} };
  if (base.lastChangelogVersion === trimmed) return;
  await saveGlobalSettings(path, { ...base, lastChangelogVersion: trimmed });
}

// Ensure a persisted telemetry installationId exists, generating one on first
// use. Reads on-disk settings fresh (same rationale as markOnboarded: never
// trust an in-memory Settings that may carry injected credentials).
export async function ensureTelemetrySettings(path: string): Promise<Settings> {
  const onDisk = await loadSettings(path);
  const base: Settings = onDisk ?? { providers: {} };
  // Read-then-write, not read-then-lock: concurrent first launches could each
  // generate a different installationId and the second save wins. Accepted —
  // it matters only once at first run; no cross-process locking.
  if (base.telemetry?.installationId !== undefined) return base;
  const next: Settings = {
    ...base,
    telemetry: { ...base.telemetry, installationId: randomUUID() },
  };
  await saveGlobalSettings(path, next);
  return next;
}

// Stamp the telemetry first-run notice as shown, leaving other fields alone.
export async function markTelemetryNoticeShown(path: string): Promise<void> {
  const onDisk = await loadSettings(path);
  const base: Settings = onDisk ?? { providers: {} };
  if (base.telemetry?.noticeShown === true) return;
  await saveGlobalSettings(path, {
    ...base,
    telemetry: { ...base.telemetry, noticeShown: true },
  });
}

// Persist the per-repo provider/model selection (the /agent modal's "default
// for this project"). Selection only, never credentials, so the file is safe
// to leave gitignored. Validated before writing; temp-file + rename.
export async function saveLocalSettings(
  path: string,
  local: LocalSettings,
): Promise<void> {
  if (!isLocalSettings(local)) {
    throw new Error(
      `Refusing to write invalid local settings: only "provider", "model", "reasoningEffort", "mcpServers", "sessionMode", "env", and "pinnedTools" are allowed.`,
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
//   providerName: --provider > local > defaultProvider > sole provider
//   unusable pick (no --provider): walk local, defaultProvider, recentModels
//     (newest-first, unique), then remaining catalog keys
//   model: --model > local > recent pair (recent fallback only) > defaultModel > models[0]
//   baseURL/apiKey: from the selected provider only
// Definitions come exclusively from the settings catalog; env vars have no
// influence. Pure: does not write settings or mutate input.settings.
export function resolveProvider(input: ResolveInput): ResolvedProvider {
  const { settings, local, cli } = input;
  const providers = settings?.providers ?? {};
  const providerKeys = Object.keys(providers);
  const soleKey = providerKeys.length === 1 ? providerKeys[0] : undefined;

  if (
    cli.provider !== undefined &&
    settings !== null &&
    providers[cli.provider] === undefined
  ) {
    const available =
      providerKeys.length > 0 ? providerKeys.join(", ") : "none";
    throw new Error(
      `Provider "${cli.provider}" not found in settings (available: ${available}).`,
    );
  }

  const originalName =
    cli.provider ?? local?.provider ?? settings?.defaultProvider ?? soleKey;

  const fieldsFor = (name: string | undefined) => {
    const selected = name !== undefined ? providers[name] : undefined;
    const go = isOpenCodeGoProvider({
      ...(name !== undefined ? { name } : {}),
      ...(selected?.opencodeGo === true ? { opencodeGo: true as const } : {}),
      ...(selected?.baseURL !== undefined ? { baseURL: selected.baseURL } : {}),
    });
    return {
      selected,
      go,
      baseURL: go ? OPENCODE_GO_BASE_URL : selected?.baseURL,
      apiKey: selected?.apiKey,
      keyless: selected?.keyless === true,
    };
  };

  const finish = (
    name: string,
    selected: ProviderSettings,
    go: boolean,
    baseURL: string,
    apiKey: string | undefined,
    keyless: boolean,
    model: string,
  ): ResolvedProvider => ({
    providerName: name,
    baseURL: go
      ? OPENCODE_GO_BASE_URL
      : normalizeOpenAICompatibleBaseURL(baseURL),
    apiKey: apiKey ?? "",
    model,
    ...(keyless ? { keyless: true } : {}),
    ...(selected.verified === false ? { verified: false } : {}),
  });

  const tryCandidate = (
    name: string | undefined,
    model: string | undefined,
  ): ResolvedProvider | undefined => {
    if (name === undefined || name.length === 0) return undefined;
    const { selected, go, baseURL, apiKey, keyless } = fieldsFor(name);
    if (selected === undefined) return undefined;
    const missingApiKey =
      !keyless && (apiKey === undefined || apiKey.length === 0);
    if (
      baseURL === undefined ||
      baseURL.length === 0 ||
      missingApiKey ||
      model === undefined ||
      model.length === 0
    ) {
      return undefined;
    }
    return finish(name, selected, go, baseURL, apiKey, keyless, model);
  };

  const nonempty = (value: string | undefined): string | undefined =>
    value !== undefined && value.length > 0 ? value : undefined;

  const throwOriginal = (): never => {
    const { selected, baseURL, apiKey, keyless } = fieldsFor(originalName);
    const model =
      nonempty(cli.model) ??
      nonempty(local?.model) ??
      resolveDefaultModel(selected);
    const selectedMissing =
      originalName !== undefined &&
      settings !== null &&
      providers[originalName] === undefined;
    const missingApiKey =
      !keyless && (apiKey === undefined || apiKey.length === 0);
    const missing: string[] = [];
    if (originalName === undefined || originalName.length === 0)
      missing.push("provider");
    if (baseURL === undefined || baseURL.length === 0) missing.push("baseURL");
    if (missingApiKey) missing.push("apiKey");
    if (model === undefined || model.length === 0) missing.push("model");
    const detail = selectedMissing
      ? ` Selected provider "${originalName}" is not configured in settings (available: ${
          Object.keys(providers).join(", ") || "none"
        }).`
      : "";
    throw new Error(
      `Could not resolve an inference provider (missing: ${missing.join(", ")}).${detail} ` +
        `Configure a provider in ${globalSettingsPath()}. ` +
        `See docs/IMPLEMENTATION.md.`,
    );
  };

  const original = tryCandidate(
    originalName,
    nonempty(cli.model) ??
      nonempty(local?.model) ??
      resolveDefaultModel(fieldsFor(originalName).selected),
  );
  if (original !== undefined) return original;
  if (cli.provider !== undefined) return throwOriginal();
  if (originalName === undefined || originalName.length === 0)
    return throwOriginal();

  const tried = new Set<string>();
  if (originalName !== undefined) tried.add(originalName);

  const fallbacks: { name: string; model: string | undefined }[] = [];
  const enqueue = (name: string | undefined, model: string | undefined) => {
    if (name === undefined || tried.has(name)) return;
    tried.add(name);
    fallbacks.push({ name, model });
  };

  enqueue(
    local?.provider,
    nonempty(cli.model) ??
      resolveDefaultModel(
        local?.provider !== undefined ? providers[local.provider] : undefined,
      ),
  );
  enqueue(
    settings?.defaultProvider,
    nonempty(cli.model) ??
      resolveDefaultModel(
        settings?.defaultProvider !== undefined
          ? providers[settings.defaultProvider]
          : undefined,
      ),
  );
  for (const ref of settings?.recentModels ?? []) {
    if (tried.has(ref.provider)) continue;
    tried.add(ref.provider);
    const recentModel = ref.model.length > 0 ? ref.model : undefined;
    fallbacks.push({
      name: ref.provider,
      model:
        nonempty(cli.model) ??
        recentModel ??
        resolveDefaultModel(providers[ref.provider]),
    });
  }
  for (const name of providerKeys) {
    enqueue(name, nonempty(cli.model) ?? resolveDefaultModel(providers[name]));
  }

  for (const candidate of fallbacks) {
    const resolved = tryCandidate(candidate.name, candidate.model);
    if (resolved !== undefined) return resolved;
  }

  return throwOriginal();
}

import type { InferenceSpec } from "../agent/profile-types.js";

// A resolved inference leg, with reasoningEffort threaded through.
export interface ResolvedInference {
  provider: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
}

// True when the configured providers actually expose this provider+model.
function isLegViable(
  leg: { provider: string; model: string },
  settings: Settings,
): boolean {
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
//   - "resolved"    — a viable leg was found, returned in `value`.
//   - "fallback"    — no viable leg, but the agent permits fallback (the
//                     caller falls through to the active session's model).
//   - "unavailable" — no viable leg and the spec forbids fallback
//                     (`mode: "pin"` or `agentModelFallback: "none"`); the
//                     caller must surface this as an error rather than
//                     silently run on the wrong provider.
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
        ...(leg.reasoningEffort !== undefined
          ? { reasoningEffort: leg.reasoningEffort }
          : {}),
      };
    }
  }
  return null;
}

// Resolve with policy: the sub-agent dispatcher decides between fallback and
// hard failure from the spec's mode and the user's setting.
export function resolveInferenceWithPolicy(
  spec: InferenceSpec | undefined,
  settings: Settings,
): ResolvedInferenceOutcome {
  if (spec === undefined) return { kind: "fallback" };
  const resolved = resolveInferenceSpec(spec, settings);
  if (resolved !== null) return { kind: "resolved", value: resolved };

  // No viable leg. `mode: "pin"` and `agentModelFallback: "none"` both mean
  // "do not silently fall through"; any other combination permits fallback.
  const forbidFallback =
    spec.mode === "pin" || settings.agentModelFallback === "none";
  if (forbidFallback) {
    const legs = spec.order.map((l) => `${l.provider}/${l.model}`).join(", ");
    return {
      kind: "unavailable",
      reason: `none of the configured providers expose the requested model(s): ${legs}`,
    };
  }
  return { kind: "fallback" };
}
