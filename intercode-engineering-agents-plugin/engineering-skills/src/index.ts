// Deprecated: the engineering bundle is agent-kind only. Enable `engineering-agents`
// instead. This module remains so old pluginPaths entries do not break import.

export const manifest = {
  id: "engineering-skills",
  name: "Engineering team skills (deprecated)",
  kind: "command" as const,
  description: "No longer used — install engineering-agents for spawnable sub-agent profiles only.",
};

export const commandPlugin = {
  commands: [] as { name: string; description: string; handler: (args: string) => unknown }[],
};