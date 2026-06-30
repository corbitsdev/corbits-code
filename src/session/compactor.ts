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

export type CompactorConfig = {
  keepRecentTurns: number;
  summaryMaxChars: number;
  summarize?: (turns: ConversationTurn[]) => Promise<string>;
  // Max older turns to pull forward as anchors (file edits, task updates,
  // errors) before the summary stub. Pulled from the end of the older set
  // so the most-recent anchors survive.
  maxAnchorTurns: number;
  // When true, replace tool_result content in every kept turn with a
  // one-line stub. Safe at compaction time because the cache is already
  // cold from the compaction event itself.
  stripResultContent: boolean;
};

const DEFAULT_COMPACTOR_CONFIG: CompactorConfig = {
  keepRecentTurns: 5,
  summaryMaxChars: 2000,
  maxAnchorTurns: 8,
  stripResultContent: false,
};

// Minimum anchor score for a turn to be pulled forward past the summary boundary.
const ANCHOR_SCORE_THRESHOLD = 5;

// Tool name → path argument, used to build readable stubs.
type ToolCallInfo = {
  name: string;
  pathArg?: string;
  commandArg?: string;
};

// Build a callId → tool info index from the full turn list so the strip
// function can produce named stubs without searching across turns.
function buildCallIndex(turns: ConversationTurn[]): Map<string, ToolCallInfo> {
  const index = new Map<string, ToolCallInfo>();
  for (const turn of turns) {
    for (const block of turn.content) {
      if (block.type !== "tool_call") continue;
      const info: ToolCallInfo = { name: block.name };
      const args = block.arguments;
      if (typeof args === "object" && args !== null) {
        const a = args as Record<string, unknown>;
        if (typeof a["path"] === "string") info.pathArg = a["path"];
        if (typeof a["command"] === "string") info.commandArg = a["command"];
      }
      index.set(block.id, info);
    }
  }
  return index;
}

// Locate the turn index of each tool_call and its matching tool_result. In this
// runtime a call lives on one turn and its result on the following turn, so the
// two halves of a pair can straddle a keep/summarize boundary.
type PairLocation = { callIdx?: number; resultIdx?: number };
function buildPairIndex(turns: ConversationTurn[]): Map<string, PairLocation> {
  const pairs = new Map<string, PairLocation>();
  turns.forEach((turn, idx) => {
    for (const block of turn.content) {
      if (block.type === "tool_call") {
        const loc = pairs.get(block.id) ?? {};
        loc.callIdx = idx;
        pairs.set(block.id, loc);
      } else if (block.type === "tool_result") {
        const loc = pairs.get(block.callId) ?? {};
        loc.resultIdx = idx;
        pairs.set(block.callId, loc);
      }
    }
  });
  return pairs;
}

// Score a turn by its anchor importance. Turns that write files, update
// tasks, or contain errors are load-bearing regardless of age.
function anchorScore(turn: ConversationTurn): number {
  let score = 0;
  for (const block of turn.content) {
    if (block.type === "tool_call") {
      if (block.name === "edit_file" || block.name === "write_file") score += 10;
      else if (block.name === "manage_tasks") score += 7;
    }
    if (block.type === "tool_result" && block.isError === true) score += 5;
  }
  return score;
}

function resultContentSize(block: Extract<ConversationTurn["content"][number], { type: "tool_result" }>): number {
  return block.content.reduce((sum, c) => sum + (c.type === "text" ? c.text.length : 0), 0);
}

function buildResultStub(
  block: Extract<ConversationTurn["content"][number], { type: "tool_result" }>,
  callIndex: Map<string, ToolCallInfo>,
): string {
  const info = callIndex.get(block.callId);
  const name = info?.name ?? "tool_result";
  const size = resultContentSize(block);
  if (info?.pathArg !== undefined) return `[${name} ${info.pathArg} — ${size} chars, omitted]`;
  if (info?.commandArg !== undefined) {
    const cmd = info.commandArg.slice(0, 40);
    return `[${name} "${cmd}" — ${size} chars, omitted]`;
  }
  return `[${name} — ${size} chars, omitted]`;
}

