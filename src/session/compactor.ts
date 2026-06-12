// Context curation and compaction for the perpetual session.
//
// Provides:
//   1. A task-boundary classifier that reads the latest user message plus
//      session metadata and emits a structured decision.
//   2. A deterministic compactor (ConversationTurn[] -> ConversationTurn[])
//      that prunes completed-task context while preserving the active task,
//      recent turns, plan state, file/tool references, and unresolved errors.
//   3. A context-envelope builder that produces stable prompt-facing sections
//      for prompt-cache friendliness.
//
// The persisted run history is always kept complete in the context store.
// Only the inference-facing context is curated here.

import type { ConversationTurn, Compactor, StrategyContext, StrategyResult } from "@intx/types/runtime";

// ---------------------------------------------------------------------------
// Task boundary decision
// ---------------------------------------------------------------------------

export type TaskBoundary =
  | { kind: "same_task"; reason: string }
  | { kind: "new_task"; reason: string }
  | { kind: "unclear"; reason: string };

export type SessionMetadata = {
  turnCount: number;
  currentTaskLabel: string | undefined;
  lastTaskSummary: string | undefined;
  minutesElapsed: number;
  toolCallCount: number;
};

// The classifier is a two-tier approach:
//   Tier 1 — deterministic heuristics (fast, no LLM cost)
//   Tier 2 — LLM-based classification (only when heuristics are ambiguous)
//
// For v1 the heuristic tier is deliberately simple and conservative:
// explicit boundary commands and trivial rules fall through to the LLM tier.

const BOUNDARY_COMMANDS = ["/clear", "/new", "/reset"];

/**
 * Determine the task boundary for a new user message.
 *
 * Tier 1 heuristics run first and return immediately for clear-cut cases:
 * explicit boundary commands produce `new_task`; a very short session or a
 * message that is clearly a continuation produces `same_task`.
 *
 * When heuristics cannot decide, the function uses an LLM classification
 * call via the supplied `classify` function. The classifier is ephemeral
 * (no side effects) and returns a fixed small schema.
 */
export async function classifyTaskBoundary(
  message: string,
  metadata: SessionMetadata,
  classify: (prompt: string) => Promise<{ decision: string; reason: string }>,
): Promise<TaskBoundary> {
  // Tier 1: explicit boundary commands
  const trimmed = message.trim();
  if (BOUNDARY_COMMANDS.includes(trimmed)) {
    return { kind: "new_task", reason: "explicit boundary command" };
  }

  // Tier 1: very early in session, always same task
  if (metadata.turnCount <= 1 && metadata.currentTaskLabel === undefined) {
    return { kind: "same_task", reason: "session just started" };
  }

  // Tier 1: continuation signals (short follow-ups, answers to questions)
  if (
    trimmed.length < 40 &&
    metadata.turnCount > 0 &&
    metadata.currentTaskLabel !== undefined
  ) {
    // Short messages on an established task are almost certainly continuations.
    return { kind: "same_task", reason: "short continuation message" };
  }

  // Tier 2: LLM classification
  const classifierPrompt = [
    "You are a task-boundary classifier for an AI coding assistant.",
    "Given the latest user message and session metadata, decide whether this",
    "message starts a new task or continues the current one.",
    "",
    "Respond with a JSON object:",
    '{ "decision": "same_task" | "new_task" | "unclear", "reason": "<brief explanation>" }',
    "",
    "Session metadata:",
    JSON.stringify(metadata, null, 2),
    "",
    "Latest user message:",
    trimmed,
    "",
    "Guidelines:",
    "- 'new_task' — the user is pivoting to unrelated work or explicitly starting fresh",
    "- 'same_task' — the user is continuing, refining, or answering about the current work",
    "- 'unclear' — when you genuinely cannot tell (this avoids mis-classification)",
    "- Be conservative: default to 'same_task' or 'unclear' when in doubt",
  ].join("\n");

  try {
    const result = await classify(classifierPrompt);
    const decision = result.decision;
    if (decision === "new_task") {
      return { kind: "new_task", reason: result.reason };
    }
    if (decision === "same_task") {
      return { kind: "same_task", reason: result.reason };
    }
    return { kind: "unclear", reason: result.reason };
  } catch {
    // Classifier failure should not break the session. Default to unclear.
    return { kind: "unclear", reason: "classifier call failed, defaulting to unclear" };
  }
}

// ---------------------------------------------------------------------------
// Context envelope
// ---------------------------------------------------------------------------

/**
 * Stable keys for context envelope sections. The ordering and keys must not
 * change between turns so prompt caching remains effective.
 */
export const CONTEXT_ENVELOPE_SECTIONS = [
  "active-task",
  "task-summary",
  "current-plan",
  "recent-turns",
  "file-references",
  "unresolved-errors",
] as const;

