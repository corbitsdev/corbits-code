import type { ToolDefinition } from "@intx/types/runtime";

import type { CapabilityName, WorkflowStep } from "./definition.js";

// Capability registry: each entry lists the tool-name patterns that satisfy
// it. Detection is name-based, so adding a capability is adding an entry here.
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
    ],
  },
  "doc-search": {
    description: "Search and fetch external documentation",
    requiredTools: ["web_search", "web_fetch", "search_documentation"],
  },
};

export type CapabilityMap = Map<CapabilityName, ToolDefinition[]>;

// Capabilities forced off for a run regardless of what is connected (sourced
// from the TUI capability-override panel). Treated as absent.
export type CapabilityOverrides = ReadonlySet<CapabilityName>;

export interface StepResolution {
  runnable: boolean;
  skippedReason?: string;
  tools: ToolDefinition[] | undefined;
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

// A pattern matches when its tokens appear as a contiguous run within the tool
// name's tokens — "web_fetch" never matches "git_fetch".
function matches(toolName: string, pattern: string): boolean {
  const tokens = tokenize(toolName);
  const needle = tokenize(pattern);
  if (needle.length === 0) return false;
  for (let i = 0; i + needle.length <= tokens.length; i++) {
    if (needle.every((tok, j) => tokens[i + j] === tok)) return true;
  }
  return false;
}

// Build the capability map from the active tool surface. Unknown tools are
// ignored; `overrides` omit a capability even when matching tools exist.
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

// Decide whether a step can run. No requirement always runs; an unsatisfied
// required capability makes the step non-runnable (the runtime skips it).
export function resolveStep(
  step: WorkflowStep,
  capabilities: CapabilityMap,
): StepResolution {
  if (step.capability === undefined) {
    // No capability requirement: always runs, no relevant tools.
    return { runnable: true, tools: undefined };
  }
  const tools = capabilities.get(step.capability);
  if (tools === undefined || tools.length === 0) {
    return {
      runnable: false,
      skippedReason: `capability not satisfied: ${step.capability}`,
      tools: undefined,
    };
  }
  return { runnable: true, tools };
}
