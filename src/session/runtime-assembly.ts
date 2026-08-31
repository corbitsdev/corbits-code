// Shared runtime assembly used by the exec and TUI runners.
//
// Only near-verbatim blocks live here. Gate / toolset / director construction
// bind runner-specific state and stay in each runner.

import type { ConversationTurn, InferenceSource } from "@intx/types/runtime";
import type { Compactor } from "@intx/types/runtime";

import { buildChatSystemPrompt } from "../agent/prompts.js";
import type { ToolAvailability } from "../agent/tool-search.js";
import { gatherEnvironment } from "../agent/environment.js";
import {
  loadAgentContextExtensions,
  loadSystemPromptOverrides,
} from "../agent/context-extensions.js";
import type { ProviderCatalogEntry } from "../config/index.js";
import { buildMainSessionSources } from "../config/inference-sources.js";
import type { SessionMode } from "../config/session-mode.js";
import type { PluginConfig, Settings } from "../config/settings.js";
import { discoverSkills, type SkillSummary } from "../extensions/skills.js";
import {
  dedupePluginModules,
  discoverClaudeInstalledPlugins,
  discoverRepoPlugins,
  discoverUserPlugins,
  loadPluginsFromPaths,
  type PluginLoadDiagnostics,
  type PluginModule,
} from "../plugins/loader.js";
import { isPluginModuleEnabled } from "../plugins/register.js";
import {
  loadApprovals,
  loadGlobalApprovals,
  loadProjectApprovals,
  loadProviderModelApprovals,
  saveGlobalApproval,
  saveProjectApproval,
  saveProviderModelApproval,
} from "../permission/store.js";
import type { Approval, GrantScope } from "../permission/types.js";
import type { ReasoningEffort } from "../provider/reasoning-effort.js";
import type { SubAgentProvider } from "../subagent/index.js";
import { COMPACTOR_KEEP_RECENT_TURNS, createPruningCompactor } from "./compactor.js";
import type { SummaryContext } from "./summarizer.js";
import { NOOP_TELEMETRY, type Telemetry } from "../telemetry/index.js";

// ---------------------------------------------------------------------------
// 1. Sub-agent provider literal
// ---------------------------------------------------------------------------

export interface SubAgentProviderConfig {
  providerName: string;
  baseURL: string;
  apiKey?: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
  providers: readonly Pick<ProviderCatalogEntry, "name" | "bifrostVirtualKey">[];
}

/** Build the live sub-agent provider seed shared by exec and TUI. */
export function buildSubAgentProvider(config: SubAgentProviderConfig): SubAgentProvider {
  return {
    providerName: config.providerName,
    baseURL: config.baseURL,
    model: config.model,
    ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
    ...(config.reasoningEffort !== undefined ? { reasoningEffort: config.reasoningEffort } : {}),
    ...(config.providers.find((p) => p.name === config.providerName)?.bifrostVirtualKey === true
      ? { bifrostVirtualKey: true }
      : {}),
  };
}

export type SubAgentSourcesConfig = SubAgentProviderConfig & {
  providers: readonly ProviderCatalogEntry[];
  settings?: Settings;
};

export interface LiveSubAgentSources {
  provider: () => SubAgentProvider;
  catalog: () => readonly ProviderCatalogEntry[];
  settings: () => Settings | undefined;
}

/**
 * The single owner of every session fact a sub-agent spawn reads. A runner's
 * session config is reassigned by each switch path (model picker, /agent,
 * post-connect refresh, favorite toggle), so all three derive from a config
 * getter per spawn. Snapshot copies kept in sync by hand went stale whenever
 * a new switch path forgot to update them, which is what stranded workers on
 * a provider the operator had already switched away from.
 */
export function createLiveSubAgentSources(
  getConfig: () => SubAgentSourcesConfig,
): LiveSubAgentSources {
  return {
    provider: () => buildSubAgentProvider(getConfig()),
    catalog: () => getConfig().providers,
    settings: () => getConfig().settings,
  };
}

