import { fromToolRunner, stringTool } from "@intx/agent";
import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import { type } from "arktype";
import { createPosixTools, type ToolPlugin } from "@intx/tools-posix";
import {
  askOperatorDefinition,
  presentDefinition,
  submitOutputDefinition,
} from "../agent/director.js";
import { manageTasksDefinition } from "./tasks.js";
import { validateView } from "../tui/view/index.js";
import { SETTINGS_DIR_NAME } from "../branding.js";
import {
  advertiseShellGuardTimeout,
  type ShellTimeoutConfig,
} from "../plugins/shell-guard-plugin.js";
import { advertiseEditFileLineRange } from "../plugins/edit-file-line-range.js";
import type { Telemetry } from "../telemetry/index.js";
import type { PermissionGate } from "../permission/gate.js";
import { buildCorePosixToolPlugins } from "./posix-tool-plugins.js";
import { createLazyBlobReader } from "./lazy-blob-reader.js";
import type { BlobReader } from "@intx/types/runtime";
import type { SpillBlobWriter } from "../plugins/result-truncation-plugin.js";
import {
  connectMCPServer as connectMCPClient,
  type MCPClient,
  type MCPConnectResult,
} from "../mcp/client.js";
import {
  createExaMCPServerConfig,
  EXA_MCP_SERVER_NAME,
  isBuiltinExaMCPServer,
} from "../mcp/exa.js";
import { mcpClientToAgentTools } from "../mcp/plugin.js";
import { parseMcpToolName } from "../mcp/tool-name.js";
import { createDynamicToolRunner, type DynamicToolRunner } from "../tui/dynamic-tool-runner.js";
import type { MCPServerConfig, Settings } from "../config/settings.js";
import {
  filterMcpServersForConnect,
  mcpServerFingerprint,
  type ProjectTrustStore,
} from "../trust/project-trust.js";
import type { ToolWatchdogConfig } from "../tui/tool-execution-watchdog.js";
import type { SessionMode } from "../config/session-mode.js";
import { sessionModeEnablesSubAgents } from "../config/session-mode.js";
import { advertisedToolNamesForSessionMode, type ToolAvailability } from "./tool-search.js";
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
} from "../subagent/agent-fleet.js";
import { DEFAULT_CLOSE_DEADLINE_MS } from "../subagent/dispose.js";
import {
  createCloseAgentTool,
  createResumeAgentTool,
  createInterruptAgentTool,
  createSendInputTool,
} from "../subagent/lifecycle-tools.js";
import { parseManageTasksArgs } from "./tasks.js";
import { createListDirTool } from "../util/list-dir.js";
import { createExaMCPWebFetchTool, createWebFetchTool } from "../tools/web-fetch.js";
import { createWebSearchTool, disposeWebSearchClients } from "../tools/web-search.js";
import { createUseSkillTool } from "./use-skill.js";
import { createToolIndex, createToolSearchTool } from "./tool-search.js";
import { createSearchAgentsTool } from "./agent-search.js";
import { createReadAgentTraceTool } from "../subagent/trace-tool.js";
import {
  createCodexToolProxies,
  type CodexRunManageTasks,
  type CodexRunTool,
} from "./codex-tool-proxies.js";
import { createCodexReadRawFile } from "./codex-read-raw-file.js";
import type { ReactorEmittedEvent } from "@intx/inference";

const AskOperatorArgs = type({
  question: "string",
  options: "string[]",
});

/** Cap on each ask_operator option label (UTF-16 code units). */
export const ASK_OPERATOR_OPTION_MAX_CHARS = 48;

/** Cap on the ask_operator question (UTF-16 code units). */
export const ASK_OPERATOR_QUESTION_MAX_CHARS = 160;

const SubmitOutputArgs = type({
  "summary?": "string",
  "step?": "string",
});

// The operator can pick one of the offered options, type a free-form answer, or
// dismiss the question without answering. The gate owns this distinction so the
// tool layer can translate each outcome into the right tool result.
export type OperatorResult =
  { kind: "option"; index: number } | { kind: "custom"; text: string } | { kind: "cancel" };

