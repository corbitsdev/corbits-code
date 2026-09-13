// Shared runtime assembly used by the exec and TUI runners.
//
// Only near-verbatim blocks live here. The composed entry-point wiring built
// from them (trust → gate → agent → lifecycle) lives in
// `./assemble-runtime.ts`, which both runners consume; this module stays the
// home of the individual blocks.

import { getLogger } from "@intx/log";
import type {
  ConversationTurn,
  InboundMessage,
  InferenceSource,
} from "@intx/types/runtime";
import type { Compactor } from "@intx/types/runtime";

import { buildChatSystemPrompt } from "../agent/prompts.js";
import type { ToolAvailability } from "../agent/tool-search.js";
import { gatherEnvironment } from "../agent/environment.js";
import {
  loadAgentContextExtensions,
  loadSystemPromptOverrides,
} from "../agent/context-extensions.js";
import { LOG_NAMESPACE_ROOT } from "../branding.js";
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
  formatPendingProjectApprovals,
  loadApprovals,
  loadGlobalApprovals,
  loadPendingProjectApprovals,
  loadProjectApprovals,
  loadProviderModelApprovals,
  saveGlobalApproval,
  saveProjectApproval,
  saveProviderModelApproval,
} from "../permission/store.js";
import type { Approval, GrantScope } from "../permission/types.js";
import type { ReasoningEffort } from "../provider/reasoning-effort.js";
import type { SubAgentProvider } from "../subagent/index.js";
import {
  COMPACTOR_KEEP_RECENT_TURNS,
  createPruningCompactor,
} from "./compactor.js";
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
  providers: readonly Pick<
    ProviderCatalogEntry,
    "name" | "bifrostVirtualKey"
  >[];
}

