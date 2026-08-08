import { stringTool } from "@intx/agent";
import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import { type } from "arktype";

import { resolveSkillBody } from "../extensions/skills.js";
import { getTelemetry } from "../telemetry/singleton.js";

// Lazy skill loading: the available skills are listed by name + description in
// the system prompt, but their full instructions are pulled into context only
// when the model decides one applies and calls use_skill. There is no operator
// invocation — discovery and loading are entirely model-driven.
const useSkillDefinition: ToolDefinition = {
  name: "use_skill",
  description:
    "Load the full instructions for one of the available skills (listed under 'Skills' in the system prompt) before doing work it applies to. Pass the skill's name; the returned instructions stay in effect for the rest of the task.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "The skill name to load, as listed under Skills" },
    },
    required: ["name"],
  },
};

const UseSkillArgs = type({ name: "string" });

export function createUseSkillTool(cwd: string, skillDirs: string[] = []): AgentTool {
  return stringTool({
    definition: useSkillDefinition,
    handler: async (rawArgs: Record<string, unknown>): Promise<string> => {
      const parsed = UseSkillArgs(rawArgs);
      if (parsed instanceof type.errors) return "Error: use_skill requires name (string).";
      const name = parsed.name.trim();
      if (name.length === 0) return "Error: use_skill requires a non-empty name.";
      const body = await resolveSkillBody(cwd, name, skillDirs);
      if (body === undefined) return `No skill named "${name}" is available.`;
      // Only send the name once resolved against a real skill — never the
      // raw, unvalidated model-supplied string.
      getTelemetry().capture("skill_used", { skill_name: name });
      return `Skill "${name}" — follow these instructions for this task:\n\n${body}`;
    },
  });
}
