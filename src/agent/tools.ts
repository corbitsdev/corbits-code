import { fromToolRunner, stringTool } from "@intx/agent";
import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import { createPosixTools } from "@intx/tools-posix";
import { createLSPPlugin } from "@intx/tools-lsp";
import {
  advanceWorkflowDefinition,
  askOperatorDefinition,
  presentDefinition,
  suggestWorkflowDefinition,
} from "../agent/director.js";
import { findWorkflow, WORKFLOWS } from "../workflows/index.js";
import { validateView } from "../tui/view/index.js";
import { pathEscapePlugin } from "../plugins/path-escape-plugin.js";
import { authzPlugin } from "../plugins/authz-plugin.js";
import { verifyPlugin } from "../plugins/verify-plugin.js";
import { permissionPlugin } from "../plugins/permission-plugin.js";
import { secretGuardPlugin } from "../plugins/secret-guard-plugin.js";
import { webToolsPlugin } from "../web/plugin.js";
import type { PermissionGate } from "../permission/gate.js";
import { connectMCPServer } from "../mcp/client.js";
import { mcpClientToAgentTools } from "../mcp/plugin.js";
import { createDynamicToolRunner, type DynamicToolRunner } from "../tui/dynamic-tool-runner.js";
import type { MCPServerConfig } from "../config/settings.js";
import { createTaskTool, type SubAgentProvider } from "../subagent/index.js";
import { createListDirTool } from "../util/list-dir.js";
import { createToolIndex, createToolSearchTool } from "./tool-search.js";
import type { ReactorEmittedEvent } from "@intx/inference";

export type AgentToolsetArgs = {
  cwd: string;
  permissionGate: PermissionGate;
  onOperatorGate: (question: string, options: string[]) => Promise<number>;
  // Called when the agent suggests a workflow and the operator approves. The
  // TUI wires this to WorkflowController.start(). Returns false if the name is
  // not found or already active (so the handler can report the failure).
  onWorkflowSuggested?: (name: string) => boolean;
  mcpServers?: MCPServerConfig[];
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
  const { cwd, permissionGate, onOperatorGate, mcpServers = [] } = args;

  const posixTools = createPosixTools({
    cwd,
    plugins: [
      pathEscapePlugin(cwd),
      secretGuardPlugin(),
      authzPlugin(),
      permissionPlugin(permissionGate),
      verifyPlugin(),
      webToolsPlugin(),
      createLSPPlugin({ cwd, minSeverity: 1 }),
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
      definition: askOperatorDefinition,
      handler: async (rawArgs: Record<string, unknown>, _signal: AbortSignal): Promise<string> => {
        const question = typeof rawArgs.question === "string" ? rawArgs.question : "";
        const options = Array.isArray(rawArgs.options) ? rawArgs.options.map(String) : [];
        if (options.length === 0) {
          return "Error: ask_operator requires at least one option.";
        }
        const index = await onOperatorGate(question, options);
        if (index < 0 || index >= options.length) {
          return `Error: invalid selection ${index}. Valid range: 0-${options.length - 1}.`;
        }
        return options[index] as string;
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
      definition: suggestWorkflowDefinition,
      handler: async (rawArgs: Record<string, unknown>): Promise<string> => {
        const name = typeof rawArgs.workflow === "string" ? rawArgs.workflow : "";
        const context = typeof rawArgs.context === "string" ? rawArgs.context : "";
        const reason = typeof rawArgs.reason === "string" ? rawArgs.reason : "";

        const workflow = findWorkflow(name);
        if (workflow === undefined) {
          const available = WORKFLOWS.map((w) => w.name).join(", ");
          return `Error: unknown workflow "${name}". Available: ${available}.`;
        }

        const steps = workflow.steps.map((s, i) => `  ${i + 1}. ${s.label}`).join("\n");
        const contextLine = context.length > 0 ? `\nContext: ${context}` : "";
        const question =
          `Launch workflow: ${name}\n` +
          `Reason: ${reason}${contextLine}\n\n` +
          `Steps:\n${steps}`;

        const index = await onOperatorGate(question, ["Yes, launch it", "No, skip"]);
        if (index !== 0) return "Workflow suggestion declined.";

        const started = args.onWorkflowSuggested?.(name) ?? false;
        if (!started) return `Could not start "${name}": already active or not found.`;
        return `Started ${name} workflow.`;
      },
    }),
    stringTool({
      definition: advanceWorkflowDefinition,
      // The director observes this call and advances the workflow runtime; the
      // handler only needs to acknowledge so the model gets a clean tool result.
      handler: async (rawArgs: Record<string, unknown>): Promise<string> => {
        const note = typeof rawArgs.note === "string" && rawArgs.note.length > 0 ? ` (${rawArgs.note})` : "";
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
