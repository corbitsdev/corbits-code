import { fromToolRunner, stringTool } from "@intx/agent";
import type { AgentTool } from "@intx/agent";
import type {
  RetryPolicy,
  ToolCall,
  ToolDefinition,
} from "@intx/types/runtime";
import { type } from "arktype";
import { createPosixTools, type ToolPlugin } from "@intx/tools-posix";
import {
  askOperatorDefinition,
  presentDefinition,
  submitOutputDefinition,
} from "../agent/director.js";
import { manageTasksDefinition } from "./tasks.js";
import { validateView } from "../tui/view/validate.js";
import { SETTINGS_DIR_NAME } from "../branding.js";
import {
  advertiseShellGuardTimeout,
  type ShellTimeoutConfig,
} from "../plugins/shell-guard-plugin.js";
import { advertiseEditFileLineRange } from "../plugins/edit-file-line-range.js";
import { advertiseArchiveSurface } from "../plugins/evidence-archive-search-plugin.js";
import type { Telemetry } from "../telemetry/index.js";
import type { PermissionGate } from "../permission/gate.js";
import { createWorktreeRootsProvider } from "../permission/worktree-roots.js";
import { buildCorePosixToolPlugins } from "./posix-tool-plugins.js";
import { createLazyBlobReader } from "./lazy-blob-reader.js";
import type { BlobReader } from "@intx/types/runtime";
import {
  wrapAgentToolResultTruncation,
  wrapAgentToolsWithResultTruncation,
  type SpillBlobWriter,
} from "../plugins/result-truncation-plugin.js";
import type { CompactionArchive } from "../session/compaction-archive.js";
import {
  BrowserAuthPendingError,
  connectMCPServer as connectMCPClient,
  type MCPClient,
  type MCPConnectResult,
} from "../mcp/client.js";
import {
  createExaMCPServerConfig,
  EXA_MCP_SERVER_NAME,
  isBuiltinExaMCPServer,
} from "../mcp/exa.js";
import { mcpClientTools, MCP_RECONNECTING_TOOL_ERROR } from "../mcp/plugin.js";
import { mcpToolName, parseMcpToolName } from "../mcp/tool-name.js";
import { gateAgentTools } from "../plugins/permission-plugin.js";
import {
  createDynamicToolRunner,
  type DynamicToolRunner,
} from "./dynamic-tool-runner.js";
import type { MCPServerConfig, Settings } from "../config/settings.js";
import {
  filterMcpServersForConnect,
  mcpServerFingerprint,
  type ProjectTrustStore,
} from "../trust/project-trust.js";
import type { ToolWatchdogConfig } from "./tool-execution-watchdog.js";
import type { SessionMode } from "../config/session-mode.js";
import { sessionModeEnablesSubAgents } from "../config/session-mode.js";
import {
  advertisedToolNamesForSessionMode,
  type ToolAvailability,
} from "./tool-search.js";
import { discoverSkills, type SkillSummary } from "../extensions/skills.js";
import type { ProviderCatalogEntry } from "../config/index.js";
import type { AgentProfile } from "./profiles.js";
import type { WorkflowCompleteResult } from "../workflows/types.js";
import {
  runSubAgent,
  type SubAgentProvider,
  type SubAgentSessionStore,
} from "../subagent/index.js";
import {
  createFleetMailbox,
  createSpawnAgentTool,
  createWaitAgentsTool,
  createListAgentsTool,
  type FleetMailboxHandle,
} from "../subagent/agent-fleet.js";
import { DEFAULT_CLOSE_DEADLINE_MS } from "../subagent/dispose.js";
import {
  createCloseAgentTool,
  createResumeAgentTool,
  createInterruptAgentTool,
  createSendInputTool,
} from "../subagent/lifecycle-tools.js";
import { createManageTasksRunner } from "./tasks.js";
import { createSpillingBackgroundShellExitNotifier } from "./background-shell-tool.js";
import {
  createBackgroundShellRegistry,
  type BackgroundShellExit,
} from "../shell/background-shell.js";
import { createShellOutputFeedMap } from "../session/shell-output-feed.js";
import { createListDirTool } from "../util/list-dir.js";
import {
  createExaMCPWebFetchTool,
  createWebFetchTool,
} from "../tools/web-fetch.js";
import {
  createWebSearchTool,
  disposeWebSearchClients,
} from "../tools/web-search.js";
import { createApplyPatchTool } from "./apply-patch-tool.js";
import { createUseSkillTool } from "./use-skill.js";
import { searchSkillCatalog } from "./skill-search.js";
import {
  createToolIndex,
  createToolSearchTool,
  TOOL_SEARCH_PENDING_WAIT_MS,
  toolSearchDefinition,
} from "./tool-search.js";
import {
  lexicalFields,
  scoreLexical,
  tokenizeLexical,
} from "./lexical-rank.js";
import { createSearchAgentsTool } from "./agent-search.js";
import { createReadAgentTraceTool } from "../subagent/trace-tool.js";
import { errorMessage } from "./error-message.js";
import type { ReactorEmittedEvent } from "@intx/inference";

const AskOperatorArgs = type({
  question: "string",
  options: "string[]",
});

/** Cap on each ask_operator option label (UTF-16 code units). */
export const ASK_OPERATOR_OPTION_MAX_CHARS = 48;

/** Cap on the ask_operator question (UTF-16 code units). */
export const ASK_OPERATOR_QUESTION_MAX_CHARS = 160;

export function mcpReconnectDelayMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  return Math.min(30_000, 1000 * 2 ** (attempt - 1) * random());
}

function rethrowToolsetDisposeFailures(failures: unknown[]): void {
  const first = failures[0];
  if (first === undefined) return;
  if (failures.length === 1) throw first;
  throw new AggregateError(failures, "toolset leftover dispose failed");
}

const SubmitOutputArgs = type({
  "summary?": "string",
  "step?": "string",
});

// Operator picks an option, types a free-form answer, or dismisses; the gate
// owns this distinction so the tool layer maps each outcome to a result.
export type OperatorResult =
  | { kind: "option"; index: number }
  | { kind: "custom"; text: string }
  | { kind: "cancel" };