// Replace tool_result content with a one-line stub. Errors are kept in full
// because they may describe constraints the model still needs to respect.
function stripTurnResults(
  turn: ConversationTurn,
  callIndex: Map<string, ToolCallInfo>,
): ConversationTurn {
  const content = turn.content.map((block): ConversationTurn["content"][number] => {
    if (block.type !== "tool_result" || block.isError === true) return block;
    return { ...block, content: [{ type: "text", text: buildResultStub(block, callIndex) }] };
  });
  return { ...turn, content };
}

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

      const callIndex = buildCallIndex(turns);

      const keepCount = Math.min(cfg.keepRecentTurns, turns.length - 1);
      const keepFrom = turns.length - keepCount;
      const recentTurns = turns.slice(keepFrom);
      const olderTurns = turns.slice(0, keepFrom);

      // Pull high-importance turns forward regardless of age. Take from the
      // tail of the older set so the most recent anchors survive.
      const scoredOlder = olderTurns.map((t, i) => ({ turn: t, index: i, score: anchorScore(t) }));
      const anchorIndices = new Set(
        scoredOlder
          .filter(({ score }) => score >= ANCHOR_SCORE_THRESHOLD)
          .slice(-cfg.maxAnchorTurns)
          .map(({ index }) => index),
      );

      // Keep tool_call/tool_result pairs together across the keep/summarize
      // boundary. A turn that survives (anchored, or in the recent window) whose
      // partner would be summarized leaves a dangling tool_call or an orphaned
      // tool_result, which the inference layer rejects. Pull the older partner
      // forward as an anchor so the surviving sequence stays well-formed.
      // Pairing wins over maxAnchorTurns: correctness outranks the size target.
      const pairs = buildPairIndex(turns);
      const isKept = (idx: number): boolean => idx >= keepFrom || anchorIndices.has(idx);
      for (const { callIdx, resultIdx } of pairs.values()) {
        if (callIdx === undefined || resultIdx === undefined) continue;
        if (isKept(callIdx) && !isKept(resultIdx) && resultIdx < keepFrom) anchorIndices.add(resultIdx);
        else if (isKept(resultIdx) && !isKept(callIdx) && callIdx < keepFrom) anchorIndices.add(callIdx);
      }

      // Ascending original order keeps the concatenated [anchors, recent]
      // sequence globally index-ordered, so every result still follows its call.
      const sortedAnchorIndices = [...anchorIndices].sort((a, b) => a - b);
      const anchorTurns = sortedAnchorIndices.map((i) => olderTurns[i]!);
      const summarizedTurns = olderTurns.filter((_, i) => !anchorIndices.has(i));

      const summary = cfg.summarize !== undefined
        ? await cfg.summarize(summarizedTurns)
        : buildTurnSummary(summarizedTurns, cfg.summaryMaxChars, anchorTurns.length);

      const summaryTurn: ConversationTurn = {
        role: "system",
        content: [{ type: "text", text: `[Compacted prior context]\n${summary}` }],
        timestamp: olderTurns[olderTurns.length - 1]?.timestamp ?? Date.now(),
      };

      const process = (t: ConversationTurn): ConversationTurn =>
        cfg.stripResultContent ? stripTurnResults(t, callIndex) : t;

      return {
        output: [summaryTurn, ...anchorTurns.map(process), ...recentTurns.map(process)],
        record: {
          strategy: this.name,
          version: this.version,
          parameters: {
            keepRecentTurns: cfg.keepRecentTurns,
            summaryMaxChars: cfg.summaryMaxChars,
            maxAnchorTurns: cfg.maxAnchorTurns,
            stripResultContent: cfg.stripResultContent,
          },
          reason: `compacted ${summarizedTurns.length} turns, anchored ${anchorTurns.length}, keeping ${keepCount} recent`,
          decisions: {
            summarizedTurnCount: summarizedTurns.length,
            anchorTurnCount: anchorTurns.length,
            recentTurnCount: recentTurns.length,
            summaryLength: summary.length,
          },
        },
      };
    },
  };
}

export function buildTurnSummary(
  turns: ConversationTurn[],
  maxChars: number,
  anchorCount = 0,
): string {
  const toolNames = new Set<string>();
  let totalTokens = 0;
  let lastUserMessage = "";
  let toolCallCount = 0;

  for (const turn of turns) {
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
        totalTokens += Math.ceil(resultContentSize(block) / 4);
      }
    }
    if (turn.role === "user") {
      const textBlock = turn.content.find((b) => b.type === "text");
      if (textBlock !== undefined) lastUserMessage = textBlock.text.slice(0, 200);
    }
  }

  const lines: string[] = [
    `Turns compacted: ${turns.length}${anchorCount > 0 ? ` (${anchorCount} anchor turns preserved separately)` : ""}`,
    `Estimated tokens: ~${totalTokens}`,
    `Tools called: ${[...toolNames].sort().join(", ")}`,
    `Total tool calls: ${toolCallCount}`,
  ];

  if (lastUserMessage.length > 0) {
    lines.push(`Last user message: "${lastUserMessage}"`);
  }

  const summary = lines.join("\n");
  return summary.length > maxChars ? summary.slice(0, maxChars - 3) + "..." : summary;
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
