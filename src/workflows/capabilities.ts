import type { ToolDefinition } from "@intx/types/runtime";

import type { CapabilityName, WorkflowStep } from "./types.js";

// The capability registry. Each abstract capability lists the tool-name
// patterns that satisfy it. Detection is name-based and defensive: a capability
// is satisfied when at least one connected tool's name matches one of its
// patterns (case-insensitive substring). Adding a capability is adding an entry
// here — detection logic never changes. Patterns cover the known providers for
// each capability so any one of them satisfies it (Linear or Jira for
// ticket-tracker, GitHub for code-host, web tools for doc-search).
export const CAPABILITIES: Record<
  CapabilityName,
  { description: string; requiredTools: string[] }
> = {
  "ticket-tracker": {
    description: "Read and update issues in a ticket tracker (Linear, Jira)",
    requiredTools: [
      "linear",
      "jira",
      "save_issue",
      "list_issues",
      "get_issue",
      "create_issue",
    ],
  },
  "code-host": {
    description: "Open and review pull requests on a code host (GitHub)",
    requiredTools: [
      "create_pull_request",
      "get_pull_request",
      "pull_request",
      "create_pr",
      "github",
    ],
  },
  "doc-search": {
    description: "Search and fetch external documentation",
    requiredTools: ["web_search", "web_fetch", "search_documentation", "fetch"],
  },
};

export type CapabilityMap = Map<CapabilityName, ToolDefinition[]>;

// Capabilities forced off for a run regardless of what is connected. Sourced
// from the TUI capability-override panel. A capability present here is treated
// as absent.
export type CapabilityOverrides = ReadonlySet<CapabilityName>;

export type StepResolution = {
  runnable: boolean;
  skippedReason?: string;
  tools: ToolDefinition[];
};

function matches(toolName: string, pattern: string): boolean {
  return toolName.toLowerCase().includes(pattern.toLowerCase());
}

// Inspect the active tool surface and build the capability map. Unknown tools
// are ignored, never errored. Capabilities listed in `overrides` are omitted
// even when matching tools are present.
export function detectCapabilities(
  tools: ToolDefinition[],
  overrides: CapabilityOverrides = new Set(),
): CapabilityMap {
  const map: CapabilityMap = new Map();
  for (const name of Object.keys(CAPABILITIES) as CapabilityName[]) {
    if (overrides.has(name)) continue;
    const patterns = CAPABILITIES[name].requiredTools;
    const satisfying = tools.filter((tool) =>
      patterns.some((pattern) => matches(tool.name, pattern)),
    );
    if (satisfying.length > 0) {
      map.set(name, satisfying);
    }
  }
  return map;
}

// Decide whether a step can run against the detected capabilities. Steps with
// no capability requirement always run. A required-but-unsatisfied capability
// makes the step non-runnable (the runtime then skips it).
export function resolveStep(
  step: WorkflowStep,
  capabilities: CapabilityMap,
): StepResolution {
  if (step.capability === undefined) {
    return { runnable: true, tools: [] };
  }
  const tools = capabilities.get(step.capability);
  if (tools === undefined || tools.length === 0) {
    return {
      runnable: false,
      skippedReason: `capability not satisfied: ${step.capability}`,
      tools: [],
    };
  }
  return { runnable: true, tools };
}