export interface AgentToolsetArgs {
  cwd: string;
  permissionGate: PermissionGate;
  // Interactive operator ask; omit on headless/non-TTY so the tool is unmounted.
  onOperatorGate?: (
    question: string,
    options: string[],
  ) => Promise<OperatorResult>;
  mcpServers?: MCPServerConfig[];
  /**
   * Where mcpServers came from. `"local"` requires project trust before spawn;
   * `"global"` / `"none"` skip the trust filter.
   */
  mcpServersSource?: "local" | "global" | "none";
  /**
   * Project trust store for local MCP. When source is local and store is
   * omitted, no local servers connect (fail closed).
   */
  projectTrust?: ProjectTrustStore;
  /** Interactive MCP trust grant; omit for headless fail-closed. */
  requestMcpTrust?: (server: MCPServerConfig) => Promise<boolean>;
  // Pre-resolved tool plugins (enabled + consented kind:"tool" plugins). Their
  // tools are appended to the posix toolset.
  extraToolPlugins?: ToolPlugin[];
  // Skill directories (from enabled plugins) the use_skill tool resolves bodies
  // from, in addition to the project-local and bundled defaults.
  skillDirs?: string[];
  // Session-start skill snapshot; when omitted, createAgentToolset discovers
  // once via discoverSkills. Passed to skill_search so it never rediscovers.
  skills?: readonly SkillSummary[];
  // Shell command timeout default/cap from settings; when omitted, shell-guard
  // applies the 120s foreground default (per-call overrides with no ceiling;
  // background has no default).
  shellTimeout?: ShellTimeoutConfig;
  // Outer per-invocation tool run budget (dynamic runner); built-in defaults
  // when omitted.
  toolWatchdog?: ToolWatchdogConfig;
  // Session blob store for tool-output:// reads, resolved when tools run so
  // agent rebuilds need not recreate the posix toolset.
  getBlobReader?: () => BlobReader | undefined;
  // Session blob store oversized tool results spill into (see
  // result-truncation-plugin.ts), keyed distinctly from getBlobReader reads so
  // the reactor's size-cap transform never overwrites the spill. Lazy like
  // getBlobReader; omitted where there is no session store (tests).
  getBlobWriter?: () => SpillBlobWriter | undefined;
  // Absolute session context dir (`…/context`) for the truncation notice's
  // on-disk path, re-read live across session rotation.
  getContextDir?: () => string | undefined;
  // Per-project settings.env, merged into the run_shell tool's spawn environment.
  shellEnv?: Record<string, string>;
  /**
   * Runtime secret-guard denylist for the active --config path; entry points
   * pass [config.globalSettingsPath]. Forwarded to the posix plugin stack and
   * workers; omitted keeps the static denylist only.
   */
  secretGuardExtraDeniedPaths?: readonly string[];
  // Called when a background run_shell exits. Hosts deliver the exit as a
  // system message so the reactor re-enters on a later turn; omit it and
  // background runs never notify.
  onBackgroundShellExit?: (exit: BackgroundShellExit) => void;
  /** Primary-only evidence archive; workers omit this getter. */
  getEvidenceArchive?: () => CompactionArchive | undefined;
  // Whether a workflow is running. submit_output rides the wire every turn,
  // so the model can call it with nothing active; the handler then reports an
  // honest no-op instead of a false advance.
  isWorkflowActive?: () => boolean;
  // Compare-and-advance the live workflow; the handler reports this result
  // instead of reconstructing the cursor. Omitted (exec, tests) never claims
  // an advance.
  completeWorkflowStep?: (stepId: string) => WorkflowCompleteResult;
  // Primary session mode (always orchestrator; kept for call-site wiring).
  sessionMode?: SessionMode;
  // Session-start facts gating LSP advertisement. Omitted callers (tests,
  // ad-hoc toolsets) get it advertised, matching prior behavior; real sessions
  // always pass detected values — see tool-search.ts for why these must be
  // fixed for the session's life.
  toolAvailability?: ToolAvailability;
  // Per-project pinned tool names (local settings); they join the advertised
  // prefix at the session layer, and are excluded from tool_search here so
  // discovery only surfaces names not already on the wire.
  pinnedTools?: readonly string[];
  // Records skill loads and sub-agent dispatch; omitted (tests, ad-hoc
  // toolsets) means those events never emit.
  telemetry?: Telemetry;
  // When provided, the agent gets fleet tools delegating to autonomous
  // sub-agents; omitted where sub-agents cannot spawn (e.g. tests).
  subAgent?: {
    provider: SubAgentProvider | (() => SubAgentProvider);
    getWorkdirBase: () => string;
    onEvent?: (event: ReactorEmittedEvent) => void;
    // TUI status-bar progress; prefer over onEvent when the parent transcript
    // must not receive sub-agent text.
    onProgress?: (info: { description: string; toolName: string }) => void;
    // Child session records for enter-session UI; child events stay in the
    // store only.
    sessions?: SubAgentSessionStore;
    settings?: Settings | (() => Settings | undefined);
    catalog?:
      | readonly ProviderCatalogEntry[]
      | (() => readonly ProviderCatalogEntry[]);
    profiles?: AgentProfile[] | (() => AgentProfile[]);
    // Opt-in: each sub-agent runs in its own git worktree instead of this
    // session's cwd. See src/subagent/worktree.ts.
    useWorktree?: boolean;
    // Retry-timing overrides forwarded to each spawned run — same seam the
    // fleet deps document for tests; production callers omit them.
    outerRetryDelayMs?: number;
    retryPolicy?: RetryPolicy;
  };
  /** Kept for callers still passing the Codex family flag: no proxies mount
   * now, hidden aliases dispatch onto engine tools. */
  isCodex?: boolean;
  /**
   * Opt-in: mount wait_agents beside the other fleet verbs. Exec-primary only
   * (with an advertised allow); TUI primary and nested orchestrators collect
   * worker reports from mailbox mail instead.
   */
  mountWaitAgents?: boolean;
  /**
   * Closed allow list (exec director overlays). tool_search mounts only when
   * allowed, and the index only surfaces allowed tools. Omit for the product
   * default (tool_search mounted, index over the live registry).
   */
  toolSearchAllow?: readonly string[];
}

// Per-server connection state surfaced to the TUI.
export type MCPServerState =
  | { name: string; state: "connecting" }
  | { name: string; state: "needs-auth"; url: string }
  | { name: string; state: "connected"; tools: string[] }
  | {
      name: string;
      state: "failed";
      error: string;
      /** Browser auth was offered but never finished — the auth marker owns it. */
      authPending?: boolean;
    }
  | { name: string; state: "disconnected" }
  // Transport died: tools stay mounted as fail-fast stubs while backoff
  // redials; `attempt` counts redials for the TUI.
  | {
      name: string;
      state: "reconnecting";
      tools: string[];
      attempt: number;
      error: string;
    };

export interface MCPConnectCallbacks {
  // Headless hosts must not advertise an auth callback they cannot complete;
  // its presence marks the OAuth flow as interactive.
  interactiveAuth: boolean;
  // Fired whenever a server's connection state changes.
  onStatus: (state: MCPServerState) => void;
  // Fired after a server connects and its tools register, with the full
  // definition set so the director can advertise it on the next inference.
  onToolsChanged: (definitions: ToolDefinition[]) => void;
}

