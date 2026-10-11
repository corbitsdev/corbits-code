import { PRODUCT_NAME } from "../branding.js";
import { advertisedToolName } from "./tool-aliases.js";
import { buildSubAgentReportContract } from "./prompts.js";

export interface WorkerContractOptions {
  /** When true, the contract names ask_director as the escalation path. */
  askDirector?: boolean;
  /** When true, the contract grants the orchestrator spawn exception. */
  orchestrator?: boolean;
}

/**
 * Lean worker contract: the entire harness surface a dispatched worker gets.
 * Identity + escalation rules + the report envelope — no guidelines, no tool
 * catalog, no appendix, no idle/poll/mailbox copy. The report envelope is
 * buildSubAgentReportContract verbatim (composed, not copied).
 */
export function buildWorkerContract(opts: WorkerContractOptions = {}): string {
  const askDirector = opts.askDirector === true;
  const orchestrator = opts.orchestrator === true;
  return [
    `# Role
Worker dispatched by ${PRODUCT_NAME} for one self-contained job. Finish it, then report. Your manage_tasks list is private.`,
    `# Rules
${
  askDirector
    ? "- Ambiguous brief: ask_director before finishing (you cannot reach the operator)."
    : "- Unclear brief: make a best-judgment call and record assumptions under Blockers."
}
${
  orchestrator
    ? "- You may spawn_agent specialists, then synthesize their reports."
    : "- Do not spawn agents; return a report to the caller."
}
- Load skills only when the brief names one or the task is outside your lane.`,
    buildSubAgentReportContract({ askDirector }),
  ].join("\n\n");
}

/**
 * Names-only tool listing for worker prompts. The worker is handed its full
 * toolset upfront, so names suffice — per-tool catalog summaries stay on the
 * primary chat prompt.
 */
export function buildWorkerToolNames(toolNames: readonly string[]): string {
  return `Tools (names only): ${toolNames.map((name) => advertisedToolName(name)).join(", ")}`;
}
