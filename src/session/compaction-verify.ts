// Verify pass for compaction folds.
//
// After the compactor writes a summary handoff, this module scores the new
// spine against the continuation facts the dropped turns carried (goal,
// state, next action, constraints, verification, blockers, exact names).
// A fold that drops or contradicts those facts would leave the next agent
// without steam, so the pass repairs the handoff deterministically or aborts
// the fold. Fail closed: never ship a lying spine.

import { type } from "arktype";
import type { ConversationTurn } from "@intx/types/runtime";

export const ContinuationFacts = type({
  /** First user ask: the standing goal the folds must preserve. */
  goal: "string",
  /** Constraint-like sentences lifted from user turns. */
  constraints: "string[]",
  /** Last substantive assistant/user text in the dropped region. */
  nextAction: "string",
  /** Last error text or assistant snippet: where the work stood. */
  state: "string",
  /** Verification commands run (shell/test invocations). */
  verification: "string[]",
  /** Errored tool-result texts: what is still broken. */
  blockers: "string[]",
  /** Exact file paths and URLs the next agent will need verbatim. */
  exactNames: "string[]",
});
export type ContinuationFacts = typeof ContinuationFacts.infer;

export type VerifyMissKind =
  | "goal"
  | "constraint"
  | "nextAction"
  | "exactName"
  | "blocker"
  | "verification"
  | "contradiction";

export interface VerifyMiss {
  kind: VerifyMissKind;
  detail: string;
}

export interface VerifyReport {
  supported: boolean;
  misses: VerifyMiss[];
}

export interface VerifyOutcome {
  summary: string;
  repaired: boolean;
  aborted: boolean;
  misses: VerifyMiss[];
}

export const VERIFY_REPAIR_HEADING = "## Carry-forward (verify repair)";

// Words that carry no identifying signal. Kept small on purpose: the scorer
// compares content words, and every extra stopword is a false mismatch.
const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "for",
  "with",
  "from",
  "that",
  "this",
  "these",
  "those",
  "are",
  "was",
  "were",
  "been",
  "have",
  "has",
  "had",
  "will",
  "would",
  "should",
  "could",
  "what",
  "when",
  "where",
  "which",
  "while",
  "after",
  "before",
  "into",
  "over",
  "under",
  "about",
  "your",
  "you",
  "our",
  "its",
  "also",
  "just",
  "still",
  "even",
  "then",
  "than",
  "such",
  "more",
  "most",
  "some",
  "any",
  "all",
  "each",
  "both",
  "only",
]);

function significantTokens(text: string, cap = 24): string[] {
  const out: string[] = [];
  for (const word of text.toLowerCase().split(/[^a-z0-9_./-]+/)) {
    if (word.length < 4 || STOPWORDS.has(word)) continue;
    if (!out.includes(word)) out.push(word);
    if (out.length >= cap) break;
  }
  return out;
}

// Half (rounded up) of the fact's content words must appear in the summary.
// Short facts need all of their words: one shared word proves nothing.
function tokensSupported(fact: string, summary: string): boolean {
  const tokens = significantTokens(fact);
  if (tokens.length === 0) return true;
  const lowered = summary.toLowerCase();
  const hits = tokens.filter((t) => lowered.includes(t)).length;
  const needed =
    tokens.length <= 2 ? tokens.length : Math.ceil(tokens.length / 2);
  return hits >= needed;
}

function userTexts(turns: readonly ConversationTurn[]): string[] {
  const out: string[] = [];
  for (const turn of turns) {
    if (turn.role !== "user") continue;
    for (const block of turn.content) {
      if (block.type === "text" && block.text.trim().length > 0)
        out.push(block.text);
    }
  }
  return out;
}

function assistantTexts(turns: readonly ConversationTurn[]): string[] {
  const out: string[] = [];
  for (const turn of turns) {
    if (turn.role !== "assistant") continue;
    for (const block of turn.content) {
      if (block.type === "text" && block.text.trim().length > 0)
        out.push(block.text);
    }
  }
  return out;
}