export interface AgentToolset {
  // Mutable runner the agent dispatches through; seeded with posix/web/LSP
  // tools, MCP tools added as servers connect.
  dynamicRunner: DynamicToolRunner;
  // Connect configured MCP servers in the background; resolves once every
  // server connected or failed, with authorization waits bounded by `signal`.
  connectMCP: (
    callbacks: MCPConnectCallbacks,
    signal?: AbortSignal,
  ) => Promise<void>;
  // Bounded live-output tails of foreground shells, polled by the transcript
  // for each pending run_shell row's live lines.
  shellOutputFeed: ReturnType<typeof createShellOutputFeedMap>;
  // Connect one newly persisted server through the same lifecycle as startup MCP.
  connectMCPServer: (
    config: MCPServerConfig,
    callbacks: MCPConnectCallbacks,
    signal?: AbortSignal,
  ) => Promise<void>;
  // Drop a server's tools in the running session. Idempotent for unknown and
  // already-disconnected names; the live teardown disable/remove need.
  disconnectMCPServer: (
    name: string,
    callbacks: MCPConnectCallbacks,
  ) => Promise<void>;
  // True while connected, connecting, or backoff-redialing; false after
  // teardown or a failed connect. Persist blocks a second add of an active
  // name with this; failed rows retry via connectMCPServer. Still true while
  // disable is in progress.
  hasMCPServer: (name: string) => boolean;
  // Single-dial manual retry for failed/reconnecting rows; cancels any backoff
  // loop first so exactly one dial runs. Terminal failures stay down until
  // this is called.
  retryMCPServer: (
    config: MCPServerConfig,
    callbacks: MCPConnectCallbacks,
    signal?: AbortSignal,
  ) => Promise<void>;
  // Bounded wait for in-flight MCP handshakes; resolves to the remaining
  // count. Capped by `timeoutMs` so a hung authorization never hangs the
  // caller.
  awaitPendingMcpConnections: (timeoutMs?: number) => Promise<number>;
  // Catalog unshadow can change the source without rebuilding the toolset;
  // connectOne reads this on every late connect.
  setMcpServersSource: (source: "local" | "global" | "none") => void;
  // Wire the promote-on-execute promoter (an undeclared registered call
  // declares that one name, then dispatches). Set once the director + reload
  // loop exist.
  setToolPromoter: (promote: (names: string[]) => void) => void;
  // Session-start skill snapshot shared with the prompt listing.
  skills: SkillSummary[];
  /**
   * Live wait mailbox built for spawn_agent / wait_agents; absent when the
   * session has no sub-agents. Read it each time, not a startup snapshot.
   */
  fleetRecords?: FleetMailboxHandle;
  dispose: () => Promise<void>;
}

// Connect-only abort fan-out: the client keeps `signal` on the live transport,
// so a shared parent abort would tear down HTTP already connected. Forward
// until the handshake settles, then detach.
function forwardAbortUntilDisarmed(parent: AbortSignal): {
  signal: AbortSignal;
  disarm: () => void;
} {
  const controller = new AbortController();
  if (parent.aborted) {
    controller.abort(parent.reason);
    return { signal: controller.signal, disarm: () => undefined };
  }
  const onAbort = (): void => {
    controller.abort(parent.reason);
  };
  parent.addEventListener("abort", onAbort, { once: true });
  let disarmed = false;
  return {
    signal: controller.signal,
    disarm: () => {
      if (disarmed) return;
      disarmed = true;
      parent.removeEventListener("abort", onAbort);
    },
  };
}

