// Model-backed compaction summarizer.
//
// When the context crosses the compaction threshold, the pruning compactor
// replaces older turns with a summary. A deterministic stats blob ("Turns: N,
// Tools called: ...") loses everything that matters for resuming work, so this
// module produces a structured, workflow-aware narrative via a one-shot
// inference call against the session's own model. On any failure it falls back
// to the deterministic summary so compaction never breaks the session.

import { runInference, type Dependencies } from "@intx/inference";
import { createDefaultDependencies } from "@intx/inference/providers";
import type { ConversationTurn, InferenceSource } from "@intx/types/runtime";
import { buildTurnSummary, extractFailedAttempts } from "./compactor.js";

// What the agent was doing when compaction fired. Lets the summary preserve
// the workflow contract ("we are at step 3/7 of /build") rather than dropping
// it into the compacted region.
export type SummaryContext = {
  workflow?: {
    name?: string;
    stepLabel?: string;
    stepIndex?: number;
    total?: number;
  };
  /** Active session goal — preserved across compaction so the continue-rule survives. */
  goal?: {
    condition: string;
    status: string;
    brief?: string;
    criteriaSummary?: string;
  };
};

const SYSTEM_INSTRUCTION = [
  "You are compacting the context of an in-progress coding session so the agent",
  "can keep working with a much shorter history. Read the session excerpt and",
  "produce a tight, factual handoff. Do not invent anything not present in the",
  "excerpt. Use exactly these sections, each as a short markdown block:",
  "",
  "## What Happened",
  "Bullet the concrete work already done (files changed, decisions made, things",
  "discovered, things that failed and why).",
  "",
  "## Failed Attempts — Do Not Retry",
  "Bullet every approach, command, or edit that was already tried and failed,",
  "each with its error, so the agent does not repeat it. Required whenever the",
  "excerpt below lists any failed tool results; omit only if there are none.",
  "",
  "## What We're Doing",
  "One or two sentences on the current objective and, if a workflow is active,",
  "which workflow and step we are on.",
  "",
  "## Relevant Links",
  "URLs, file paths, identifiers (tickets, commits, symbols) that later turns",
  "will need. Omit the section if there are none.",
  "",
  "## Action Items",
  "Concrete things still owed, with enough detail to act on without re-reading",
  "the dropped history.",
  "",
  "## Next Steps",
  "The immediate next action(s) to take right now.",
  "",
  "Be specific and terse. Prefer paths, names, and exact values over prose.",
].join("\n");

// Pull a compact, model-readable excerpt out of the turns being dropped:
// recent user asks, assistant reasoning snippets, tool calls and the files
// they touched. Bounded so the summary call itself stays cheap.
export function condenseTurns(turns: ConversationTurn[]): string {
  const userMessages: string[] = [];
  const assistantSnippets: string[] = [];
  const toolNames = new Set<string>();
  const files = new Set<string>();
  const links = new Set<string>();

  for (const turn of turns) {
    for (const block of turn.content) {
      if (block.type === "text") {
        const urls = block.text.match(/https?:\/\/[^\s)]+/g);
        if (urls) for (const u of urls) links.add(u);
        if (turn.role === "user") {
          userMessages.push(block.text.slice(0, 400));
        } else if (turn.role === "assistant" && block.text.length > 0) {
          assistantSnippets.push(block.text.slice(0, 300));
        }
      }
      if (block.type === "tool_call") {
        toolNames.add(block.name);
        const args = block.arguments as Record<string, unknown> | undefined;
        const path = args?.path ?? args?.file;
        if (typeof path === "string" && path.length > 0) files.add(path);
        const url = args?.url;
        if (typeof url === "string" && url.length > 0) links.add(url);
      }
    }
  }

  const failedAttempts = extractFailedAttempts(turns);

  const sections: Array<string | null> = [
    `Turns dropped: ${turns.length}`,
    toolNames.size > 0 ? `Tools used: ${[...toolNames].sort().join(", ")}` : null,
    files.size > 0 ? `Files touched:\n${[...files].slice(0, 40).map((f) => `- ${f}`).join("\n")}` : null,
    links.size > 0 ? `Links/identifiers:\n${[...links].slice(0, 30).map((l) => `- ${l}`).join("\n")}` : null,
    failedAttempts.length > 0
      ? `Failed attempts (do not retry):\n${failedAttempts.join("\n")}`
      : null,
    userMessages.length > 0
      ? `User messages (most recent last):\n${userMessages.slice(-6).join("\n---\n")}`
      : null,
    assistantSnippets.length > 0
      ? `Assistant notes (excerpts):\n${assistantSnippets.slice(-8).join("\n---\n")}`
      : null,
  ];

  return sections.filter((s): s is string => s !== null).join("\n\n");
}

