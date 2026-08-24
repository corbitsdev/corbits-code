import { fromToolRunner, stringTool } from "@intx/agent";
import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import { type } from "arktype";
import { createPosixTools, type ToolPlugin } from "@intx/tools-posix";
import {
  advanceWorkflowDefinition,
  askOperatorDefinition,
  presentDefinition,
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
import { connectMCPServer, type MCPClient } from "../mcp/client.js";
import { mcpClientToAgentTools } from "../mcp/plugin.js";
import { createDynamicToolRunner, type DynamicToolRunner } from "../tui/dynamic-tool-runner.js";
import type { MCPServerConfig, Settings } from "../config/settings.js";
import { filterMcpServersForConnect, type ProjectTrustStore } from "../trust/project-trust.js";
import type { ToolWatchdogConfig } from "../tui/tool-execution-watchdog.js";
import type { SessionMode } from "../config/session-mode.js";
import { sessionModeEnablesSubAgents } from "../config/session-mode.js";
import { advertisedToolNamesForSessionMode, type ToolAvailability } from "./tool-search.js";
import type { ProviderCatalogEntry } from "../config/index.js";
import type { AgentProfile } from "./profiles.js";
import {
  createTaskTool,
  runSubAgent,
  type SubAgentProvider,
  type SubAgentSessionStore,
} from "../subagent/index.js";
import { parseManageTasksArgs } from "./tasks.js";
import { createListDirTool } from "../util/list-dir.js";
import { createWebFetchTool } from "../tools/web-fetch.js";
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
  "command?": "string",
});

