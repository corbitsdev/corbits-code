import { loadAgentRole } from "./load-prompt.js";

export const manifest = {
  id: "engineering-agents",
  name: "Engineering agents",
  kind: "agent" as const,
  description:
    "Engineering agent team from corbitsdev/examples engineering-agent-team (agents + skills, spawnable via task).",
};

const NECKBEARD_TOOLS = ["read_file", "search_files", "grep", "list_dir"] as const;

export const agentPlugin = {
  agents: [
    {
      id: "karen",
      description:
        "Project manager — orchestrates via dispatch/interview skills; delegates implementation (upstream primary, task sub-agent in Intercode)",
      tier: "clever" as const,
      systemPromptRole: loadAgentRole("karen.md", ["dispatch", "interview"]),
    },
    {
      id: "greybeard",
      description:
        "Seasoned architect — reviews design, constraint ownership, and backwards compatibility",
      tier: "clever" as const,
      systemPromptRole: loadAgentRole("greybeard.md", ["style", "philosophy"]),
    },
    {
      id: "critique",
      description: "Code quality reviewer — tests assumptions, edge cases, security smells",
      tier: "standard" as const,
      systemPromptRole: loadAgentRole("critique.md", ["style", "philosophy"]),
    },
    {
      id: "intern",
      description: "Mechanical executor — runs builds/tests exactly as told; stops when ambiguous",
      tier: "fast" as const,
      systemPromptRole: loadAgentRole("intern.md"),
    },
    {
      id: "neckbeard",
      description: "Read-only pedantic reviewer — nitpicks; no shell or file writes",
      tier: "standard" as const,
      capabilities: {
        mode: "allow" as const,
        tools: [...NECKBEARD_TOOLS],
      },
      systemPromptRole: loadAgentRole("neckbeard.md", ["style", "philosophy"]),
    },
  ],
};