function workflowPreamble(ctx: SummaryContext | undefined): string {
  const parts: string[] = [];
  const wf = ctx?.workflow;
  if (wf !== undefined && wf.name !== undefined) {
    const step =
      wf.stepIndex !== undefined && wf.total !== undefined
        ? ` (step ${wf.stepIndex + 1}/${wf.total}${wf.stepLabel ? `: ${wf.stepLabel}` : ""})`
        : wf.stepLabel
          ? ` (current step: ${wf.stepLabel})`
          : "";
    parts.push(
      `Active workflow: /${wf.name}${step}\nThis session is mid-workflow — preserve everything needed to resume it.`,
    );
  }
  const goal = ctx?.goal;
  if (goal !== undefined && goal.condition.length > 0) {
    const brief = goal.brief !== undefined && goal.brief.length > 0 ? goal.brief : goal.condition;
    const criteria =
      goal.criteriaSummary !== undefined && goal.criteriaSummary.length > 0
        ? `\nAcceptance criteria: ${goal.criteriaSummary}`
        : "";
    parts.push(
      `Active goal (${goal.status}): ${brief}${criteria}\n` +
        "The agent must keep working until every acceptance criterion is done.",
    );
  }
  if (parts.length === 0) return "";
  return `${parts.join("\n\n")}\n\n`;
}

/** Build the user-content prompt for the summary call. Pure and testable. */
export function buildSummaryPrompt(
  turns: ConversationTurn[],
  ctx?: SummaryContext,
): string {
  return `${workflowPreamble(ctx)}Session excerpt:\n\n${condenseTurns(turns)}`;
}

// Low-level completion: one inference round-trip returning assistant text.
// Injectable so tests can drive the summarizer without a live model.
export type CompletionFn = (
  turns: ConversationTurn[],
  source: InferenceSource,
  signal: AbortSignal,
) => Promise<string>;

function defaultComplete(deps: Dependencies): CompletionFn {
  return async (turns, source, signal) => {
    let seq = 0;
    let out = "";
    for await (const event of runInference({
      turns,
      source,
      signal,
      nextSeq: () => seq++,
      deps,
    })) {
      if (event.type === "inference.done") {
        for (const block of event.data.turn.content) {
          if (block.type === "text") out += block.text;
        }
      } else if (event.type === "inference.error") {
        throw new Error(event.data.error.message);
      }
    }
    return out.trim();
  };
}

export type ModelSummarizerOptions = {
  /** Returns the source to summarize with — read live so model switches apply. */
  getSource: () => InferenceSource;
  /** Abort signal source; the summary call is cancelled if the session ends. */
  getSignal?: () => AbortSignal;
  /** Override the completion path (tests inject a fake here). */
  complete?: CompletionFn;
  deps?: Dependencies;
  /** Cap on the returned summary length. */
  maxChars?: number;
};

/**
 * Build a `summarize(turns, ctx)` function suitable for `CompactorConfig`.
 * Produces a structured, workflow-aware summary via the model; on any error
 * (or empty output) falls back to the deterministic summary so a compaction
 * cycle never throws.
 */
export function createModelSummarizer(
  options: ModelSummarizerOptions,
): (turns: ConversationTurn[], ctx?: SummaryContext) => Promise<string> {
  const deps = options.deps ?? createDefaultDependencies();
  const complete = options.complete ?? defaultComplete(deps);
  const maxChars = options.maxChars ?? 4000;

  return async (turns, ctx) => {
    const fallback = (): string => buildTurnSummary(turns, maxChars);
    try {
      const promptTurns: ConversationTurn[] = [
        { role: "system", content: [{ type: "text", text: SYSTEM_INSTRUCTION }], timestamp: turns[0]?.timestamp ?? 0 },
        { role: "user", content: [{ type: "text", text: buildSummaryPrompt(turns, ctx) }], timestamp: 0 },
      ];
      const signal = options.getSignal?.() ?? new AbortController().signal;
      const text = await complete(promptTurns, options.getSource(), signal);
      if (text.length === 0) return fallback();
      return text.length > maxChars ? text.slice(0, maxChars) : text;
    } catch {
      return fallback();
    }
  };
}
