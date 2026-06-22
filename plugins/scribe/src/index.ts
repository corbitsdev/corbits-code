import type { CommandPlugin } from "../../../src/tui/commands/registry.js";

export const commandPlugin: CommandPlugin = {
  commands: [
    {
      name: "scribe",
      description: "Run the scribe documentation skill on the given topic or input",
      handler: (args, _ctx) => {
        const target = args.trim();
        const text = target.length > 0
          ? `Apply the scribe skill to: ${target}`
          : "Apply the scribe skill to the current task context.";
        return { type: "skill", skill: "gaas:scribe", text };
      },
    },
  ],
};