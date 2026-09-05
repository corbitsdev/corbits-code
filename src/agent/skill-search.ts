import { stringTool } from "@intx/agent";
import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import { type } from "arktype";

import type { SkillSummary } from "../extensions/skills.js";

// Catalog lookup for skills. Names live in the system prompt; this tool returns
// matching name + description so the model can choose. Bodies load via use_skill.
// Directly callable and advertised on primary — do not send the model through
// tool_search to find it.
export const skillSearchDefinition: ToolDefinition = {
  name: "skill_search",
  description:
    "Look up skill details by capability. Skill names are listed in the system prompt; call this for descriptions, then use_skill to load a body. Directly callable — do not tool_search for this.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Keywords describing the capability you need.",
      },
    },
    required: ["query"],
  },
};

export interface CreateSkillSearchToolArgs {
  skills: readonly SkillSummary[];
  // When omitted, every snapshot skill is searchable. When set, the visible
  // set is the intersection with `skills` — a declared name that is not in
  // the snapshot cannot appear (the allowlist cannot widen).
  allowedNames?: readonly string[];
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function visibleSkills(
  skills: readonly SkillSummary[],
  allowedNames: readonly string[] | undefined,
): readonly SkillSummary[] {
  if (allowedNames === undefined) return skills;
  const allowed = new Set(allowedNames);
  return skills.filter((skill) => allowed.has(skill.name));
}

function scoreSkill(skill: SkillSummary, queryTokens: string[], rawQuery: string): number {
  const nameTokens = tokenize(skill.name);
  const descTokens = new Set(tokenize(skill.description));
  let total = 0;
  for (const token of queryTokens) {
    if (nameTokens.includes(token)) total += 3;
    else if (descTokens.has(token)) total += 1;
    else if (skill.name.toLowerCase().includes(token)) total += 0.75;
    else if (skill.description.toLowerCase().includes(token)) total += 0.25;
  }
  if (skill.name.toLowerCase().includes(rawQuery)) total += 1;
  return total;
}

const SkillSearchArgs = type({ query: "string" });

const DEFAULT_LIMIT = 8;

export function createSkillSearchTool(args: CreateSkillSearchToolArgs): AgentTool {
  const catalog = visibleSkills(args.skills, args.allowedNames);
  return stringTool({
    definition: skillSearchDefinition,
    handler: async (rawArgs: Record<string, unknown>): Promise<string> => {
      const parsed = SkillSearchArgs(rawArgs);
      if (parsed instanceof type.errors) {
        return "Error: skill_search requires query (string).";
      }
      const query = parsed.query.trim();
      if (query.length === 0) return "Error: skill_search requires a non-empty query.";
      const rawQuery = query.toLowerCase();
      const queryTokens = tokenize(query);
      if (queryTokens.length === 0) {
        return `No skills matched "${query}". Try different keywords describing the capability.`;
      }
      const matches = catalog
        .map((skill) => ({ skill, score: scoreSkill(skill, queryTokens, rawQuery) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, DEFAULT_LIMIT)
        .map((entry) => entry.skill);
      if (matches.length === 0) {
        return `No skills matched "${query}". Try different keywords describing the capability.`;
      }
      return matches.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n");
    },
  });
}