// ---------------------------------------------------------------------------
// 2. Permission approvals + persist callback
// ---------------------------------------------------------------------------

/** Session → project → global → provider-model merge order (first match wins in gate). */
export async function loadSeededApprovals(
  cwd: string,
  sessionId: string,
  home?: string,
): Promise<Approval[]> {
  const sessionApprovals = await loadApprovals(cwd, sessionId, home);
  const [projectApprovals, globalApprovals, providerModelApprovals] = await Promise.all([
    loadProjectApprovals(cwd),
    loadGlobalApprovals(),
    loadProviderModelApprovals(),
  ]);
  return [...sessionApprovals, ...projectApprovals, ...globalApprovals, ...providerModelApprovals];
}

/**
 * Route a gate-persisted grant to the store its scope selects.
 * Session grants never reach here — the gate keeps those in memory only.
 * `getActiveProviderModel` is read at persist time so a live model switch
 * stores new provider-model grants under the pair now in use.
 */
export function createApprovalPersist(
  cwd: string,
  getActiveProviderModel: () => string,
): (approval: Approval, scope: GrantScope) => void {
  return (approval: Approval, scope: GrantScope) => {
    if (scope === "project") void saveProjectApproval(cwd, approval);
    else if (scope === "global") void saveGlobalApproval(approval);
    else if (scope === "provider-model") {
      void saveProviderModelApproval(getActiveProviderModel(), approval);
    }
  };
}

// ---------------------------------------------------------------------------
// 3. Plugin resolution
// ---------------------------------------------------------------------------

export interface DiscoverSessionPluginsArgs {
  cwd: string;
  pluginPaths?: readonly string[];
  discoverClaudePlugins?: boolean;
  isProjectPluginTrusted: (pluginPath: string) => boolean;
  isRegisteredPathTrusted: (pluginPath: string) => boolean;
  /** When set, skill/load warnings collect here for one end-of-batch summary. */
  diagnostics?: PluginLoadDiagnostics;
  telemetry?: Telemetry;
}

/** Discover + dedupe plugins from repo, user, optional Claude, and registered paths. */
export async function discoverSessionPlugins(
  args: DiscoverSessionPluginsArgs,
): Promise<PluginModule[]> {
  const diag = {
    ...(args.diagnostics !== undefined ? { diagnostics: args.diagnostics } : {}),
    ...(args.telemetry !== undefined ? { telemetry: args.telemetry } : {}),
  };
  const claudePlugins =
    args.discoverClaudePlugins === true ? await discoverClaudeInstalledPlugins(args.cwd, diag) : [];
  return dedupePluginModules([
    ...(await discoverRepoPlugins(args.cwd, diag)),
    ...(await discoverUserPlugins(args.cwd, {
      isPluginTrusted: args.isProjectPluginTrusted,
      ...diag,
    })),
    ...claudePlugins,
    ...(await loadPluginsFromPaths([...(args.pluginPaths ?? [])], args.cwd, {
      isPluginTrusted: args.isRegisteredPathTrusted,
      ...diag,
    })),
  ]);
}

/** Skill directories from plugins that are executable and enabled (settings or repo defaultEnabled). */
export function skillDirsFromEnabledPlugins(
  modules: readonly PluginModule[],
  pluginConfig: Record<string, PluginConfig | undefined>,
): string[] {
  return modules
    .filter((m) => m.dir !== undefined && isPluginModuleEnabled(m, pluginConfig))
    .map((m) => m.dir!);
}

// ---------------------------------------------------------------------------
// 4. Context-extensions + skills → system prompt
// ---------------------------------------------------------------------------

export interface SessionChatPromptArgs {
  cwd: string;
  skillDirs: readonly string[];
  systemPromptExtensions?: readonly string[];
  sessionMode: SessionMode;
  toolAvailability: ToolAvailability;
}