export type ContextEnvelope = {
  /** Label for the current active task, e.g. "Fix login bug" */
  activeTask?: string;
  /** Compacted summary of prior completed tasks */
  taskSummary?: string;
  /** Current plan steps if one is active */
  currentPlan?: string;
  /** Recent conversation turns (N most recent) */
  recentTurns: number;
  /** Files the agent has read or modified */
  fileReferences?: string[];
  /** Any unresolved errors from the current task */
  unresolvedErrors?: string[];
};

/**
 * Build the context-envelope text that gets placed between the system prompt
 * and the conversation history. Stable ordering ensures prompt-cache prefix
 * stability across turns.
 */
export function buildContextEnvelope(envelope: ContextEnvelope): string {
  const sections: string[] = ["--- Context ---"];

  if (envelope.activeTask !== undefined && envelope.activeTask.length > 0) {
    sections.push(`Active task: ${envelope.activeTask}`);
  }

  if (envelope.taskSummary !== undefined && envelope.taskSummary.length > 0) {
    sections.push(`Prior task summary:\n${envelope.taskSummary}`);
  }

  if (envelope.currentPlan !== undefined && envelope.currentPlan.length > 0) {
    sections.push(`Current plan:\n${envelope.currentPlan}`);
  }

  sections.push(`Recent turns shown: ${envelope.recentTurns}`);

  if (
    envelope.fileReferences !== undefined &&
    envelope.fileReferences.length > 0
  ) {
    sections.push(
      `Files referenced: ${envelope.fileReferences.join(", ")}`,
    );
  }

  if (
    envelope.unresolvedErrors !== undefined &&
    envelope.unresolvedErrors.length > 0
  ) {
    sections.push(
      `Unresolved errors:\n${envelope.unresolvedErrors.join("\n")}`,
    );
  }

  sections.push("---");
  return sections.join("\n");
}

// ---------------------------------------------------------------------------
// Compactor
// ---------------------------------------------------------------------------

/**
 * Configuration for the deterministic compactor.
 *
 * These parameters control how many recent turns to preserve and how much
 * prior context to compact. They are deliberately simple for v1; future
 * versions may use learned or dynamic values.
 */
export type CompactorConfig = {
  /** Number of most-recent turns to preserve in full fidelity. */
  keepRecentTurns: number;
  /**
   * Maximum total characters for the compacted summary of prior turns.
   * Older turns beyond `keepRecentTurns` are replaced with this summary.
   */
  summaryMaxChars: number;
  /**
   * Optional async summarizer. When provided, called instead of the
   * deterministic `buildTurnSummary` to produce the compacted summary.
   */
  summarize?: (turns: ConversationTurn[]) => Promise<string>;
};

const DEFAULT_COMPACTOR_CONFIG: CompactorConfig = {
  keepRecentTurns: 5,
  summaryMaxChars: 2000,
};

/**
 * Build a deterministic compactor that preserves recent turns and the
 * current task's essential information.
 *
 * The compactor:
 * 1. Keeps the N most-recent turns in full fidelity
 * 2. Replaces everything older with a compacted summary block
 * 3. Preserves any tool results referenced by the kept turns
 *
 * This is a pure function — it does not read or write any state. The
 * reactor's context store handles persistence.
 */
export function createPruningCompactor(
  config: Partial<CompactorConfig> = {},
): Compactor {
  const cfg = { ...DEFAULT_COMPACTOR_CONFIG, ...config };

  return {
    name: "pruning-compactor",
    version: "1.0.0",
    async apply(
      turns: ConversationTurn[],
      _ctx: StrategyContext,
    ): Promise<StrategyResult<ConversationTurn[]>> {
      if (turns.length <= cfg.keepRecentTurns + 1) {
        return {
          output: turns,
          record: {
            strategy: this.name,
            version: this.version,
            parameters: { keepRecentTurns: cfg.keepRecentTurns },
            reason: "no compaction needed",
            decisions: {},
          },
        };
      }

      const keepCount = Math.min(cfg.keepRecentTurns, turns.length - 1);
      const keepFrom = turns.length - keepCount;

      // Build a summary of the older turns (everything before keepFrom)
      const olderTurns = turns.slice(0, keepFrom);
      const summary = cfg.summarize !== undefined
        ? await cfg.summarize(olderTurns)
        : buildTurnSummary(olderTurns, cfg.summaryMaxChars);

      // Recent turns are preserved in full
      const recentTurns = turns.slice(keepFrom);

      // Prepend the summary as a synthetic system turn so the model sees it
      const summaryTurn: ConversationTurn = {
        role: "system",
        content: [
          {
            type: "text",
            text: `[Compacted prior context]\n${summary}`,
          },
        ],
        timestamp: olderTurns[olderTurns.length - 1]?.timestamp ?? Date.now(),
      };

      return {
        output: [summaryTurn, ...recentTurns],
        record: {
          strategy: this.name,
          version: this.version,
          parameters: {
            keepRecentTurns: cfg.keepRecentTurns,
            summaryMaxChars: cfg.summaryMaxChars,
          },
          reason: `compacted ${olderTurns.length} older turns, keeping ${keepCount} recent`,
          decisions: {
            olderTurnCount: olderTurns.length,
            recentTurnCount: recentTurns.length,
            summaryLength: summary.length,
          },
        },
      };
    },
  };
}