export interface AgentToolsetArgs {
  cwd: string;
  permissionGate: PermissionGate;
  onOperatorGate: (question: string, options: string[]) => Promise<OperatorResult>;
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
  // Shell command timeout default/cap, resolved from settings. When omitted the
  // shell-guard plugin arms no default timeout (per-call timeout or settings
  // shell.timeoutMs required to bound a command).
  shellTimeout?: ShellTimeoutConfig;
  // Outer per-invocation tool run budget (dynamic runner). When omitted built-in
  // defaults apply.
  toolWatchdog?: ToolWatchdogConfig;
  // Session blob store for tool-output:// reads; resolved when tools run so agent
  // rebuilds do not require recreating the posix toolset.
  getBlobReader?: () => BlobReader | undefined;
  // Session blob-store writer oversized tool results spill their full,
  // untruncated content into (see result-truncation-plugin.ts) — the same
  // context store getBlobReader reads from, keyed distinctly so the reactor's
  // own downstream size-cap transform never overwrites the spill. Resolved
  // lazily like getBlobReader so a mid-process session rotation spills into
  // the new session's store. Omitted only where there is no session store to
  // write into (tests). Persists with the rest of the session's committed
  // history — no separate cleanup.
  getBlobWriter?: () => SpillBlobWriter | undefined;
  // Absolute session context dir (`…/context`) for the truncation notice's
  // on-disk path. Re-read live like getBlobWriter across session rotation.
  getContextDir?: () => string | undefined;
  // Per-project settings.env, merged into the run_shell tool's spawn environment.
  shellEnv?: Record<string, string>;
  // Whether a workflow is currently running. submit_output rides the wire
  // every turn (workflow or not), so the model can call it with nothing active;
  // this lets its handler report an honest no-op instead of a false advance.
  isWorkflowActive?: () => boolean;
  // Compare-and-advance the live workflow. The handler reports this result
  // instead of reconstructing the cursor; omitted (exec, tests) never claims
  // an advance.
  completeWorkflowStep?: (stepId: string) => WorkflowCompleteResult;
  // Primary session mode (always orchestrator; kept for call-site wiring).
  sessionMode?: SessionMode;
  // Session-start facts gating lsp advertisement. Omitted callers (tests,
  // ad-hoc toolset construction) get it advertised, matching prior behavior.
  // Real sessions always pass their detected values — see tool-search.ts for
  // why these must be fixed for the session's life.
  toolAvailability?: ToolAvailability;
  // Records skill loads and sub-agent dispatch. Omitted (tests, ad-hoc
  // toolsets) means those events are never emitted.
  telemetry?: Telemetry;
  // When provided, the agent gets fleet tools that delegate to autonomous
  // sub-agents. Omitted in contexts that cannot spawn sub-agents (e.g. tests).
  subAgent?: {
    provider: SubAgentProvider | (() => SubAgentProvider);
    getWorkdirBase: () => string;
    onEvent?: (event: ReactorEmittedEvent) => void;
    // Live progress for the TUI status bar / Agents strip. Prefer this over
    // onEvent when the parent transcript must not receive sub-agent text.
    onProgress?: (info: { description: string; toolName: string }) => void;
    // Inspectable child session records for enter-session UI. Not the parent
    // transcript — child events stay in the store only.
    sessions?: SubAgentSessionStore;
    settings?: Settings | (() => Settings | undefined);
    catalog?: readonly ProviderCatalogEntry[] | (() => readonly ProviderCatalogEntry[]);
    profiles?: AgentProfile[] | (() => AgentProfile[]);
    // Opt-in: dispatch each sub-agent into its own git worktree instead of
    // sharing this session's cwd. See src/subagent/worktree.ts.
    useWorktree?: boolean;
  };
  /**
   * When true, mount Codex-only tool proxies (apply_patch, shell, update_plan)
   * into baseTools. Primary then strips apply_patch so DIY stays on
   * write_file/edit_file/delete_file; shell and update_plan stay mounted.
   * Leaves keep apply_patch when their allowlist includes it.
   */
  isCodex?: boolean;
}