export interface SessionChatPrompt {
  systemPrompt: string;
  skills: SkillSummary[];
}

/** Load AGENTS.md / SYSTEM.md / env / skills and build the main chat system prompt. */
export async function loadSessionChatPrompt(
  args: SessionChatPromptArgs,
): Promise<SessionChatPrompt> {
  const [agentExtensions, overrides, environment, skills] = await Promise.all([
    loadAgentContextExtensions(args.cwd),
    loadSystemPromptOverrides(args.cwd),
    gatherEnvironment(args.cwd),
    discoverSkills(args.cwd, [...args.skillDirs]),
  ]);
  const extensions = [
    ...agentExtensions,
    ...(args.systemPromptExtensions ?? []),
    ...overrides.append,
  ];
  return {
    systemPrompt: buildChatSystemPrompt(
      extensions.length > 0 ? extensions : undefined,
      environment,
      overrides.base,
      skills,
      args.sessionMode,
      args.toolAvailability,
    ),
    skills,
  };
}

// ---------------------------------------------------------------------------
// 5. Main-session inference sources
// ---------------------------------------------------------------------------

export interface MainSessionSourceConfig {
  settings?: Settings;
  providers: readonly ProviderCatalogEntry[];
  providerName: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
}

/** Wrap buildMainSessionSources with the common runner config field names. */
export function buildSessionSourcesFromConfig(
  config: MainSessionSourceConfig,
  sessionId: string,
): { sources: InferenceSource[]; defaultSource: string } {
  return buildMainSessionSources({
    settings: config.settings,
    catalog: config.providers,
    activeProvider: config.providerName,
    activeModel: config.model,
    ...(config.reasoningEffort !== undefined ? { reasoningEffort: config.reasoningEffort } : {}),
    sessionId,
  });
}

// ---------------------------------------------------------------------------
// 6. Pruning-compactor config
// ---------------------------------------------------------------------------

const SESSION_COMPACTOR_SUMMARY_MAX_CHARS = 2500;

export interface SessionPruningCompactorArgs {
  compactionMode: "llm" | "pruning";
  summarize: (turns: ConversationTurn[], ctx?: SummaryContext) => Promise<string>;
  summaryContext?: () => SummaryContext | undefined;
  telemetry?: Telemetry;
  /** Fires only when turns were actually folded away — not on no-ops. */
  onFolded?: (info: { turnsBefore: number; turnsAfter: number }) => void;
}

/** Shared pruning-compactor defaults for the main session agent. */
export function createSessionPruningCompactor(args: SessionPruningCompactorArgs): Compactor {
  const compactor = createPruningCompactor({
    keepRecentTurns: COMPACTOR_KEEP_RECENT_TURNS,
    summaryMaxChars: SESSION_COMPACTOR_SUMMARY_MAX_CHARS,
    ...(args.compactionMode !== "pruning" ? { summarize: args.summarize } : {}),
    ...(args.summaryContext ? { summaryContext: args.summaryContext } : {}),
  });
  const telemetry = args.telemetry ?? NOOP_TELEMETRY;
  return {
    ...compactor,
    async apply(turns, ctx) {
      const turnsBefore = turns.length;
      const startedAt = Date.now();
      const result = await compactor.apply(turns, ctx);
      // summarizedTurnCount is only set on the branch that actually folded
      // turns away. The other branch is a no-op (or image aging alone), and
      // reporting it as compaction would drag the duration and turn-count
      // averages toward the runs where nothing happened.
      if (result.record.decisions.summarizedTurnCount !== undefined) {
        telemetry.capture("compaction", {
          mode: args.compactionMode,
          duration_ms: Date.now() - startedAt,
          turns_before: turnsBefore,
          turns_after: result.output.length,
        });
        args.onFolded?.({ turnsBefore, turnsAfter: result.output.length });
      }
      return result;
    },
  };
}
