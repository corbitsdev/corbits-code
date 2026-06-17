import { registerCommand } from "./registry.js";

registerCommand({
  name: "scope",
  description: "Scope a feature or task — creates a Linear issue/project or a local scope file",
  handler: (args, _ctx) => ({ type: "workflow", name: "scope", args }),
});

registerCommand({
  name: "scribe",
  description: "Write or update documentation for the given target",
  handler: (args, _ctx) => ({ type: "workflow", name: "scribe", args }),
});

registerCommand({
  name: "build",
  description: "Full implementation workflow: implement, document, and review",
  handler: (args, _ctx) => ({ type: "workflow", name: "build", args }),
});

registerCommand({
  name: "review",
  description: "Multi-agent review cycle: greybeard, CTO, critic, and UI reviewers when applicable",
  handler: (args, _ctx) => ({ type: "workflow", name: "review", args }),
});