// Per-server connection state surfaced to the TUI.
export type MCPServerState =
  | { name: string; state: "connecting" }
  | { name: string; state: "needs-auth"; url: string }
  | { name: string; state: "connected"; tools: string[] }
  | { name: string; state: "failed"; error: string }
  | { name: string; state: "disconnected" };

export interface MCPConnectCallbacks {
  // Headless hosts must not advertise an auth callback they cannot complete.
  // Its presence is how the MCP client decides an OAuth flow is interactive.
  interactiveAuth: boolean;
  // Fired whenever a server's connection state changes.
  onStatus: (state: MCPServerState) => void;
  // Fired after a server connects and its tools are registered, with the new
  // full definition set so the director can advertise it on the next inference.
  onToolsChanged: (definitions: ToolDefinition[]) => void;
}

export interface AgentToolset {
  // The mutable runner the agent dispatches through. Seeded with posix/web/LSP
  // tools; MCP tools are added as servers connect.
  dynamicRunner: DynamicToolRunner;
  // Connect configured MCP servers in the background. Resolves once every server
  // has either connected or failed; authorization waits are bounded by `signal`.
  connectMCP: (callbacks: MCPConnectCallbacks, signal?: AbortSignal) => Promise<void>;
  // Connect one newly persisted server through the same lifecycle as startup MCP.
  connectMCPServer: (
    config: MCPServerConfig,
    callbacks: MCPConnectCallbacks,
    signal?: AbortSignal,
  ) => Promise<void>;
  // Drop a server's tools in the running session. Idempotent for unknown and
  // already-disconnected names. Persist uses hasMCPServer as occupied; this
  // is the live teardown that disable/remove need.
  disconnectMCPServer: (name: string, callbacks: MCPConnectCallbacks) => Promise<void>;
  // True while this name is connected or a connection is in flight — not after
  // teardown, and not after a failed connect. Persist uses this to block a
  // second add of an active name; failed rows retry through connectMCPServer
  // without a second persist. Still true while disable is in progress.
  hasMCPServer: (name: string) => boolean;
  // Catalog unshadow can change local → global/none without rebuilding the
  // toolset; connectOne reads this on every late connect.
  setMcpServersSource: (source: "local" | "global" | "none") => void;
  // Wire the callback the `tool_search` tool invokes to make matched tools
  // advertised. Set by the runner once the director + reload loop exist.
  setToolPromoter: (promote: (names: string[]) => void) => void;
  dispose: () => Promise<void>;
}

