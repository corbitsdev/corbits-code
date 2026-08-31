export const SPAWN_AGENT_TOOL_NAME = "spawn_agent";

const SUBAGENT_TOOL_NAMES = new Set<string>([SPAWN_AGENT_TOOL_NAME]);

export function isSubagentToolName(toolName: string): boolean {
  return SUBAGENT_TOOL_NAMES.has(toolName);
}
