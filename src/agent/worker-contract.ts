import { PRODUCT_NAME } from "../branding.js";
import { buildSubAgentReportContract } from "./prompts.js";

export interface WorkerContractOptions {
  /** When true, the contract names ask_director as the escalation path. */
  askDirector?: boolean;
  /** When true, the contract grants the orchestrator spawn exception. */
  orchestrator?: boolean;
}

/**
 * Lean worker contract (CL-8212): the entire harness surface a dispatched
 * worker gets. Identity + escalation rules + the report envelope — no
 * guidelines, no tool catalog, no appendix, no idle/poll/mailbox copy.
 *
 * The report envelope section is buildSubAgentReportContract verbatim
 * (byte-identical by construction — it is composed, not copied).
 */
export function buildWorkerContract(opts: WorkerContractOptions = {}): string {
  const askDirector = opts.askDirector === true;
  const orchestrator = opts.orchestrator === true;
  return [
    `You are a fleet agent — a worker dispatched by ${PRODUCT_NAME} to carry out one self-contained job autonomously. Finish the job and report back. Your manage_tasks checklist (if you use it) is yours alone; it is not shared with the parent.`,
    askDirector
      ? "- If the brief is genuinely ambiguous, ask_director before finishing — you cannot reach the operator."
      : "- If the brief is unclear, make the best-judgment call, act, and note assumptions under Blockers — you cannot ask the parent mid-run.",
    orchestrator
      ? `- You are an orchestrator: you MAY call \`spawn_agent\` to spawn other fleet agents (e.g. spawn_agent(agent="greybeard", description="Review approach", prompt="...")). This is an explicit exception to the no-recursion rule — delegate specialist work, then synthesize their reports. \`spawn_agent\` spawns an agent, not a checklist item.`
      : `- Only the primary ${PRODUCT_NAME} session (or a built-in orchestrator director) may call \`spawn_agent\` to spawn fleet agents. You are a worker: return a concrete report to the caller instead of spawning further agents. Use manage_tasks for your own work checklist if the job is multi-step.`,
    "- Skills are available; search only when the brief names a skill or the task is outside your lane. For a small, bounded edit, do not search skills. Load a brief-named skill straight through use_skill with its exact name; call skill_search for descriptions only when choosing among skills and it is mounted; load only the skills the task needs.",
    buildSubAgentReportContract({ askDirector }),
  ].join("\n\n");
}

/**
 * Names-only tool listing for worker prompts. The worker is handed its full
 * toolset upfront, so names suffice — per-tool catalog summaries stay on the
 * primary chat prompt.
 */
export function buildWorkerToolNames(toolNames: readonly string[]): string {
  return `Tools (names only): ${toolNames.join(", ")}`;
}