// Sentences that read like standing instructions rather than chat.
const CONSTRAINT_MARKERS =
  /\b(must|must not|never|always|only|do not|don't|required|ensure|make sure|keep|without|no emojis?)\b/i;

function extractConstraints(texts: readonly string[]): string[] {
  const out: string[] = [];
  for (const text of texts) {
    for (const sentence of text.split(/(?<=[.!?\n])\s+/)) {
      const trimmed = sentence.trim();
      if (
        trimmed.length >= 12 &&
        CONSTRAINT_MARKERS.test(trimmed) &&
        !out.includes(trimmed)
      )
        out.push(trimmed.slice(0, 300));
    }
  }
  return out.slice(0, 8);
}

function toolCallArgs(
  turns: readonly ConversationTurn[],
): { name: string; args: Record<string, unknown> }[] {
  const out: { name: string; args: Record<string, unknown> }[] = [];
  for (const turn of turns) {
    for (const block of turn.content) {
      if (block.type !== "tool_call") continue;
      let args: Record<string, unknown> = {};
      if (
        block.arguments !== null &&
        typeof block.arguments === "object" &&
        !Array.isArray(block.arguments)
      )
        args = block.arguments as Record<string, unknown>;
      out.push({ name: block.name, args });
    }
  }
  return out;
}

function erroredResultTexts(turns: readonly ConversationTurn[]): string[] {
  const out: string[] = [];
  for (const turn of turns) {
    for (const block of turn.content) {
      if (block.type !== "tool_result" || block.isError !== true) continue;
      const text = block.content
        .flatMap((c) => (c.type === "text" ? [c.text] : []))
        .join("")
        .trim();
      if (text.length > 0 && !out.includes(text)) out.push(text.slice(0, 300));
    }
  }
  return out.slice(0, 6);
}

function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/**
 * Pull the continuation facts out of the turns a fold is about to drop.
 * Deterministic and total: no fact means nothing to verify, never an abort.
 */
export function extractContinuationFacts(
  turns: readonly ConversationTurn[],
): ContinuationFacts {
  const users = userTexts(turns);
  const assistants = assistantTexts(turns);
  const calls = toolCallArgs(turns);
  const blockers = erroredResultTexts(turns);

  const goal = users[0] ?? "";
  const nextAction =
    assistants[assistants.length - 1] ?? users[users.length - 1] ?? "";
  const state =
    blockers[blockers.length - 1] ??
    assistants[assistants.length - 1] ??
    users[users.length - 1] ??
    "";

  const exactNames: string[] = [];
  const verification: string[] = [];
  for (const { name, args } of calls) {
    const path = args["path"];
    if (
      typeof path === "string" &&
      path.length > 0 &&
      !exactNames.includes(path)
    )
      exactNames.push(path);
    const url = args["url"];
    if (typeof url === "string" && url.length > 0 && !exactNames.includes(url))
      exactNames.push(url);
    if (name === "run_shell") {
      const command = args["command"];
      if (
        typeof command === "string" &&
        command.length > 0 &&
        !verification.includes(command)
      )
        verification.push(command.slice(0, 200));
    }
  }
  for (const text of [...users, ...assistants]) {
    for (const match of text.match(/https?:\/\/[^\s)]+/g) ?? []) {
      if (!exactNames.includes(match)) exactNames.push(match);
    }
  }

  // Arktype at the boundary: the extractor's shape is the verifier's input
  // contract, so a malformed fact fails here instead of scoring nonsense.
  const parsed = ContinuationFacts({
    goal: goal.slice(0, 500),
    constraints: extractConstraints(users),
    nextAction: nextAction.slice(0, 300),
    state: state.slice(0, 300),
    verification: verification.slice(0, 6),
    blockers,
    exactNames: exactNames.slice(0, 20),
  });
  if (parsed instanceof type.errors) throw new Error("invalid facts");
  return parsed;
}

// Basename for paths (a summary that moves `src/auth.ts` to "auth.ts" still
// names it); hostname for URLs (query strings get reworded freely).
function exactNameSupported(name: string, summary: string): boolean {
  const lowered = summary.toLowerCase();
  if (name.startsWith("http")) {
    const host = hostnameOf(name);
    if (host !== undefined && lowered.includes(host.toLowerCase())) return true;
    return lowered.includes(name.toLowerCase());
  }
  const base = name.split("/").pop() ?? name;
  return base.length > 0 && lowered.includes(base.toLowerCase());
}

// Claims that deny failure while the dropped turns record it. Narrow on
// purpose: only an explicit denial contradicts, never a progress report.
const DENIES_FAILURE =
  /\bno\s+(errors?|failures?|blockers?|issues?)\b|\bnothing\s+(pending|failing|left|outstanding)\b/i;

/**
 * Score a candidate handoff against the dropped turns' continuation facts.
 * Missing or contradicted critical facts fail the fold.
 */