/** Build the live sub-agent provider seed shared by exec and TUI. */
export function buildSubAgentProvider(
  config: SubAgentProviderConfig,
): SubAgentProvider {
  return {
    providerName: config.providerName,
    baseURL: config.baseURL,
    model: config.model,
    ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
    ...(config.reasoningEffort !== undefined
      ? { reasoningEffort: config.reasoningEffort }
      : {}),
    ...(config.providers.find((p) => p.name === config.providerName)
      ?.bifrostVirtualKey === true
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
  opts?: { onPendingProjectGrants?: ((text: string) => void) | undefined },
): Promise<Approval[]> {
  const sessionApprovals = await loadApprovals(cwd, sessionId, home);
  const [
    projectApprovals,
    globalApprovals,
    providerModelApprovals,
    pendingProjectApprovals,
  ] = await Promise.all([
    loadProjectApprovals(cwd, home),
    loadGlobalApprovals(),
    loadProviderModelApprovals(),
    loadPendingProjectApprovals(cwd, home),
  ]);
  // First encounter with an unconfirmed project approvals file: show the
  // operator what it would grant. The entries stay out of the seeded set
  // (loadProjectApprovals gates them) — this notice is the only trace.
  const pendingNotice = formatPendingProjectApprovals(pendingProjectApprovals);
  if (pendingNotice !== "") {
    persistLogger.warn("Unconfirmed project approvals in {cwd}", { cwd });
    try {
      opts?.onPendingProjectGrants?.(pendingNotice);
    } catch {
      // Notice delivery is best-effort; the grants stay gated regardless.
    }
  }
  return [
    ...sessionApprovals,
    ...projectApprovals,
    ...globalApprovals,
    ...providerModelApprovals,
  ];
}

const persistLogger = getLogger([LOG_NAMESPACE_ROOT, "session", "approvals"]);

/** Operator-facing copy when an Allow Always write fails. The in-session grant still holds. */
export const APPROVAL_PERSIST_FAILURE_NOTICE =
  "Allow Always applies this session, but remember did not stick.";

// The persist callback is fire-and-forget from the gate. A rejected write must
// not become an unhandledRejection (that path is fatal at process level); the
// in-memory grant already applies, so the approved call still completes.
function persistBestEffort(
  scope: GrantScope,
  write: Promise<void>,
  onPersistFailure?: (text: string) => void,
): void {
  void write.catch((err: unknown) => {
    persistLogger.warn("Failed to persist {scope} approval: {error}", {
      scope,
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      onPersistFailure?.(APPROVAL_PERSIST_FAILURE_NOTICE);
    } catch {
      // Notice is best-effort; never rethrow into an unhandledRejection.
    }
  });
}

/**
 * Route a gate-persisted grant to the store its scope selects.
 * Session grants never reach here — the gate keeps those in memory only.
 * `getActiveProviderModel` is read at persist time so a live model switch
 * stores new provider-model grants under the pair now in use.
 * Disk failures are logged, surfaced to the operator when a notice hook is
 * provided, and swallowed so they cannot crash the session.
 */
export function createApprovalPersist(
  cwd: string,
  getActiveProviderModel: () => string,
  onPersistFailure?: ((text: string) => void) | undefined,
): (approval: Approval, scope: GrantScope) => void {
  return (approval: Approval, scope: GrantScope) => {
    if (scope === "project")
      persistBestEffort(
        scope,
        saveProjectApproval(cwd, approval),
        onPersistFailure,
      );
    else if (scope === "global")
      persistBestEffort(scope, saveGlobalApproval(approval), onPersistFailure);
    else if (scope === "provider-model") {
      persistBestEffort(
        scope,
        saveProviderModelApproval(getActiveProviderModel(), approval),
        onPersistFailure,
      );
    }
  };
}

// ---------------------------------------------------------------------------
// 3. Plugin resolution
// ---------------------------------------------------------------------------

export interface DiscoverSessionPluginsArgs {
  cwd: string;
  pluginPaths?: readonly string[] | undefined;
  discoverClaudePlugins?: boolean | undefined;
  isProjectPluginTrusted: (pluginPath: string) => boolean;
  isRegisteredPathTrusted: (pluginPath: string) => boolean;
  /** When set, skill/load warnings collect here for one end-of-batch summary. */
  diagnostics?: PluginLoadDiagnostics | undefined;
  telemetry?: Telemetry | undefined;
}

/** Discover + dedupe plugins from repo, user, optional Claude, and registered paths. */
export async function discoverSessionPlugins(
  args: DiscoverSessionPluginsArgs,
): Promise<PluginModule[]> {
  const diag = {
    ...(args.diagnostics !== undefined
      ? { diagnostics: args.diagnostics }
      : {}),
    ...(args.telemetry !== undefined ? { telemetry: args.telemetry } : {}),
  };
  const claudePlugins =
    args.discoverClaudePlugins === true
      ? await discoverClaudeInstalledPlugins(args.cwd, diag)
      : [];
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
  return modules.flatMap((m) =>
    m.dir !== undefined && isPluginModuleEnabled(m, pluginConfig)
      ? [m.dir]
      : [],
  );
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
  // Guideline sub-block ids to drop (see GUIDELINE_SUB_BLOCK_IDS).
  // Omitted = full guidelines.
  promptSectionOmit?: readonly string[];
  // Session-start snapshot from createAgentToolset. When provided, skip
  // rediscovery so the prompt listing and skill_search share one catalog.
  skills?: readonly SkillSummary[];
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
    args.skills !== undefined
      ? Promise.resolve([...args.skills])
      : discoverSkills(args.cwd, [...args.skillDirs]),
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
      args.promptSectionOmit !== undefined
        ? { omit: args.promptSectionOmit }
        : undefined,
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
    ...(config.reasoningEffort !== undefined
      ? { reasoningEffort: config.reasoningEffort }
      : {}),
    sessionId,
  });
}

// ---------------------------------------------------------------------------
// 6. Pruning-compactor config
// ---------------------------------------------------------------------------

const SESSION_COMPACTOR_SUMMARY_MAX_CHARS = 2500;

export interface SessionPruningCompactorArgs {
  /** Omitted for sourceless leaves — compaction falls back to the deterministic stub. */
  summarize?: (
    turns: ConversationTurn[],
    ctx?: SummaryContext,
  ) => Promise<string>;
  summaryContext?: () => SummaryContext | undefined;
  telemetry?: Telemetry;
  /** Fires only when turns were actually folded away — not on no-ops. */
  onFolded?: (info: { turnsBefore: number; turnsAfter: number }) => void;
}

/** Shared pruning-compactor defaults for the main session agent. */
export function createSessionPruningCompactor(
  args: SessionPruningCompactorArgs,
): Compactor {
  const compactor = createPruningCompactor({
    keepRecentTurns: COMPACTOR_KEEP_RECENT_TURNS,
    summaryMaxChars: SESSION_COMPACTOR_SUMMARY_MAX_CHARS,
    ...(args.summarize !== undefined ? { summarize: args.summarize } : {}),
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
          mode: "llm",
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

// ---------------------------------------------------------------------------
// 7. Compaction continuation message
// ---------------------------------------------------------------------------

/**
 * Content-less inbound the compaction governor self-delivers after a compact
 * cycle so the reactor re-enters instead of idling (the reactor emits no
 * event after compact). Single owner for the TUI, exec, and sub-agent loops —
 * the three copies were byte-identical, so a new field is a one-site change.
 */
export function buildCompactionContinuationMessage(): InboundMessage {
  return {
    ref: { uid: 0, mailbox: "system" },
    headers: {
      from: "user@local",
      to: ["agent@local"],
      date: new Date().toISOString(),
      messageId: `compact-continue-${Date.now()}@local`,
    },
    flags: [],
    content: "",
    signatureStatus: "missing",
  };
}

/**
 * System-originated inbound that re-enters the parent after the fleet goes dry
 * with todo/doing tasks still open. Not operator input, so no
 * OPERATOR_ORIGINATED_FLAG. ChatDirector still resets idle and tool-only
 * nudge counters on any message.received — occupancy therefore fires one
 * deferred shot per dry edge rather than re-driving on every settle.
 */
export function buildFleetDryContinuationMessage(text: string): InboundMessage {
  return {
    ref: { uid: 0, mailbox: "system" },
    headers: {
      from: "user@local",
      to: ["agent@local"],
      date: new Date().toISOString(),
      messageId: `fleet-dry-continue-${Date.now()}@local`,
    },
    flags: [],
    content: text,
    signatureStatus: "missing",
  };
}

/**
 * System-originated inbound that re-enters the parent when mailbox mail
 * (worker terminal or fail) is ready. Not operator input, so no
 * OPERATOR_ORIGINATED_FLAG.
 */
export function buildMailboxMailMessage(text: string): InboundMessage {
  return {
    ref: { uid: 0, mailbox: "system" },
    headers: {
      from: "user@local",
      to: ["agent@local"],
      date: new Date().toISOString(),
      messageId: `mailbox-mail-${Date.now()}@local`,
    },
    flags: [],
    content: text,
    signatureStatus: "missing",
  };
}

// Preview cap for a background shell's inline output; the full output stays in
// the registry (shell_collect) and, when truncated, in the spill blob.
const BACKGROUND_SHELL_PREVIEW_CHARS = 2_000;

/**
 * Content-bearing inbound the host delivers when a background run_shell process
 * exits. Mailbox "system" and empty flags: loop protection treats it as
 * system-originated, so it re-enters the reactor without counting as operator
 * input (see message-provenance.ts).
 */
export function buildShellBackgroundMessage(exit: {
  id: string;
  command: string;
  exitCode: number;
  timedOut: boolean;
  output: string;
  spillUri?: string;
}): InboundMessage {
  const status = exit.timedOut
    ? `timed out and was killed (exit code ${exit.exitCode})`
    : `exit code ${exit.exitCode}`;
  const lines = [
    `Background shell ${exit.id} finished: ${status}.`,
    `command: ${exit.command}`,
  ];
  if (exit.output.length > 0) {
    const preview =
      exit.output.length > BACKGROUND_SHELL_PREVIEW_CHARS
        ? `${exit.output.slice(0, BACKGROUND_SHELL_PREVIEW_CHARS)}\n[...preview truncated]`
        : exit.output;
    lines.push(`output:\n${preview}`);
  }
  if (exit.spillUri !== undefined) {
    lines.push(
      `Full output was spilled to ${exit.spillUri} (readable via read_file).`,
    );
  }
  return {
    ref: { uid: 0, mailbox: "system" },
    headers: {
      from: "user@local",
      to: ["agent@local"],
      date: new Date().toISOString(),
      messageId: `bg-shell-${exit.id}@local`,
    },
    flags: [],
    content: lines.join("\n"),
    signatureStatus: "missing",
  };
}
