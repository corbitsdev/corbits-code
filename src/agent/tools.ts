import { fromToolRunner, stringTool } from "@intx/agent";
import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import { type } from "arktype";
import { createPosixTools, type ToolPlugin } from "@intx/tools-posix";
import { createLSPPlugin } from "@intx/tools-lsp";
import {
  advanceWorkflowDefinition,
  askOperatorDefinition,
  presentDefinition,
} from "../agent/director.js";
import { manageTasksDefinition } from "./tasks.js";
import { validateView } from "../tui/view/index.js";
import { pathEscapePlugin } from "../plugins/path-escape-plugin.js";
import { authzPlugin } from "../plugins/authz-plugin.js";
import { verifyPlugin } from "../plugins/verify-plugin.js";
import { permissionPlugin } from "../plugins/permission-plugin.js";
import { secretGuardPlugin } from "../plugins/secret-guard-plugin.js";
import { ripgrepPlugin } from "../plugins/ripgrep-plugin.js";
import { toolOutputUriPlugin } from "../plugins/tool-output-uri-plugin.js";
import { lspHintPlugin } from "../plugins/lsp-hint-plugin.js";
import { resultTruncationPlugin } from "../plugins/result-truncation-plugin.js";
import { webToolsPlugin } from "../web/plugin.js";
import type { WebProvider } from "../web/types.js";
import type { PermissionGate } from "../permission/gate.js";
import { connectMCPServer } from "../mcp/client.js";
import { mcpClientToAgentTools } from "../mcp/plugin.js";
import { createDynamicToolRunner, type DynamicToolRunner } from "../tui/dynamic-tool-runner.js";
import type { MCPServerConfig } from "../config/settings.js";
import { createTaskTool, type SubAgentProvider } from "../subagent/index.js";
import { parseManageTasksArgs } from "./tasks.js";
import { createListDirTool } from "../util/list-dir.js";
import { createToolIndex, createToolSearchTool } from "./tool-search.js";
import type { ReactorEmittedEvent } from "@intx/inference";

const AskOperatorArgs = type({
  question: "string",
  options: "string[]",
});

const AdvanceWorkflowArgs = type({
  "note?": "string",
});

// The operator can pick one of the offered options, type a free-form answer, or
// dismiss the question without answering. The gate owns this distinction so the
// tool layer can translate each outcome into the right tool result.
export type OperatorResult =
  | { kind: "option"; index: number }
  | { kind: "custom"; text: string }
  | { kind: "cancel" };

export type AgentToolsetArgs = {
  cwd: string;
  permissionGate: PermissionGate;
  onOperatorGate: (question: string, options: string[]) => Promise<OperatorResult>;
  mcpServers?: MCPServerConfig[];
  // Pre-resolved web provider. When omitted, the built-in local provider is used.
  webProvider?: WebProvider;
  // Pre-resolved tool plugins (enabled + consented kind:"tool" plugins). Their
  // tools are appended to the posix toolset.
  extraToolPlugins?: ToolPlugin[];
  // When provided, the agent gets a `task` tool that delegates to autonomous
  // sub-agents. Omitted in contexts that cannot spawn sub-agents (e.g. tests).
  subAgent?: {
    provider: SubAgentProvider | (() => SubAgentProvider);
    getWorkdirBase: () => string;
    onEvent?: (event: ReactorEmittedEvent) => void;
  };
};

// Per-server connection state surfaced to the TUI.
export type MCPServerState =
  | { name: string; state: "connecting" }
  | { name: string; state: "needs-auth"; url: string }
  | { name: string; state: "connected"; tools: string[] }
  | { name: string; state: "failed"; error: string };

export type MCPConnectCallbacks = {
  // Fired whenever a server's connection state changes.
  onStatus: (state: MCPServerState) => void;
  // Fired after a server connects and its tools are registered, with the new
  // full definition set so the director can advertise it on the next inference.
  onToolsChanged: (definitions: ToolDefinition[]) => void;
};

export type AgentToolset = {
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
};

export async function createAgentToolset(args: AgentToolsetArgs): Promise<AgentToolset> {
  const { cwd, permissionGate, onOperatorGate, mcpServers = [], webProvider, extraToolPlugins = [] } = args;

  const posixTools = createPosixTools({
    cwd,
    plugins: [
      pathEscapePlugin(cwd),
      toolOutputUriPlugin(),
      secretGuardPlugin(),
      authzPlugin(),
      permissionPlugin(permissionGate),
      ripgrepPlugin(cwd),
      verifyPlugin(),
      webToolsPlugin(webProvider !== undefined ? { provider: webProvider } : {}),
      lspHintPlugin(),
      createLSPPlugin({ cwd, minSeverity: 1 }),
      resultTruncationPlugin(),
      // User tool plugins last so their tools cannot shadow the core middleware.
      ...extraToolPlugins,
    ],
  });

  const baseTools: AgentTool[] = [
    ...fromToolRunner(posixTools),
    createListDirTool(cwd),
    ...(args.subAgent !== undefined
      ? [
          createTaskTool({
            cwd,
            getWorkdirBase: args.subAgent.getWorkdirBase,
            provider: args.subAgent.provider,
            ...(args.subAgent.onEvent !== undefined ? { onEvent: args.subAgent.onEvent } : {}),
          }),
        ]
      : []),
    stringTool({
      definition: manageTasksDefinition,
      handler: async (rawArgs: Record<string, unknown>): Promise<string> => {
        const parsed = parseManageTasksArgs(rawArgs);
        if (parsed === null) {
          return "Error: manage_tasks requires action ('create' or 'update').";
        }
        return "Tasks updated.";
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
      definition: advanceWorkflowDefinition,
      // The director observes this call and advances the workflow runtime; the
      // handler only needs to acknowledge so the model gets a clean tool result.
      handler: async (rawArgs: Record<string, unknown>): Promise<string> => {
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
  let runnerRef: DynamicToolRunner | undefined;
  const toolIndex = createToolIndex(() => runnerRef?.currentDefinitions() ?? []);
  baseTools.push(
    createToolSearchTool({
      search: (query) => toolIndex.search(query),
      lookup: (name) => runnerRef?.currentDefinitions().find((d) => d.name === name),
      promote: (names) => promoter.promote(names),
    }),
  );

  const dynamicRunner = createDynamicToolRunner(baseTools);
  runnerRef = dynamicRunner;
  const connectedClients: Array<{ close: () => Promise<void> }> = [];

  const connectMCP = async (callbacks: MCPConnectCallbacks, signal?: AbortSignal): Promise<void> => {
    await Promise.all(
      mcpServers.map(async (config) => {
        callbacks.onStatus({ name: config.name, state: "connecting" });
        const result = await connectMCPServer(config, {
          stderr: "ignore",
          onAuthURL: (name, url) => callbacks.onStatus({ name, state: "needs-auth", url }),
          ...(signal !== undefined ? { signal } : {}),
        });
        if (!result.ok) {
          callbacks.onStatus({ name: config.name, state: "failed", error: result.error });
          return;
        }
        connectedClients.push(result.client);
        dynamicRunner.addTools(mcpClientToAgentTools(result.client, permissionGate));
        callbacks.onStatus({ name: config.name, state: "connected", tools: result.client.tools.map((t) => t.name) });
        callbacks.onToolsChanged(dynamicRunner.currentDefinitions());
      }),
    );
  };

  return {
    dynamicRunner,
    connectMCP,
    setToolPromoter: (promote) => {
      promoter.promote = promote;
    },
    dispose: async () => {
      await Promise.all(connectedClients.map((c) => c.close().catch(() => undefined)));
      await posixTools.dispose();
    },
  };
}