export async function createAgentToolset(args: AgentToolsetArgs): Promise<AgentToolset> {
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
    sessionMode = "orchestrator",
    shellEnv,
    toolAvailability = { languageServerAvailable: true },
  } = args;
  let mcpServersSource = args.mcpServersSource ?? "none";
  const sessionBlobReader =
    getBlobReader !== undefined ? createLazyBlobReader(getBlobReader) : undefined;
  const subAgentsEnabled = sessionModeEnablesSubAgents(sessionMode);
  const advertisedBuiltIns = advertisedToolNamesForSessionMode(sessionMode, toolAvailability);
  let builtinExaEnabled = mcpServers.some(isBuiltinExaMCPServer);
  let resolveBuiltinExaConnection: ((result: MCPConnectResult) => void) | undefined;
  let builtinExaConnection: Promise<MCPConnectResult> | undefined = builtinExaEnabled
    ? new Promise<MCPConnectResult>((resolve) => {
        resolveBuiltinExaConnection = resolve;
      })
    : undefined;

  const waitForBuiltinExaConnection = async (signal: AbortSignal): Promise<MCPConnectResult> => {
    const pending = builtinExaConnection;
    if (pending === undefined) {
      return { ok: false, serverName: "exa", error: "built-in Exa MCP is not enabled" };
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
    inheritedMcpTools.push(createExaMCPWebFetchTool({ connect: waitForBuiltinExaConnection }));
  }

  const posixTools = createPosixTools({
    cwd,
    ...(sessionBlobReader !== undefined ? { blobReader: sessionBlobReader } : {}),
    plugins: buildCorePosixToolPlugins({
      cwd,
      permissionGate,
      ...(shellTimeout !== undefined ? { shellTimeout } : {}),
      extraToolPlugins,
      ...(sessionBlobReader !== undefined
        ? { readFileGuard: { blobReader: sessionBlobReader } }
        : {}),
      ...(getBlobWriter !== undefined ? { getBlobWriter } : {}),
      ...(getContextDir !== undefined ? { getContextDir } : {}),
      ...(shellEnv !== undefined ? { shellEnv } : {}),
    }),
  });

  // Codex apply_patch proxy forwards ops through posixTools.run so permission
  // plugins (gate, path policy, etc.) still apply — same call shape as
  // posix-tool-plugins.test.ts.
  const runTool: CodexRunTool = async (name, args) => {
    const result = await posixTools.run(
      { id: "codex-proxy", name, arguments: args },
      new AbortController().signal,
    );
    return {
      content: typeof result.content === "string" ? result.content : JSON.stringify(result.content),
      ...(result.isError === true ? { isError: true } : {}),
    };
  };

  // manage_tasks is not a posix tool — task state is owned by the director,
  // which derives it from the manage_tasks tool_call it observes in the
  // model's own output (see applyManageTasksToolCall in director.ts), not
  // from this handler's return value. This handler only validates, so
  // update_plan's proxy shares it rather than forwarding through posixTools
  // (which has no manage_tasks handler to forward to).
  const runManageTasks: CodexRunManageTasks = async (rawArgs) => {
    const parsed = parseManageTasksArgs(rawArgs);
    if (parsed === null) {
      return {
        content: "Error: manage_tasks requires action ('create' or 'update').",
        isError: true,
      };
    }
    return { content: "Tasks updated." };
  };

  // Align the advertised run_shell timeout with shell-guard (no built-in default;
  // advertise settings.shell.timeoutMs when set).
  // Orchestrator tools (search / trace / fleet) are assembled once so the fleet
  // verbs share one sessions store — never a private mailbox allocated only for
  // spawn_agent/wait_agents.
  const orchestratorTools: AgentTool[] = [];
  let fleetSessionsForDispose: SubAgentSessionStore | undefined;
  if (subAgentsEnabled && args.subAgent !== undefined) {
    const sa = args.subAgent;
    const fleetRecords = sa.sessions !== undefined ? createFleetMailbox(sa.sessions) : undefined;
    if (sa.profiles !== undefined) {
      orchestratorTools.push(
        createSearchAgentsTool(() => {
          const profiles = sa.profiles;
          return typeof profiles === "function" ? profiles() : (profiles ?? []);
        }),
      );
    }
    // Tier 1: the primary session is always an orchestrator and may
    // target any worker (assertCanTargetAgent's rule), so no authority
    // context is passed here — omitting it is treated as unrestricted,
    // matching Tier 1's actual authority.
    orchestratorTools.push(createReadAgentTraceTool(sa.getWorkdirBase));

    // Mirror nested runSubAgent's orchestrator fleet mount (run.ts), but
    // reuse the existing TUI/exec session store — do not allocate a private
    // store only for these verbs. spawnAllowlist stays unwired on primary.
    if (sa.sessions !== undefined && fleetRecords !== undefined) {
      const fleetSessions = sa.sessions;
      fleetSessionsForDispose = fleetSessions;
      const fleetDeps = {
        permissionGate,
        inheritMcpTools: () => inheritedMcpTools,
        ...(shellTimeout !== undefined ? { shellTimeout } : {}),
        ...(shellEnv !== undefined ? { shellEnv } : {}),
        ...(extraToolPlugins.length > 0 ? { extraToolPlugins } : {}),
        cwd,
        getWorkdirBase: sa.getWorkdirBase,
        provider: sa.provider,
        ...(args.getBlobReader !== undefined ? { getBlobReader: args.getBlobReader } : {}),
        run: runSubAgent,
        sessions: fleetSessions,
        fleetRecords,
        ...(sa.useWorktree !== undefined ? { useWorktree: sa.useWorktree } : {}),
        ...(sa.onEvent !== undefined ? { onEvent: sa.onEvent } : {}),
        ...(sa.onProgress !== undefined ? { onProgress: sa.onProgress } : {}),
        ...(sa.settings !== undefined ? { settings: sa.settings } : {}),
        ...(sa.catalog !== undefined ? { catalog: sa.catalog } : {}),
        ...(sa.profiles !== undefined ? { profiles: sa.profiles } : {}),
        ...(args.telemetry !== undefined ? { telemetry: args.telemetry } : {}),
      };
      orchestratorTools.push(
        createSpawnAgentTool(fleetDeps),
        createWaitAgentsTool({ sessions: fleetSessions, fleetRecords }),
        createListAgentsTool({ sessions: fleetSessions, fleetRecords }),
        createCloseAgentTool({ sessions: fleetSessions, fleetRecords }),
        createResumeAgentTool({ sessions: fleetSessions, fleetRecords }),
        createInterruptAgentTool({ sessions: fleetSessions, fleetRecords }),
        createSendInputTool({ sessions: fleetSessions, fleetRecords }),
      );
    }
  }

  const baseTools: AgentTool[] = [
    ...fromToolRunner(posixTools).map((tool) => ({
      ...tool,
      definition: advertiseEditFileLineRange(
        advertiseShellGuardTimeout(tool.definition, shellTimeout?.defaultMs),
      ),
    })),
    createListDirTool(cwd, {
      allowOutside: () => permissionGate.getSkipPermissions(),
    }),
    createUseSkillTool(cwd, skillDirs, args.telemetry),
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
    stringTool({
      definition: askOperatorDefinition,
      handler: async (rawArgs: Record<string, unknown>, _signal: AbortSignal): Promise<string> => {
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
        return options[index]!;
      },
    }),
    stringTool({
      definition: presentDefinition,
      handler: async (rawArgs: Record<string, unknown>): Promise<string> => {
        // The TUI renders the spec from the tool-call arguments; this handler only
        // validates so an invalid spec gives the model an actionable error to fix.
        const result = validateView(rawArgs.view);
        if (result.ok) return "Rendered.";
        return `Invalid view spec at ${result.error}. Fix the spec and call present again.`;
      },
    }),
    stringTool({
      definition: submitOutputDefinition,
      // The director also observes this call on tool.done; complete() is
      // compare-and-advance so a second pass is a no-op. The handler reports
      // complete()'s result so parallel submit_output cannot both claim an
      // advance. Already-complete and not-current ids succeed without
      // claiming one.
      handler: async (rawArgs: Record<string, unknown>): Promise<string> => {
        const parsed = SubmitOutputArgs(rawArgs);
        const step = parsed instanceof type.errors ? undefined : parsed.step;
        const summary = parsed instanceof type.errors ? undefined : parsed.summary;
        const workflowActive = args.isWorkflowActive?.() === true;
        if (workflowActive) {
          if (step === undefined || step.length === 0) {
            return "Error: workflow completion requires a step identifier.";
          }
          const result = args.completeWorkflowStep?.(step) ?? "not-current";
          if (result === "advanced") {
            const note = summary !== undefined && summary.length > 0 ? ` (${summary})` : "";
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

  // tool_search ranks over the live runner (set just below) and promotes matches
  // through a holder the runner wires up once its advertise/reload loop exists.
  const promoter: { promote: (names: string[]) => void } = { promote: () => undefined };
  const runnerHolder: { current?: DynamicToolRunner } = {};
  const toolIndex = createToolIndex(
    () => runnerHolder.current?.currentDefinitions() ?? [],
    advertisedBuiltIns,
  );
  baseTools.push(
    createToolSearchTool({
      search: (query) => toolIndex.search(query),
      lookup: (name) => runnerHolder.current?.currentDefinitions().find((d) => d.name === name),
      promote: (names) => promoter.promote(names),
    }),
  );

  // Codex apply_patch mounts when isCodex; primary strips it so Corbits DIY
  // stays on write_file/edit_file/delete_file. Leaves keep it via BUILD/DOCS allowlists.
  baseTools.push(
    ...createCodexToolProxies({
      isCodex: args.isCodex === true,
      runTool,
      readRawFile: createCodexReadRawFile(cwd, permissionGate),
      runManageTasks,
    }),
  );

  const primaryTools = baseTools.filter((tool) => tool.definition.name !== "apply_patch");

  const dynamicRunner = createDynamicToolRunner(primaryTools, toolWatchdog);
  runnerHolder.current = dynamicRunner;

  const connectedClients = new Map<string, MCPClient>();
  const inFlightConnections = new Map<string, Promise<void>>();
  const inFlightEpochs = new Map<string, number>();
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
  };
  const untrustedLocalError = `Not trusted for this project (see ${SETTINGS_DIR_NAME}/trust.json)`;

  const filterServersForConnect = async (
    servers: MCPServerConfig[],
  ): Promise<MCPServerConfig[]> => {
    const allowed = await filterMcpServersForConnect(servers, {
      source: mcpServersSource,
      store: mcpTrustStore,
      cwd,
      ...(requestMcpTrust !== undefined ? { requestTrust: requestMcpTrust } : {}),
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
      mcpTrustStore = { ...mcpTrustStore, trustedMcpFingerprints: fingerprints };
    }
    return allowed;
  };

  const currentEpoch = (name: string): number => serverEpochs.get(name) ?? 0;

  const bumpEpoch = (name: string): number => {
    const next = currentEpoch(name) + 1;
    serverEpochs.set(name, next);
    return next;
  };

  const enqueueServerOp = (name: string, op: () => Promise<void>): Promise<void> => {
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
    resolveBuiltinExaConnection?.({ ok: false, serverName: EXA_MCP_SERVER_NAME, error });
    resolveBuiltinExaConnection = undefined;
  };

  const replaceInheritedTool = (toolName: string, tool: AgentTool): void => {
    const index = inheritedMcpTools.findIndex((entry) => entry.definition.name === toolName);
    if (index >= 0) inheritedMcpTools.splice(index, 1);
    inheritedMcpTools.push(tool);
  };

  const mountWebFetch = (tool: AgentTool): void => {
    dynamicRunner.removeTools(["web_fetch"]);
    dynamicRunner.addTools([tool]);
    replaceInheritedTool("web_fetch", tool);
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
    mountWebFetch(createExaMCPWebFetchTool({ connect: waitForBuiltinExaConnection }));
  };

  const dropServerTools = (name: string): void => {
    const names = dynamicRunner
      .currentDefinitions()
      .map((definition) => definition.name)
      .filter((toolName) => parseMcpToolName(toolName)?.server === name);
    dynamicRunner.removeTools(names);
    for (let i = inheritedMcpTools.length - 1; i >= 0; i--) {
      const entry = inheritedMcpTools[i];
      if (entry !== undefined && parseMcpToolName(entry.definition.name)?.server === name) {
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
    if (existing !== undefined && inFlightEpochs.get(config.name) === ownedEpoch) {
      return existing;
    }
    let perServer = serverAborts.get(config.name);
    if (perServer === undefined) {
      perServer = new AbortController();
      serverAborts.set(config.name, perServer);
    }
    const connectionSignal =
      signal === undefined
        ? AbortSignal.any([mcpAbortController.signal, perServer.signal])
        : AbortSignal.any([mcpAbortController.signal, perServer.signal, signal]);

    const staleOrDisabled = (): boolean =>
      disabledNames.has(config.name) || currentEpoch(config.name) !== ownedEpoch;

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
          // Mid-session re-auth fires needs-auth again without a later connected
          // event. Re-emit connected only when tools are already registered so
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
        });
      } catch (err) {
        if (staleOrDisabled()) return;
        const error = err instanceof Error ? err.message : String(err);
        if (isBuiltinExaMCPServer(config)) {
          resolveBuiltinExaConnection?.({ ok: false, serverName: config.name, error });
        }
        if (!disposed) callbacks.onStatus({ name: config.name, state: "failed", error });
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
        if (isBuiltinExaMCPServer(config)) resolveBuiltinExaConnection?.(result);
        callbacks.onStatus({ name: config.name, state: "failed", error: result.error });
        return;
      }

      try {
        if (staleOrDisabled()) {
          await result.client.close().catch(() => undefined);
          return;
        }
        permissionGate.registerMcpClient(result.client);
        const mcpTools = mcpClientToAgentTools(result.client, permissionGate, {
          ...(getBlobWriter !== undefined ? { getBlobWriter } : {}),
          ...(getContextDir !== undefined ? { getContextDir } : {}),
          ...(isBuiltinExaMCPServer(config) ? { excludeToolNames: ["web_fetch_exa"] } : {}),
        });
        dynamicRunner.addTools(mcpTools);
        inheritedMcpTools.push(...mcpTools);
        connectedClients.set(config.name, result.client);
      } catch (err) {
        permissionGate.unregisterMcpServer(config.name);
        await result.client.close().catch(() => undefined);
        if (staleOrDisabled()) return;
        const error = err instanceof Error ? err.message : String(err);
        if (isBuiltinExaMCPServer(config)) {
          resolveBuiltinExaConnection?.({ ok: false, serverName: config.name, error });
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
    })();
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
      await connectOneMCPServer(config, callbacks, signal, currentEpoch(config.name));
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
      // on connectedClients.has(name). Skip Exa-native swap and disconnected
      // emit only when a newer generation owns the name.
      await dropLiveClient(name);
      if (currentEpoch(name) !== epoch || !disabledNames.has(name)) return;
      if (builtinExaEnabled && name === EXA_MCP_SERVER_NAME) {
        swapBuiltinExaToNative();
      }
      callbacks.onStatus({ name, state: "disconnected" });
      callbacks.onToolsChanged(dynamicRunner.currentDefinitions());
    });
  };

  const connectMCP = async (
    callbacks: MCPConnectCallbacks,
    signal?: AbortSignal,
  ): Promise<void> => {
    if (disposed) return;
    const toConnect = await filterServersForConnect(mcpServers);
    if (disposed) return;
    await Promise.all(toConnect.map((config) => connectOneMCPServer(config, callbacks, signal)));
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
      const fleetSessions = fleetSessionsForDispose;
      if (fleetSessions !== undefined) {
        fleetSessions.cancelAll("parent session closed");
        for (const session of [...fleetSessions.list()].reverse()) {
          await fleetSessions.closeOne(session.id, DEFAULT_CLOSE_DEADLINE_MS);
        }
      }
      await Promise.allSettled([...inFlightConnections.values()]);
      for (const client of connectedClients.values()) {
        permissionGate.unregisterMcpServer(client.serverName);
      }
      await Promise.all(
        [...connectedClients.values()].map((client) => client.close().catch(() => undefined)),
      );
      connectedClients.clear();
      await posixTools.dispose();
      await disposeWebSearchClients();
    })();
    return disposal;
  };

  return {
    dynamicRunner,
    connectMCP,
    connectMCPServer: publicConnectMCPServer,
    disconnectMCPServer: publicDisconnectMCPServer,
    hasMCPServer: (name) => connectedClients.has(name) || inFlightConnections.has(name),
    setMcpServersSource: (source) => {
      mcpServersSource = source;
    },
    setToolPromoter: (promote) => {
      promoter.promote = promote;
    },
    dispose,
  };
}
