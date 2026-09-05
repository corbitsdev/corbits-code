import { stringTool } from "@intx/agent";
import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import { type } from "arktype";

import { resolveSkillBody } from "../extensions/skills.js";
import { NOOP_TELEMETRY, type Telemetry } from "../telemetry/index.js";

// Lazy skill loading: names are listed in the system prompt; details come from
// skill_search; this tool pulls the full instructions into context when the
// model decides one applies. There is no operator invocation — discovery and
// loading are entirely model-driven.
const useSkillDefinition: ToolDefinition = {
  name: "use_skill",
  description:
    "Load the full instructions for a skill. Names are listed under 'Skills' in the system prompt; call skill_search for descriptions, then this tool with the skill's name to load the body. The returned instructions stay in effect for the rest of the task.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "The skill name to load, as listed under Skills" },
    },
    required: ["name"],
  },
};

const UseSkillArgs = type({ name: "string" });

export function createUseSkillTool(
  cwd: string,
  skillDirs: string[] = [],
  telemetry: Telemetry = NOOP_TELEMETRY,
  allowedNames?: readonly string[],
): AgentTool {
  const allowed = allowedNames === undefined ? undefined : new Set(allowedNames);
  return stringTool({
    definition: useSkillDefinition,
    handler: async (rawArgs: Record<string, unknown>): Promise<string> => {
      const parsed = UseSkillArgs(rawArgs);
      if (parsed instanceof type.errors) return "Error: use_skill requires name (string).";
      const name = parsed.name.trim();
      if (name.length === 0) return "Error: use_skill requires a non-empty name.";
      if (allowed !== undefined && !allowed.has(name)) {
        return `No skill named "${name}" is available.`;
      }
      const body = await resolveSkillBody(cwd, name, skillDirs);
      if (body === undefined) return `No skill named "${name}" is available.`;
      // Skills are project- or plugin-authored, so the name is as identifying
      // as any other user-written string and never leaves the process; the
      // event records only that a skill was loaded.
      telemetry.capture("skill_used");
      return `Skill "${name}" — follow these instructions for this task:\n\n${body}`;
    },
  });
}