export async function createAgentToolset(
  args: AgentToolsetArgs,
): Promise<AgentToolset> {
  const {
    cwd,
    permissionGate,
    onOperatorGate,
    mcpServers = [createExaMCPServerConfig()],
    projectTrust,
    requestMcpTrust,
    extraToolPlugins = [],
    skillDirs = [],
    shellTimeout,
    toolWatchdog,
    getBlobReader,
    getBlobWriter,
    getContextDir,
    getEvidenceArchive,
    sessionMode = "orchestrator",
    shellEnv,
    secretGuardExtraDeniedPaths,
    toolAvailability = { languageServerAvailable: true },
  } = args;
  let mcpServersSource = args.mcpServersSource ?? "none";
  // One registry per toolset: background run_shell starts here, dispose reads
  // the same instance.
  const backgroundShells = createBackgroundShellRegistry({
    ...(args.onBackgroundShellExit !== undefined
      ? {
          onExit: createSpillingBackgroundShellExitNotifier({
            ...(getBlobWriter !== undefined ? { getBlobWriter } : {}),
            notify: args.onBackgroundShellExit,
          }),
        }
      : {}),
  });
  // Bounded live-output tails of foreground shells, polled by the TUI for each
  // pending run_shell row. Workers get a map too; nothing reads it unless a
  // transcript polls it.
  const shellOutputFeed = createShellOutputFeedMap();
  const sessionBlobReader =
    getBlobReader !== undefined
      ? createLazyBlobReader(getBlobReader)
      : undefined;
  const subAgentsEnabled = sessionModeEnablesSubAgents(sessionMode);
  const advertisedBuiltIns = [
    ...advertisedToolNamesForSessionMode(sessionMode, toolAvailability),
    ...(args.pinnedTools ?? []),
  ];
  const skills =
    args.skills !== undefined
      ? [...args.skills]
      : await discoverSkills(cwd, skillDirs);
  let builtinExaEnabled = mcpServers.some(isBuiltinExaMCPServer);
  let resolveBuiltinExaConnection:
    | ((result: MCPConnectResult) => void)
    | undefined;
  let builtinExaConnection: Promise<MCPConnectResult> | undefined =
    builtinExaEnabled
      ? new Promise<MCPConnectResult>((resolve) => {
          resolveBuiltinExaConnection = resolve;
        })
      : undefined;

  const waitForBuiltinExaConnection = async (
    signal: AbortSignal,
  ): Promise<MCPConnectResult> => {
    const pending = builtinExaConnection;
    if (pending === undefined) {
      return {
        ok: false,
        serverName: "exa",
        error: "built-in Exa MCP is not enabled",
      };
    }
    if (signal.aborted) {
      return {
        ok: false,
        serverName: "exa",
        error: "aborted while waiting for Exa MCP connection",
      };
    }
    return new Promise<MCPConnectResult>((resolve) => {
      const onAbort = (): void => {
        resolve({
          ok: false,
          serverName: "exa",
          error: "aborted while waiting for Exa MCP connection",
        });
      };
      signal.addEventListener("abort", onAbort, { once: true });
      pending.then((result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      });
    });
  };

  const inheritedMcpTools: AgentTool[] = [];
  if (builtinExaEnabled) {
    inheritedMcpTools.push(
      createExaMCPWebFetchTool({ connect: waitForBuiltinExaConnection }),
    );
  }

  const truncationOptions = {
    ...(getBlobWriter !== undefined ? { getBlobWriter } : {}),
    ...(getContextDir !== undefined ? { getContextDir } : {}),
    ...(getEvidenceArchive !== undefined ? { getEvidenceArchive } : {}),
  };
  const posixTools = createPosixTools({
    cwd,
    ...(sessionBlobReader !== undefined
      ? { blobReader: sessionBlobReader }
      : {}),
    plugins: buildCorePosixToolPlugins({
      cwd,
      permissionGate,
      ...(shellTimeout !== undefined ? { shellTimeout } : {}),
      extraToolPlugins,
      ...(secretGuardExtraDeniedPaths !== undefined
        ? { secretGuardExtraDeniedPaths }
        : {}),
      ...(sessionBlobReader !== undefined
        ? { readFileGuard: { blobReader: sessionBlobReader } }
        : {}),
      ...truncationOptions,
      ...(getEvidenceArchive !== undefined ? { getEvidenceArchive } : {}),
      ...(shellEnv !== undefined ? { shellEnv } : {}),
      getBackgroundShellRegistry: () => backgroundShells,
      getShellOutputFeeds: () => shellOutputFeed,
    }),
  });

  // Advertise the shell-guard timeout (120s foreground default;
  // settings.shell.timeoutMs when set).
  // Orchestrator tools (search / trace / fleet) assemble once so the fleet
  // verbs share one session store — never a private mailbox for
  // spawn_agent/wait_agents.
  const orchestratorTools: AgentTool[] = [];
  let fleetSessionsForDispose: SubAgentSessionStore | undefined;
  let fleetRecords: FleetMailboxHandle | undefined;
  if (subAgentsEnabled && args.subAgent !== undefined) {
    const sa = args.subAgent;
    fleetRecords =
      sa.sessions !== undefined ? createFleetMailbox(sa.sessions) : undefined;
    if (sa.profiles !== undefined) {
      orchestratorTools.push(
        createSearchAgentsTool(() => {
          const profiles = sa.profiles;
          return typeof profiles === "function" ? profiles() : (profiles ?? []);
        }),
      );
    }
    // Tier 1: the primary session is always an orchestrator and may target
    // any worker, so no authority context is passed here; omission means
    // unrestricted, matching Tier 1's actual authority.
    orchestratorTools.push(createReadAgentTraceTool(sa.getWorkdirBase));

    // Mirror runSubAgent's orchestrator fleet mount (run.ts) but reuse the
    // existing TUI/exec session store. spawnAllowlist stays unwired on
    // primary.
    if (sa.sessions !== undefined && fleetRecords !== undefined) {
      const fleetSessions = sa.sessions;
      fleetSessionsForDispose = fleetSessions;
      const fleetDeps = {
        permissionGate,
        inheritMcpTools: (gate: PermissionGate) =>
          gateAgentTools(inheritedMcpTools, gate),
        ...(shellTimeout !== undefined ? { shellTimeout } : {}),
        ...(shellEnv !== undefined ? { shellEnv } : {}),
        ...(secretGuardExtraDeniedPaths !== undefined
          ? { secretGuardExtraDeniedPaths }
          : {}),
        ...(skillDirs.length > 0 ? { skillDirs } : {}),
        // Parent's already-discovered catalog; shared-cwd lanes reuse it,
        // worktree lanes (different cwd) rediscover.
        skillSnapshot: skills,
        ...(extraToolPlugins.length > 0 ? { extraToolPlugins } : {}),
        cwd,
        getWorkdirBase: sa.getWorkdirBase,
        provider: sa.provider,
        ...(args.getBlobReader !== undefined
          ? { getBlobReader: args.getBlobReader }
          : {}),
        run: runSubAgent,
        sessions: fleetSessions,
        fleetRecords,
        ...(sa.useWorktree !== undefined
          ? { useWorktree: sa.useWorktree }
          : {}),
        ...(sa.outerRetryDelayMs !== undefined
          ? { outerRetryDelayMs: sa.outerRetryDelayMs }
          : {}),
        ...(sa.retryPolicy !== undefined
          ? { retryPolicy: sa.retryPolicy }
          : {}),
        ...(sa.onEvent !== undefined ? { onEvent: sa.onEvent } : {}),
        ...(sa.onProgress !== undefined ? { onProgress: sa.onProgress } : {}),
        ...(sa.settings !== undefined ? { settings: sa.settings } : {}),
        ...(sa.catalog !== undefined ? { catalog: sa.catalog } : {}),
        ...(sa.profiles !== undefined ? { profiles: sa.profiles } : {}),
        ...(args.telemetry !== undefined ? { telemetry: args.telemetry } : {}),
      };
      orchestratorTools.push(
        createSpawnAgentTool(fleetDeps),
        createListAgentsTool({ sessions: fleetSessions, fleetRecords }),
        createCloseAgentTool({ sessions: fleetSessions, fleetRecords }),
        createResumeAgentTool({ sessions: fleetSessions, fleetRecords }),
        createInterruptAgentTool({ sessions: fleetSessions, fleetRecords }),
        createSendInputTool({ sessions: fleetSessions, fleetRecords }),
      );
      // Exec-primary opt-in only; TUI primary and nested orchestrators collect
      // via mailbox mail, so wait_agents stays unmounted there. See
      // mountWaitAgents.
      if (args.mountWaitAgents === true) {
        orchestratorTools.push(
          createWaitAgentsTool({
            sessions: fleetSessions,
            fleetRecords,
          }),
        );
      }
    }
  }

  const runManageTasks = createManageTasksRunner();

  const baseTools: AgentTool[] = [
    ...fromToolRunner(posixTools).map((tool) => {
      let definition = advertiseEditFileLineRange(
        advertiseShellGuardTimeout(
          tool.definition,
          shellTimeout?.defaultMs,
          shellTimeout?.maxMs,
        ),
      );
      if (getEvidenceArchive !== undefined)
        definition = advertiseArchiveSurface(definition);
      return { ...tool, definition };
    }),
    createListDirTool(cwd, {
      allowOutside: () => permissionGate.getSkipPermissions(),
      rootsProvider: createWorktreeRootsProvider(cwd),
    }),
    createUseSkillTool(cwd, skillDirs, args.telemetry),
    createApplyPatchTool(cwd, {
      allowOutside: () => permissionGate.getSkipPermissions(),
      rootsProvider: createWorktreeRootsProvider(cwd),
      ...(args.secretGuardExtraDeniedPaths !== undefined
        ? { extraDeniedPaths: args.secretGuardExtraDeniedPaths }
        : {}),
    }),
    builtinExaEnabled
      ? createExaMCPWebFetchTool({ connect: waitForBuiltinExaConnection })
      : createWebFetchTool(),
    createWebSearchTool(),
    ...orchestratorTools,
    stringTool({
      definition: manageTasksDefinition,
      handler: async (rawArgs: Record<string, unknown>): Promise<string> => {
        const result = await runManageTasks(rawArgs);
        return result.content;
      },
    }),
    ...(onOperatorGate !== undefined
      ? [
          stringTool({
            definition: askOperatorDefinition,
            handler: async (
              rawArgs: Record<string, unknown>,
              _signal: AbortSignal,
            ): Promise<string> => {
              const parsed = AskOperatorArgs(rawArgs);
              if (parsed instanceof type.errors) {
                return "Error: ask_operator requires question (string) and options (array of strings).";
              }
              const { question, options } = parsed;
              if (options.length === 0) {
                return "Error: ask_operator requires at least one option.";
              }
              if (question.length > ASK_OPERATOR_QUESTION_MAX_CHARS) {
                return (
                  `Error: ask_operator question is ${question.length} characters; ` +
                  `keep it to ${ASK_OPERATOR_QUESTION_MAX_CHARS} or fewer. ` +
                  "Put the essay in a transcript reply first, then retry with a brief question."
                );
              }
              for (let i = 0; i < options.length; i++) {
                const option = options[i] ?? "";
                if (option.length > ASK_OPERATOR_OPTION_MAX_CHARS) {
                  return (
                    `Error: ask_operator option ${i + 1} is ${option.length} characters; ` +
                    `keep each label to ${ASK_OPERATOR_OPTION_MAX_CHARS} or fewer. ` +
                    "Put the essay in a transcript reply first, then retry with short option labels."
                  );
                }
              }
              const result = await onOperatorGate(question, options);
              if (result.kind === "cancel") {
                return "The operator dismissed the question without answering. Do not ask it again; proceed with your best judgment or continue with other work.";
              }
              if (result.kind === "custom") {
                return result.text;
              }
              const { index } = result;
              if (index < 0 || index >= options.length) {
                return `Error: invalid selection ${index}. Valid range: 0-${options.length - 1}.`;
              }
              const selected = options[index];
              if (selected === undefined) {
                return `Error: invalid selection ${index}. Valid range: 0-${options.length - 1}.`;
              }
              return selected;
            },
          }),
        ]
      : []),
    stringTool({
      definition: presentDefinition,
      handler: async (rawArgs: Record<string, unknown>): Promise<string> => {
        // The TUI renders the spec from the call args; this handler only
        // validates so an invalid spec yields an actionable error.
        const result = validateView(rawArgs.view);
        if (result.ok) return "Rendered.";
        return `Invalid view spec at ${result.error}. Fix the spec and call present again.`;
      },
    }),
    stringTool({
      definition: submitOutputDefinition,
      // The director also observes this call on tool.done; complete() is
      // compare-and-advance so a second pass is a no-op. The handler reports
      // complete()'s result so parallel calls cannot both claim an advance;
      // already-complete and not-current ids succeed without claiming one.
      handler: async (rawArgs: Record<string, unknown>): Promise<string> => {
        const parsed = SubmitOutputArgs(rawArgs);
        const step = parsed instanceof type.errors ? undefined : parsed.step;
        const summary =
          parsed instanceof type.errors ? undefined : parsed.summary;
        const workflowActive = args.isWorkflowActive?.() === true;
        if (workflowActive) {
          if (step === undefined || step.length === 0) {
            return "Error: workflow completion requires a step identifier.";
          }
          const result = args.completeWorkflowStep?.(step) ?? "not-current";
          if (result === "advanced") {
            const note =
              summary !== undefined && summary.length > 0
                ? ` (${summary})`
                : "";
            return `Workflow step marked complete${note}. Advancing to the next step.`;
          }
          if (result === "already-complete") {
            return "This workflow step is already complete. No advance.";
          }
          return "This workflow step is not current. No advance.";
        }
        if (step !== undefined && step.length > 0) {
          return "No active workflow — nothing to advance.";
        }
        return "Acknowledged.";
      },
    }),
  ];

  // tool_search ranks over the live runner (set below). Top hits load onto the
  // next infer via the session promoter; remaining cards stay
  // name+description until call.
  const runnerHolder: { current?: DynamicToolRunner } = {};
  const promoterHolder: { current?: (names: string[]) => void } = {};
  const toolIndex = createToolIndex(
    () => runnerHolder.current?.currentDefinitions() ?? [],
    advertisedBuiltIns,
    args.toolSearchAllow,
  );
  // Closed exec allow lists omit tool_search itself; when the allow excludes
  // it the tool is never mounted, so there is nothing to search with.
  if (
    args.toolSearchAllow === undefined ||
    args.toolSearchAllow.includes(toolSearchDefinition.name)
  ) {
    baseTools.push(
      createToolSearchTool({
        search: (query, limit) => toolIndex.search(query, limit),
        searchSkills: (query) => searchSkillCatalog(skills, query),
        lookup: (name) =>
          runnerHolder.current
            ?.currentDefinitions()
            .find((d) => d.name === name),
        promote: (names) => promoterHolder.current?.(names),
        // Misses wait briefly for in-flight MCP handshakes (bounded, so hung
        // OAuth cannot hang the call) and re-search before answering.
        awaitPendingConnections: (timeoutMs = TOOL_SEARCH_PENDING_WAIT_MS) =>
          awaitPendingMcpConnections(timeoutMs),
        // Tier-2 extension: true when a reconnecting server's retained tools
        // score against the query, so the search waits once more for the
        // redial to remount them. Needs-auth servers never populate the map —
        // only transport-death reconnects do — so this stays false for them.
        hasReconnectingMatch: (query: string): boolean => {
          const rawQuery = query.toLowerCase().trim();
          const queryTokens = tokenizeLexical(query);
          if (queryTokens.length === 0) return false;
          for (const [serverName, state] of reconnectingServers) {
            for (const tool of state.tools) {
              const score = scoreLexical(
                lexicalFields(
                  mcpToolName(serverName, tool.name),
                  `[${serverName}] ${tool.description}`,
                ),
                queryTokens,
                rawQuery,
              );
              if (score > 0) return true;
            }
          }
          return false;
        },
      }),
    );
  }

  const primaryTools = wrapAgentToolsWithResultTruncation(
    baseTools,
    truncationOptions,
  );

  const dynamicRunner = createDynamicToolRunner(primaryTools, toolWatchdog);
  runnerHolder.current = dynamicRunner;

  const connectedClients = new Map<string, MCPClient>();
  const inFlightConnections = new Map<string, Promise<void>>();
  const inFlightEpochs = new Map<string, number>();
  // Bounded wait for in-flight handshakes; resolves to the remaining count,
  // capped by `timeoutMs` so a hung authorization never hangs the caller.
  const awaitPendingMcpConnections = async (
    timeoutMs = TOOL_SEARCH_PENDING_WAIT_MS,
  ): Promise<number> => {
    if (inFlightConnections.size === 0) return 0;
    const pending = [...inFlightConnections.values()];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled(pending),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    return inFlightConnections.size;
  };
  const disabledNames = new Set<string>();
  const serverAborts = new Map<string, AbortController>();
  const serverEpochs = new Map<string, number>();
  const serverOpQueues = new Map<string, Promise<void>>();
  const mcpAbortController = new AbortController();
  let disposed = false;
  let disposal: Promise<void> | undefined;
  let mcpTrustStore: ProjectTrustStore = projectTrust ?? {
    trustedPluginPaths: [],
    trustedMcpFingerprints: [],
    trustedGrantFingerprints: [],
  };
  const untrustedLocalError = `Not trusted for this project (see ${SETTINGS_DIR_NAME}/trust.json)`;

  const filterServersForConnect = async (
    servers: MCPServerConfig[],
  ): Promise<MCPServerConfig[]> => {
    const allowed = await filterMcpServersForConnect(servers, {
      source: mcpServersSource,
      store: mcpTrustStore,
      cwd,
      ...(requestMcpTrust !== undefined
        ? { requestTrust: requestMcpTrust }
        : {}),
    });
    if (mcpServersSource !== "local") return allowed;
    // Remember grants so connectOneMCPServer does not re-prompt after startup TOFU.
    let fingerprints = mcpTrustStore.trustedMcpFingerprints;
    let changed = false;
    for (const server of allowed) {
      if (isBuiltinExaMCPServer(server)) continue;
      const fp = mcpServerFingerprint(server);
      if (!fingerprints.includes(fp)) {
        fingerprints = [...fingerprints, fp];
        changed = true;
      }
    }
    if (changed) {
      mcpTrustStore = {
        ...mcpTrustStore,
        trustedMcpFingerprints: fingerprints,
      };
    }
    return allowed;
  };

  const currentEpoch = (name: string): number => serverEpochs.get(name) ?? 0;

  const bumpEpoch = (name: string): number => {
    const next = currentEpoch(name) + 1;
    serverEpochs.set(name, next);
    return next;
  };

  const enqueueServerOp = (
    name: string,
    op: () => Promise<void>,
  ): Promise<void> => {
    const previous = serverOpQueues.get(name) ?? Promise.resolve();
    const run = previous.then(op, op);
    const tracked = run.then(
      () => undefined,
      () => undefined,
    );
    serverOpQueues.set(name, tracked);
    void tracked.then(() => {
      if (serverOpQueues.get(name) === tracked) serverOpQueues.delete(name);
    });
    return run;
  };

  const failBuiltinExaWaiters = (error: string): void => {
    resolveBuiltinExaConnection?.({
      ok: false,
      serverName: EXA_MCP_SERVER_NAME,
      error,
    });
    resolveBuiltinExaConnection = undefined;
  };

  const replaceInheritedTool = (toolName: string, tool: AgentTool): void => {
    const index = inheritedMcpTools.findIndex(
      (entry) => entry.definition.name === toolName,
    );
    if (index >= 0) inheritedMcpTools.splice(index, 1);
    inheritedMcpTools.push(tool);
  };

  const mountWebFetch = (tool: AgentTool): void => {
    const wrapped = wrapAgentToolResultTruncation(tool, truncationOptions);
    dynamicRunner.removeTools(["web_fetch"]);
    dynamicRunner.addTools([wrapped]);
    replaceInheritedTool("web_fetch", wrapped);
  };

  const swapBuiltinExaToNative = (): void => {
    failBuiltinExaWaiters("built-in Exa MCP was disconnected");
    mountWebFetch(createWebFetchTool());
  };

  const remountBuiltinExaAlias = (): void => {
    failBuiltinExaWaiters("built-in Exa MCP was disconnected");
    builtinExaConnection = new Promise<MCPConnectResult>((resolve) => {
      resolveBuiltinExaConnection = resolve;
    });
    mountWebFetch(
      createExaMCPWebFetchTool({ connect: waitForBuiltinExaConnection }),
    );
  };

  const dropServerTools = (name: string): void => {
    const names = dynamicRunner
      .currentDefinitions()
      .map((definition) => definition.name)
      .filter((toolName) => parseMcpToolName(toolName)?.server === name);
    dynamicRunner.removeTools(names);
    for (let i = inheritedMcpTools.length - 1; i >= 0; i--) {
      const entry = inheritedMcpTools[i];
      if (
        entry !== undefined &&
        parseMcpToolName(entry.definition.name)?.server === name
      ) {
        inheritedMcpTools.splice(i, 1);
      }
    }
  };

  const dropLiveClient = async (name: string): Promise<void> => {
    const client = connectedClients.get(name);
    connectedClients.delete(name);
    permissionGate.unregisterMcpServer(name);
    if (client !== undefined) await client.close().catch(() => undefined);
    dropServerTools(name);
  };

  // A transport that died under a live client. Tools stay mounted as fail-fast
  // stubs while backoff redials. One entry per server; a second death for the
  // same name is a duplicate close from the same dead transport.
  interface McpReconnectTool {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }
  interface McpReconnectState {
    config: MCPServerConfig;
    callbacks: MCPConnectCallbacks;
    tools: McpReconnectTool[];
    attempt: number;
  }
  const reconnectingServers = new Map<string, McpReconnectState>();

  const mountReconnectingStubs = (
    name: string,
    tools: readonly McpReconnectTool[],
  ): void => {
    dropServerTools(name);
    dynamicRunner.addTools(
      tools.map((tool): AgentTool => ({
        kind: "full",
        definition: {
          name: mcpToolName(name, tool.name),
          description: `[${name}] ${tool.description}`,
          inputSchema: tool.inputSchema,
        },
        handler: async (call: ToolCall) => ({
          callId: call.id,
          content: MCP_RECONNECTING_TOOL_ERROR,
          isError: true,
        }),
      })),
    );
  };

  const dropReconnectState = (name: string, state: McpReconnectState): void => {
    if (reconnectingServers.get(name) === state)
      reconnectingServers.delete(name);
  };

  const reconnectCancelled = (name: string, epoch: number): boolean =>
    disposed || disabledNames.has(name) || currentEpoch(name) !== epoch;

  const sleepAbortable = (ms: number, signal: AbortSignal): Promise<void> => {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  };

  // Redials that cannot succeed stop after the attempt that surfaced them:
  // untrusted local servers (fail closed until trust or the source changes),
  // misconfigured servers (missing command/url), and a stdio binary the OS
  // refuses to spawn. Everything else is transient and keeps reconnecting.
  const isTerminalReconnectError = (error: string): boolean =>
    error.includes("Not trusted for this project") ||
    error.includes("requires a command") ||
    error.includes("requires a url") ||
    error.includes("ENOENT") ||
    error.includes("EACCES");

  const reconnectLoop = async (name: string, epoch: number): Promise<void> => {
    for (;;) {
      const state = reconnectingServers.get(name);
      if (state === undefined) return;
      if (reconnectCancelled(name, epoch)) {
        dropReconnectState(name, state);
        return;
      }
      state.attempt += 1;
      const perServer = serverAborts.get(name);
      const backoffSignal =
        perServer === undefined
          ? mcpAbortController.signal
          : AbortSignal.any([mcpAbortController.signal, perServer.signal]);
      await sleepAbortable(mcpReconnectDelayMs(state.attempt), backoffSignal);
      if (
        reconnectingServers.get(name) !== state ||
        reconnectCancelled(name, epoch)
      ) {
        dropReconnectState(name, state);
        return;
      }
      // Drop the stubs so the redial can mount the live set without a
      // DuplicateToolError; transient outcomes re-mount them below.
      dropServerTools(name);
      let last: MCPServerState | undefined;
      await connectOneMCPServer(
        state.config,
        {
          ...state.callbacks,
          onStatus: (update) => {
            last = update;
            if (update.name !== name) {
              state.callbacks.onStatus(update);
              return;
            }
            switch (update.state) {
              case "connecting":
                return;
              case "needs-auth":
                // Keep fail-fast stubs mounted while the operator authorizes.
                mountReconnectingStubs(name, state.tools);
                state.callbacks.onStatus(update);
                return;
              case "failed":
                if (
                  update.authPending !== true &&
                  !isTerminalReconnectError(update.error)
                )
                  return;
                state.callbacks.onStatus(update);
                return;
              default:
                state.callbacks.onStatus(update);
            }
          },
        },
        undefined,
        epoch,
      );
      if (
        reconnectingServers.get(name) !== state ||
        reconnectCancelled(name, epoch)
      ) {
        dropReconnectState(name, state);
        return;
      }
      if (
        last !== undefined &&
        last.state === "connected" &&
        connectedClients.has(name)
      ) {
        reconnectingServers.delete(name);
        return;
      }
      // Terminal failures stay down: drop the stubs and stop redialing; only
      // a manual retry brings those rows back.
      if (
        last !== undefined &&
        last.name === name &&
        last.state === "failed" &&
        (last.authPending === true || isTerminalReconnectError(last.error))
      ) {
        dropServerTools(name);
        permissionGate.unregisterMcpServer(name);
        reconnectingServers.delete(name);
        return;
      }
      // Transient failure: keep the row reconnecting with the live attempt
      // instead of flashing failed; the emission names the next redial, which
      // the top of the loop counts into state.attempt.
      state.callbacks.onStatus({
        name,
        state: "reconnecting",
        tools: state.tools.map((tool) => tool.name),
        attempt: state.attempt + 1,
        error:
          last !== undefined && last.name === name && last.state === "failed"
            ? last.error
            : "transport closed unexpectedly; retrying in the background",
      });
      mountReconnectingStubs(name, state.tools);
    }
  };

  const handleTransportDeath = (
    config: MCPServerConfig,
    callbacks: MCPConnectCallbacks,
    epoch: number,
  ): void => {
    if (disposed || disabledNames.has(config.name)) return;
    if (currentEpoch(config.name) !== epoch) return;
    const client = connectedClients.get(config.name);
    if (client === undefined || reconnectingServers.has(config.name)) return;
    const tools: McpReconnectTool[] = client.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
    connectedClients.delete(config.name);
    void client.close().catch(() => undefined);
    mountReconnectingStubs(config.name, tools);
    callbacks.onStatus({
      name: config.name,
      state: "reconnecting",
      tools: tools.map((tool) => tool.name),
      attempt: 1,
      error: "transport closed unexpectedly; retrying in the background",
    });
    reconnectingServers.set(config.name, {
      config,
      callbacks,
      tools,
      attempt: 0,
    });
    void reconnectLoop(config.name, epoch);
  };

  const connectOneMCPServer = (
    config: MCPServerConfig,
    callbacks: MCPConnectCallbacks,
    signal?: AbortSignal,
    epoch?: number,
  ): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (connectedClients.has(config.name)) return Promise.resolve();
    const ownedEpoch = epoch ?? currentEpoch(config.name);
    const existing = inFlightConnections.get(config.name);
    if (
      existing !== undefined &&
      inFlightEpochs.get(config.name) === ownedEpoch
    ) {
      return existing;
    }
    let perServer = serverAborts.get(config.name);
    if (perServer === undefined) {
      perServer = new AbortController();
      serverAborts.set(config.name, perServer);
    }
    const forwarded =
      signal === undefined ? undefined : forwardAbortUntilDisarmed(signal);
    const connectionSignal =
      forwarded === undefined
        ? AbortSignal.any([mcpAbortController.signal, perServer.signal])
        : AbortSignal.any([
            mcpAbortController.signal,
            perServer.signal,
            forwarded.signal,
          ]);

    const staleOrDisabled = (): boolean =>
      disabledNames.has(config.name) ||
      currentEpoch(config.name) !== ownedEpoch;

    const run = (async () => {
      if (mcpServersSource === "local") {
        const allowed = await filterServersForConnect([config]);
        if (disposed) return;
        if (staleOrDisabled()) return;
        if (allowed.length === 0) {
          callbacks.onStatus({
            name: config.name,
            state: "failed",
            error: untrustedLocalError,
          });
          return;
        }
      }
      if (staleOrDisabled()) return;
      callbacks.onStatus({ name: config.name, state: "connecting" });
      let result: MCPConnectResult;
      try {
        result = await connectMCPClient(config, {
          stderr: "ignore",
          ...(callbacks.interactiveAuth
            ? {
                onAuthURL: (name: string, url: string) => {
                  if (!disposed && !staleOrDisabled()) {
                    callbacks.onStatus({ name, state: "needs-auth", url });
                  }
                },
              }
            : {}),
          // Mid-session re-auth fires needs-auth again with no later connected
          // event; re-emit connected only when tools are already registered so
          // first-connect still waits for the real post-connect status.
          onAuthorized: (name) => {
            if (disposed || staleOrDisabled()) return;
            const client = connectedClients.get(name);
            if (client === undefined) return;
            callbacks.onStatus({
              name,
              state: "connected",
              tools: client.tools.map((t) => t.name),
            });
          },
          signal: connectionSignal,
          onDisconnect: () =>
            handleTransportDeath(config, callbacks, ownedEpoch),
        });
      } catch (err) {
        if (staleOrDisabled()) return;
        const error = errorMessage(err);
        if (isBuiltinExaMCPServer(config)) {
          resolveBuiltinExaConnection?.({
            ok: false,
            serverName: config.name,
            error,
          });
        }
        if (!disposed)
          callbacks.onStatus({
            name: config.name,
            state: "failed",
            error,
            ...(err instanceof BrowserAuthPendingError
              ? { authPending: true }
              : {}),
          });
        return;
      }
      if (disposed) {
        if (result.ok) await result.client.close().catch(() => undefined);
        if (isBuiltinExaMCPServer(config)) {
          resolveBuiltinExaConnection?.({
            ok: false,
            serverName: config.name,
            error: "MCP toolset disposed during connection",
          });
        }
        return;
      }
      if (staleOrDisabled()) {
        if (result.ok) await result.client.close().catch(() => undefined);
        return;
      }
      if (!result.ok) {
        if (isBuiltinExaMCPServer(config))
          resolveBuiltinExaConnection?.(result);
        callbacks.onStatus({
          name: config.name,
          state: "failed",
          error: result.error,
          ...(result.authPending === true ? { authPending: true } : {}),
        });
        return;
      }

      try {
        if (staleOrDisabled()) {
          await result.client.close().catch(() => undefined);
          return;
        }
        permissionGate.registerMcpClient(result.client);
        const mcpTools = mcpClientTools(result.client, {
          ...(getBlobWriter !== undefined ? { getBlobWriter } : {}),
          ...(getContextDir !== undefined ? { getContextDir } : {}),
          ...(getEvidenceArchive !== undefined ? { getEvidenceArchive } : {}),
          ...(isBuiltinExaMCPServer(config)
            ? { excludeToolNames: ["web_fetch_exa"] }
            : {}),
        });
        // Clear the stubs a needs-auth pend re-mounted mid-dial so the live
        // set mounts without a DuplicateToolError.
        dropServerTools(config.name);
        dynamicRunner.addTools(gateAgentTools(mcpTools, permissionGate));
        inheritedMcpTools.push(...mcpTools);
        connectedClients.set(config.name, result.client);
      } catch (err) {
        permissionGate.unregisterMcpServer(config.name);
        await result.client.close().catch(() => undefined);
        if (staleOrDisabled()) return;
        const error = errorMessage(err);
        if (isBuiltinExaMCPServer(config)) {
          resolveBuiltinExaConnection?.({
            ok: false,
            serverName: config.name,
            error,
          });
        }
        callbacks.onStatus({ name: config.name, state: "failed", error });
        return;
      }

      if (staleOrDisabled()) {
        await dropLiveClient(config.name);
        return;
      }

      if (isBuiltinExaMCPServer(config)) resolveBuiltinExaConnection?.(result);
      callbacks.onStatus({
        name: config.name,
        state: "connected",
        tools: result.client.tools.map((t) => t.name),
      });
      callbacks.onToolsChanged(dynamicRunner.currentDefinitions());
    })().finally(() => forwarded?.disarm());
    inFlightConnections.set(config.name, run);
    inFlightEpochs.set(config.name, ownedEpoch);
    const clearInFlight = (): void => {
      if (inFlightConnections.get(config.name) === run) {
        inFlightConnections.delete(config.name);
        inFlightEpochs.delete(config.name);
      }
    };
    void run.then(clearInFlight, clearInFlight);
    return run;
  };

  const abortServer = (name: string): void => {
    const existing = serverAborts.get(name);
    if (existing !== undefined) {
      existing.abort();
      return;
    }
    const controller = new AbortController();
    controller.abort();
    serverAborts.set(name, controller);
  };

  const publicConnectMCPServer = (
    config: MCPServerConfig,
    callbacks: MCPConnectCallbacks,
    signal?: AbortSignal,
  ): Promise<void> => {
    const reenable = disabledNames.has(config.name);
    const epochAtCall = currentEpoch(config.name);
    return enqueueServerOp(config.name, async () => {
      // A later disconnect (or re-enable) owns this name now.
      if (currentEpoch(config.name) !== epochAtCall) return;
      if (disabledNames.has(config.name) && !reenable) return;
      const remountAliasIfNeeded = (): void => {
        if (
          isBuiltinExaMCPServer(config) &&
          !connectedClients.has(config.name) &&
          !inFlightConnections.has(config.name)
        ) {
          remountBuiltinExaAlias();
          builtinExaEnabled = true;
        }
      };
      if (reenable) {
        disabledNames.delete(config.name);
        const epoch = bumpEpoch(config.name);
        serverAborts.set(config.name, new AbortController());
        remountAliasIfNeeded();
        await connectOneMCPServer(config, callbacks, signal, epoch);
        return;
      }
      if (!serverAborts.has(config.name)) {
        serverAborts.set(config.name, new AbortController());
      }
      remountAliasIfNeeded();
      await connectOneMCPServer(
        config,
        callbacks,
        signal,
        currentEpoch(config.name),
      );
    });
  };

  const publicDisconnectMCPServer = (
    name: string,
    callbacks: MCPConnectCallbacks,
  ): Promise<void> => {
    disabledNames.add(name);
    const epoch = bumpEpoch(name);
    abortServer(name);
    return enqueueServerOp(name, async () => {
      const inFlight = inFlightConnections.get(name);
      if (inFlight !== undefined) await inFlight;
      // Always drop the aborted live client so a queued reconnect cannot no-op
      // on connectedClients.has(name). Skip the Exa swap and disconnected emit
      // only when a newer generation owns the name.
      await dropLiveClient(name);
      if (currentEpoch(name) !== epoch || !disabledNames.has(name)) return;
      if (builtinExaEnabled && name === EXA_MCP_SERVER_NAME) {
        swapBuiltinExaToNative();
      }
      callbacks.onStatus({ name, state: "disconnected" });
      callbacks.onToolsChanged(dynamicRunner.currentDefinitions());
    });
  };

  const publicRetryMCPServer = (
    config: MCPServerConfig,
    callbacks: MCPConnectCallbacks,
    signal?: AbortSignal,
  ): Promise<void> => {
    if (
      connectedClients.has(config.name) &&
      !reconnectingServers.has(config.name)
    ) {
      return Promise.resolve();
    }
    return enqueueServerOp(config.name, async () => {
      if (
        connectedClients.has(config.name) &&
        !reconnectingServers.has(config.name)
      ) {
        return;
      }
      // Cancel any backoff loop and stale dial so exactly one dial runs.
      const epoch = bumpEpoch(config.name);
      abortServer(config.name);
      serverAborts.set(config.name, new AbortController());
      reconnectingServers.delete(config.name);
      disabledNames.delete(config.name);
      // Drop the fail-fast stubs so the single dial can mount the live set
      // without a DuplicateToolError. A failed retry leaves the row failed
      // with no tools, like a fresh connect — no backoff resumes.
      dropServerTools(config.name);
      await connectOneMCPServer(config, callbacks, signal, epoch);
    });
  };

  const connectMCP = async (
    callbacks: MCPConnectCallbacks,
    signal?: AbortSignal,
  ): Promise<void> => {
    if (disposed) return;
    const toConnect = await filterServersForConnect(mcpServers);
    if (disposed) return;
    await Promise.all(
      toConnect.map((config) => connectOneMCPServer(config, callbacks, signal)),
    );
    if (disposed) return;
    // Report untrusted local servers as failed (fail closed) so the UI is honest.
    if (mcpServersSource === "local") {
      const connectedNames = new Set(toConnect.map((s) => s.name));
      for (const server of mcpServers) {
        if (!connectedNames.has(server.name)) {
          callbacks.onStatus({
            name: server.name,
            state: "failed",
            error: untrustedLocalError,
          });
        }
      }
    }
  };

  const dispose = (): Promise<void> => {
    if (disposal !== undefined) return disposal;
    disposed = true;
    mcpAbortController.abort(new Error("MCP toolset disposed"));
    disposal = (async () => {
      const failures: unknown[] = [];
      // Kill live background process groups before the posix teardown so
      // reload/interrupt cannot leave orphans behind.
      backgroundShells.disposeAll("session closed");
      try {
        await posixTools.dispose();
      } catch (err: unknown) {
        failures.push(err);
      }
      const fleetSessions = fleetSessionsForDispose;
      if (fleetSessions !== undefined) {
        try {
          await fleetSessions.cancelAll("parent session closed");
        } catch (err: unknown) {
          failures.push(err);
        }
        for (const session of [...fleetSessions.list()].reverse()) {
          try {
            await fleetSessions.closeOne(session.id, DEFAULT_CLOSE_DEADLINE_MS);
          } catch (err: unknown) {
            failures.push(err);
          }
        }
      }
      await Promise.allSettled([...inFlightConnections.values()]);
      for (const client of connectedClients.values()) {
        permissionGate.unregisterMcpServer(client.serverName);
      }
      await Promise.all(
        [...connectedClients.values()].map((client) =>
          client.close().catch(() => undefined),
        ),
      );
      connectedClients.clear();
      await disposeWebSearchClients();
      rethrowToolsetDisposeFailures(failures);
    })();
    return disposal;
  };

  return {
    dynamicRunner,
    connectMCP,
    shellOutputFeed,
    connectMCPServer: publicConnectMCPServer,
    disconnectMCPServer: publicDisconnectMCPServer,
    retryMCPServer: publicRetryMCPServer,
    hasMCPServer: (name) =>
      connectedClients.has(name) ||
      inFlightConnections.has(name) ||
      reconnectingServers.has(name),
    awaitPendingMcpConnections,
    setMcpServersSource: (source) => {
      mcpServersSource = source;
    },
    setToolPromoter: (promote) => {
      promoterHolder.current = promote;
      dynamicRunner.setOnUndeclaredCall((name) => promote([name]));
    },
    skills,
    ...(fleetRecords !== undefined ? { fleetRecords } : {}),
    dispose,
  };
}