export function verifyCompactionSummary(
  summary: string,
  facts: ContinuationFacts,
): VerifyReport {
  const misses: VerifyMiss[] = [];

  if (facts.goal.trim().length > 0 && !tokensSupported(facts.goal, summary)) {
    misses.push({ kind: "goal", detail: facts.goal.slice(0, 200) });
  }
  for (const constraint of facts.constraints) {
    if (!tokensSupported(constraint, summary)) {
      misses.push({ kind: "constraint", detail: constraint.slice(0, 200) });
    }
  }
  if (
    facts.nextAction.trim().length > 0 &&
    !tokensSupported(facts.nextAction, summary)
  ) {
    misses.push({ kind: "nextAction", detail: facts.nextAction.slice(0, 200) });
  }
  for (const name of facts.exactNames) {
    if (!exactNameSupported(name, summary)) {
      misses.push({ kind: "exactName", detail: name });
    }
  }
  for (const blocker of facts.blockers) {
    if (!tokensSupported(blocker, summary)) {
      misses.push({ kind: "blocker", detail: blocker.slice(0, 200) });
    }
  }
  for (const command of facts.verification) {
    if (!tokensSupported(command, summary)) {
      misses.push({ kind: "verification", detail: command.slice(0, 200) });
    }
  }
  if (facts.blockers.length > 0 && DENIES_FAILURE.test(summary)) {
    misses.push({
      kind: "contradiction",
      detail: "summary denies failure while dropped turns record errors",
    });
  }

  return { supported: misses.length === 0, misses };
}

/**
 * Deterministic rewrite: append the missing facts verbatim under a repair
 * heading so the next agent resumes with names and wording intact.
 */
export function repairSummary(
  summary: string,
  facts: ContinuationFacts,
  misses: readonly VerifyMiss[],
): string {
  const kinds = new Set(misses.map((m) => m.kind));
  const lines: string[] = [VERIFY_REPAIR_HEADING];
  const goalMiss = misses.find((m) => m.kind === "goal");
  if (goalMiss !== undefined) lines.push(`Goal: ${facts.goal}`);
  const nextMiss = misses.find((m) => m.kind === "nextAction");
  if (nextMiss !== undefined) lines.push(`Next: ${facts.nextAction}`);
  // The state line carries where the work stood when it is neither the next
  // action nor an already-listed blocker.
  const stateCovered =
    facts.state.trim().length === 0 ||
    facts.state === facts.nextAction ||
    facts.blockers.includes(facts.state);
  if ((kinds.has("blocker") || kinds.has("nextAction")) && !stateCovered)
    lines.push(`State: ${facts.state}`);
  if (kinds.has("constraint")) {
    lines.push(
      `Constraints:\n${facts.constraints.map((c) => `- ${c}`).join("\n")}`,
    );
  }
  if (kinds.has("blocker")) {
    lines.push(
      `Open blockers:\n${facts.blockers.map((b) => `- ${b}`).join("\n")}`,
    );
  }
  if (kinds.has("exactName")) {
    const missing = misses
      .filter((m) => m.kind === "exactName")
      .map((m) => m.detail);
    lines.push(`Exact references: ${missing.join(", ")}`);
  }
  if (kinds.has("verification")) {
    lines.push(`Ran: ${facts.verification.join("; ")}`);
  }
  return `${summary.trimEnd()}\n\n${lines.join("\n")}`;
}

/**
 * Verify a candidate handoff, repairing once or aborting the fold.
 * A contradiction aborts outright: an appended correction cannot retract the
 * handoff's false denial. A truncating repair that still drops the goal
 * aborts too — the fold ships the goal or it does not ship.
 */
export function verifyOrRepair(
  summary: string,
  facts: ContinuationFacts,
  maxChars: number,
): VerifyOutcome {
  const first = verifyCompactionSummary(summary, facts);
  if (first.supported)
    return { summary, repaired: false, aborted: false, misses: [] };
  if (first.misses.some((m) => m.kind === "contradiction"))
    return { summary, repaired: false, aborted: true, misses: first.misses };

  const repairedFull = repairSummary(summary, facts, first.misses);
  const repaired =
    repairedFull.length > maxChars
      ? repairedFull.slice(0, maxChars)
      : repairedFull;
  const second = verifyCompactionSummary(repaired, facts);
  if (
    second.misses.some((m) => m.kind === "contradiction" || m.kind === "goal")
  )
    return { summary, repaired: false, aborted: true, misses: first.misses };
  return {
    summary: repaired,
    repaired: true,
    aborted: false,
    misses: first.misses,
  };
}