const AdvanceWorkflowArgs = type({
  "note?": "string",
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
  // Per-project settings.env, merged into the run_shell tool's spawn environment.
  shellEnv?: Record<string, string>;
  // Whether a workflow is currently running. advance_workflow rides the wire
  // every turn (workflow or not), so the model can call it with nothing active;
  // this lets its handler report an honest no-op instead of a false advance.
  isWorkflowActive?: () => boolean;
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
  // When provided, the agent gets a `task` tool that delegates to autonomous
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
  | { name: string; state: "failed"; error: string };

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
    mcpServers = [],
    mcpServersSource = "none",
    projectTrust,
    requestMcpTrust,
    extraToolPlugins = [],
    skillDirs = [],
    shellTimeout,
    toolWatchdog,
    getBlobReader,
    getBlobWriter,
    sessionMode = "orchestrator",
    shellEnv,
    toolAvailability = { languageServerAvailable: true },
  } = args;
  const sessionBlobReader =
    getBlobReader !== undefined ? createLazyBlobReader(getBlobReader) : undefined;
  const subAgentsEnabled = sessionModeEnablesSubAgents(sessionMode);
  const advertisedBuiltIns = advertisedToolNamesForSessionMode(sessionMode, toolAvailability);

  const inheritedMcpTools: AgentTool[] = [];

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
    createWebFetchTool(),
    createWebSearchTool(),
    ...(subAgentsEnabled && args.subAgent !== undefined
      ? [
          createTaskTool({
            cwd,
            getWorkdirBase: args.subAgent.getWorkdirBase,
            provider: args.subAgent.provider,
            permissionGate,
            inheritMcpTools: () => inheritedMcpTools,
            run: runSubAgent,
            ...(shellTimeout !== undefined ? { shellTimeout } : {}),
            ...(shellEnv !== undefined ? { shellEnv } : {}),
            ...(extraToolPlugins.length > 0 ? { extraToolPlugins } : {}),
            ...(args.subAgent.onEvent !== undefined ? { onEvent: args.subAgent.onEvent } : {}),
            ...(args.subAgent.onProgress !== undefined
              ? { onProgress: args.subAgent.onProgress }
              : {}),
            ...(args.subAgent.sessions !== undefined ? { sessions: args.subAgent.sessions } : {}),
            ...(args.subAgent.settings !== undefined ? { settings: args.subAgent.settings } : {}),
            ...(args.subAgent.catalog !== undefined ? { catalog: args.subAgent.catalog } : {}),
            ...(args.subAgent.profiles !== undefined ? { profiles: args.subAgent.profiles } : {}),
            ...(args.getBlobReader !== undefined ? { getBlobReader: args.getBlobReader } : {}),
            ...(args.subAgent.useWorktree !== undefined
              ? { useWorktree: args.subAgent.useWorktree }
              : {}),
            ...(args.telemetry !== undefined ? { telemetry: args.telemetry } : {}),
          }),
          ...(args.subAgent.profiles !== undefined
            ? [
                createSearchAgentsTool(() => {
                  const profiles = args.subAgent!.profiles;
                  return typeof profiles === "function" ? profiles() : (profiles ?? []);
                }),
              ]
            : []),
          // Tier 1: the primary session is always an orchestrator and may
          // target any worker (assertCanTargetAgent's rule), so no authority
          // context is passed here — omitting it is treated as unrestricted,
          // matching Tier 1's actual authority.
          createReadAgentTraceTool(args.subAgent.getWorkdirBase),
        ]
      : []),
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
        const { question, options, command } = parsed;
        if (options.length === 0) {
          return "Error: ask_operator requires at least one option.";
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
        const chosen = options[index]!;
        // The operator just approved this exact answer by selecting it. The model
        // declares the command it's really asking about via `command`, so the
        // follow-up run_shell call for that exact string does not prompt again.
        if (command !== undefined) permissionGate.preApprove("run_shell", command);
        return chosen;
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
      definition: advanceWorkflowDefinition,
      // The director observes this call and advances the workflow runtime; the
      // handler only needs to acknowledge so the model gets a clean tool result.
      // Since the tool is always advertised, the model can call it with no
      // workflow active — report the honest no-op rather than a false advance.
      handler: async (rawArgs: Record<string, unknown>): Promise<string> => {
        if (args.isWorkflowActive?.() === false) {
          return "No active workflow — nothing to advance.";
        }
        const parsed = AdvanceWorkflowArgs(rawArgs);
        if (parsed instanceof type.errors) {
          return "Acknowledged.";
        }
        const note = parsed.note !== undefined ? ` (${parsed.note})` : "";
        return `Workflow step marked complete${note}. Advancing to the next step.`;
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

  const connectedClients: MCPClient[] = [];

  const connectMCP = async (
    callbacks: MCPConnectCallbacks,
    signal?: AbortSignal,
  ): Promise<void> => {
    const toConnect = await filterMcpServersForConnect(mcpServers, {
      source: mcpServersSource,
      store: projectTrust ?? { trustedPluginPaths: [], trustedMcpFingerprints: [] },
      cwd,
      ...(requestMcpTrust !== undefined ? { requestTrust: requestMcpTrust } : {}),
    });
    await Promise.all(
      toConnect.map(async (config) => {
        callbacks.onStatus({ name: config.name, state: "connecting" });
        const result = await connectMCPServer(config, {
          stderr: "ignore",
          ...(callbacks.interactiveAuth
            ? {
                onAuthURL: (name: string, url: string) =>
                  callbacks.onStatus({ name, state: "needs-auth", url }),
              }
            : {}),
          // Mid-session re-auth fires needs-auth again without a later connected
          // event. Re-emit connected only when tools are already registered so
          // first-connect still waits for the real post-connect status.
          onAuthorized: (name) => {
            const client = connectedClients.find((c) => c.serverName === name);
            if (client === undefined) return;
            callbacks.onStatus({
              name,
              state: "connected",
              tools: client.tools.map((t) => t.name),
            });
          },
          ...(signal !== undefined ? { signal } : {}),
        });
        if (!result.ok) {
          callbacks.onStatus({ name: config.name, state: "failed", error: result.error });
          return;
        }
        connectedClients.push(result.client);
        permissionGate.registerMcpClient(result.client);
        const mcpTools = mcpClientToAgentTools(result.client, permissionGate, getBlobWriter);
        inheritedMcpTools.push(...mcpTools);
        dynamicRunner.addTools(mcpTools);
        callbacks.onStatus({
          name: config.name,
          state: "connected",
          tools: result.client.tools.map((t) => t.name),
        });
        callbacks.onToolsChanged(dynamicRunner.currentDefinitions());
      }),
    );
    // Report untrusted local servers as failed (fail closed) so the UI is honest.
    if (mcpServersSource === "local") {
      const connectedNames = new Set(toConnect.map((s) => s.name));
      for (const server of mcpServers) {
        if (!connectedNames.has(server.name)) {
          callbacks.onStatus({
            name: server.name,
            state: "failed",
            error: `Not trusted for this project (see ${SETTINGS_DIR_NAME}/trust.json)`,
          });
        }
      }
    }
  };

  return {
    dynamicRunner,
    connectMCP,
    setToolPromoter: (promote) => {
      promoter.promote = promote;
    },
    dispose: async () => {
      for (const client of connectedClients) {
        permissionGate.unregisterMcpServer(client.serverName);
      }
      await Promise.all(connectedClients.map((c) => c.close().catch(() => undefined)));
      await posixTools.dispose();
      await disposeWebSearchClients();
    },
  };
}
