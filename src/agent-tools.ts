import { fromToolRunner, stringTool } from "@intx/agent";
import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import { createPosixTools } from "@intx/tools-posix";
import { createLSPPlugin } from "@intx/tools-lsp";
import { askOperatorDefinition } from "./director.js";
import { pathEscapePlugin } from "./plugins/path-escape-plugin.js";
import { authzPlugin } from "./plugins/authz-plugin.js";
import { verifyPlugin } from "./plugins/verify-plugin.js";
import { permissionPlugin } from "./plugins/permission-plugin.js";
import { secretGuardPlugin } from "./plugins/secret-guard-plugin.js";
import { webToolsPlugin } from "./web/plugin.js";
import type { PermissionGate } from "./permission/gate.js";

export type AgentToolsetArgs = {
  cwd: string;
  permissionGate: PermissionGate;
  onOperatorGate: (question: string, options: string[]) => Promise<number>;
};

export type AgentToolset = {
  tools: AgentTool[];
  allDefinitions: ToolDefinition[];
  dispose: () => Promise<void>;
};

export async function createAgentToolset(args: AgentToolsetArgs): Promise<AgentToolset> {
  const { cwd, permissionGate, onOperatorGate } = args;

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

  const posixToolList = fromToolRunner(posixTools);
  const allDefinitions: ToolDefinition[] = [
    ...posixToolList.map((t) => t.definition),
    askOperatorDefinition,
  ];

  const agentTools: AgentTool[] = [
    ...posixToolList,
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
  ];

  return {
    tools: agentTools,
    allDefinitions,
    dispose: () => posixTools.dispose(),
  };
}
