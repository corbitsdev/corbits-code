import { stringTool } from "@intx/agent";
import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import { type } from "arktype";

import { resolveSkillBody } from "../extensions/skills.js";
import { NOOP_TELEMETRY, type Telemetry } from "../telemetry/index.js";
import { captureSkillUsed } from "../telemetry/product-events.js";

// Lazy skill loading: names are listed in the system prompt; details come from
// skill_search; this tool pulls the full instructions into context when the
// model decides one applies. There is no operator invocation — discovery and
// loading are entirely model-driven. Primary copy is on-demand catalog
// (Skywalker has no attached skills). Workers mount workerUseSkillDefinition
// so they do not reload bodies already injected as attached. The handler
// refuses attached names and names already loaded this session so the body
// is never dumped twice.
const USE_SKILL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    name: {
      type: "string",
      description: "The skill name to load, as listed under Skills",
    },
  },
  required: ["name"],
} as const;

export const useSkillDefinition: ToolDefinition = {
  name: "use_skill",
  description:
    "Load the full instructions for a skill. Names are listed under 'Skills' in the system prompt; call skill_search for descriptions, then this tool with the skill's name to load the body. The returned instructions stay in effect for the rest of the task.",
  inputSchema: USE_SKILL_INPUT_SCHEMA,
};

export const workerUseSkillDefinition: ToolDefinition = {
  name: "use_skill",
  description:
    "Load a skill you already know by name (brief or search). Do not reload skills listed as attached or already in context. The returned instructions stay in effect for the rest of the task.",
  inputSchema: USE_SKILL_INPUT_SCHEMA,
};

const UseSkillArgs = type({ name: "string" });

function alreadyInContextMessage(name: string): string {
  return `Skill "${name}" is already attached / already in context.`;
}

export function createUseSkillTool(
  cwd: string,
  skillDirs: string[] = [],
  telemetry: Telemetry = NOOP_TELEMETRY,
  allowedNames?: readonly string[],
  definition: ToolDefinition = useSkillDefinition,
  attachedNames?: readonly string[],
): AgentTool {
  const allowed =
    allowedNames === undefined ? undefined : new Set(allowedNames);
  const loaded = new Set(attachedNames ?? []);
  return stringTool({
    definition,
    handler: async (rawArgs: Record<string, unknown>): Promise<string> => {
      const parsed = UseSkillArgs(rawArgs);
      if (parsed instanceof type.errors)
        return "Error: use_skill requires name (string).";
      const name = parsed.name.trim();
      if (name.length === 0)
        return "Error: use_skill requires a non-empty name.";
      if (allowed !== undefined && !allowed.has(name)) {
        return `No skill named "${name}" is available.`;
      }
      if (loaded.has(name)) return alreadyInContextMessage(name);
      const body = await resolveSkillBody(cwd, name, skillDirs);
      if (body === undefined) return `No skill named "${name}" is available.`;
      // Skill names are project- or plugin-authored, so an unrecognised
      // name never leaves the process: first-party `corbits-skills` names
      // are reported by name, everything else as `custom`.
      captureSkillUsed(telemetry, name);
      loaded.add(name);
      return `Skill "${name}" — follow these instructions for this task:\n\n${body}`;
    },
  });
}