/**
 * Build a text summary of a sequence of turns. For v1 this is a
 * deterministic extract — no LLM summarization. It counts tokens, lists
 * tools called, and notes the last user message.
 *
 * Future versions may use LLM summarization for richer summaries while
 * keeping the deterministic fallback for prompt-cache friendliness.
 */
function buildTurnSummary(turns: ConversationTurn[], maxChars: number): string {
  const toolNames = new Set<string>();
  let totalTokens = 0;
  let lastUserMessage = "";
  let toolCallCount = 0;

  for (const turn of turns) {
    // Estimate tokens (rough: 4 chars per token)
    for (const block of turn.content) {
      if (block.type === "text") {
        totalTokens += Math.ceil(block.text.length / 4);
      }
      if (block.type === "tool_call") {
        toolNames.add(block.name);
        toolCallCount++;
        totalTokens += Math.ceil(JSON.stringify(block.arguments).length / 4);
      }
      if (block.type === "tool_result") {
        // Estimate tool result size
        totalTokens += Math.ceil(String(block.content ?? "").length / 4);
      }
    }
    // Track last user message
    if (turn.role === "user") {
      const textBlock = turn.content.find((b) => b.type === "text");
      if (textBlock !== undefined) {
        lastUserMessage = textBlock.text.slice(0, 200);
      }
    }
  }

  const lines: string[] = [
    `Turns compacted: ${turns.length}`,
    `Estimated tokens: ~${totalTokens}`,
    `Tools called: ${[...toolNames].sort().join(", ")}`,
    `Total tool calls: ${toolCallCount}`,
  ];

  if (lastUserMessage.length > 0) {
    lines.push(`Last user message: "${lastUserMessage}"`);
  }

  const summary = lines.join("\n");

  // Truncate if needed
  if (summary.length > maxChars) {
    return summary.slice(0, maxChars - 3) + "...";
  }

  return summary;
}

/**
 * Build an LLM-generated structured summary of a sequence of turns.
 *
 * Calls `summarize` with a condensed representation of the turns and returns
 * the result string directly. Falls back to `buildTurnSummary` if the
 * summarize call fails.
 */
export async function buildLLMTurnSummary(
  turns: ConversationTurn[],
  summarize: (prompt: string) => Promise<string>,
  maxChars = 3000,
): Promise<string> {
  // Build a condensed input representation for the LLM
  const toolNames = new Set<string>();
  let lastUserMessage = "";
  const assistantSnippets: string[] = [];

  for (const turn of turns) {
    for (const block of turn.content) {
      if (block.type === "tool_call") {
        toolNames.add(block.name);
      }
    }
    if (turn.role === "user") {
      const textBlock = turn.content.find((b) => b.type === "text");
      if (textBlock !== undefined && textBlock.type === "text") {
        lastUserMessage = textBlock.text.slice(0, 300);
      }
    }
    if (turn.role === "assistant") {
      const textBlock = turn.content.find((b) => b.type === "text");
      if (textBlock !== undefined && textBlock.type === "text" && textBlock.text.length > 0) {
        assistantSnippets.push(textBlock.text.slice(0, 200));
      }
    }
  }

  const condensed = [
    `Turns: ${turns.length}`,
    `Tools called: ${[...toolNames].sort().join(", ")}`,
    lastUserMessage.length > 0 ? `Last user message: "${lastUserMessage}"` : null,
    assistantSnippets.length > 0
      ? `Assistant messages (excerpts):\n${assistantSnippets.slice(-3).join("\n---\n")}`
      : null,
  ]
    .filter((l) => l !== null)
    .join("\n")
    .slice(0, 2000);

  const prompt = [
    "You are summarizing a completed coding session for context compaction.",
    "Based on the session excerpt below, produce a structured summary in exactly this format:",
    "",
    "Goal: <what the user was trying to accomplish>",
    "Constraints: <any constraints or requirements mentioned>",
    "Progress: <what was done and what worked>",
    "Key Decisions: <important decisions made>",
    "Next Steps: <what was left or planned next>",
    "Critical Context: <anything the next task needs to know>",
    "",
    "Session excerpt:",
    condensed,
  ].join("\n");

  try {
    const text = await summarize(prompt);
    return text.slice(0, maxChars);
  } catch {
    return buildTurnSummary(turns, maxChars);
  }
}

/**
 * Build the current-plan text from a plan steps array.
 */
export function formatPlan(
  steps: Array<{ file: string; action: string; reason?: string }>,
): string {
  return steps
    .map(
      (s, i) => `${i + 1}. ${s.file} — ${s.action}${s.reason ? ` (${s.reason})` : ""}`,
    )
    .join("\n");
}
