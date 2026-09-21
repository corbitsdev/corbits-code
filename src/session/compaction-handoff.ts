// Copyright (c) 2026 ABK Labs. All rights reserved.
//
// SPDX-License-Identifier: GPL-2.0-only WITH AI-Exception-1.0
//
// CL-8744: fat handoff file + thin live spine with pointer.
//
// A fold writes two things instead of one inline summary:
//   - a fat structured handoff file (goal, constraints, decisions, evidence
//     markers, files/commands, verification, dead ends, next actions, plus a
//     verbatim exact-facts appendix), persisted as a context-store blob by the
//     reactor under one STABLE key that every fold overwrites;
//   - a thin spine that stays in the live prompt: goal one-liner, top
//     constraints/decisions, a cumulative evidence echo, and an explicit
//     pointer (tool-output:/// URI) so the agent can re-read the full file
//     when a detail is missing.
//
// Everything the file carries is copied verbatim out of the folded turns —
// never paraphrased — so exact-required facts (paths, commands, counts, user
// decisions) survive the fold. Each fold's file merges fresh verbatim detail
// with the prior spine's carried facts (iterative fold) instead of stacking
// competing summaries: the spine format below starts with COMPACTED_PREFIX,
// so the compactor's existing foldable-handoff detection picks it up and it
// never becomes an anchor.
//
// STABILITY CONTRACT (why the spine prefers carried facts): the completeness
// gate only accepts a fold when every dropped text either persists verbatim
// in the output or is byte-identical to an archived occurrence. A prior spine
// is dropped text, so the next spine must be byte-identical to it — the spine
// renders carried facts first and only falls back to fresh extraction when no
// prior spine is folded (the first fold). Fresh discoveries still accumulate
// in the fat file every fold; the spine is the stable anchor and the pointer
// is how the agent reaches anything new. The cumulative evidence echo is the
// one spine line that only grows (a sorted union), so new markers surface
// live while prose detail waits one re-read away.

import { ArkErrors, type } from "arktype";
import type { ConversationTurn, StrategyBlob } from "@intx/types/runtime";

// Canonical home of the fold marker. compactor.ts re-exports it so existing
// importers keep working; this module owns the literal.
export const COMPACTED_PREFIX = "[Compacted prior context]";

// Stable blob key for the fat handoff file. Every fold overwrites the same
// "latest" file (a per-fold unique key would make each spine novel, and a
// novel spine is dropped text the completeness gate must reject). Cumulative
// content means no verbatim fact is lost by the overwrite — only per-fold
// prose snapshots, which the spine never carried anyway.
export const HANDOFF_LATEST_KEY = "compaction-handoff-latest.md";

// Structured handoff artifact: the fat file's sections. Every entry is a
// verbatim excerpt from the folded turns (or carried verbatim from a prior
// spine), never a paraphrase.
export const HandoffArtifact = type({
  version: "'1'",
  goal: "string",
  constraints: "string[]",
  decisions: "string[]",
  evidenceMarkers: "string[]",
  files: "string[]",
  commands: "string[]",
  verification: "string[]",
  deadEnds: "string[]",
  nextActions: "string[]",
  exactFacts: "string[]",
});
export type HandoffArtifact = typeof HandoffArtifact.infer;

const MAX_GOAL_CHARS = 500;
const MAX_ITEM_CHARS = 300;
const MAX_COMMAND_CHARS = 300;
const MAX_FILES = 40;
const MAX_COMMANDS = 20;
const MAX_DECISIONS = 8;
const MAX_CONSTRAINTS = 8;
const MAX_DEAD_ENDS = 5;
const MAX_VERIFICATION = 10;
const MAX_NEXT_ACTIONS = 8;
const MAX_EXACT_FACTS = 40;
const MAX_SPINE_ITEMS = 3;
const MAX_SPINE_ITEM_CHARS = 80;
const SPINE_GOAL_CHARS = 160;

// User-text lines carrying an obligation or restriction read as constraints.
// Matched case-insensitively; the line itself is kept verbatim.
const CONSTRAINT_SIGNAL =
  /\bmust\b|\bnever\b|\balways\b|\bonly\b|requir\w*|constraint|\bdo not\b|don't|cannot|can't|should/i;

// Shell invocations worth recording verbatim for replay or audit.
const VERIFICATION_SIGNAL = /test|check|lint|build|typecheck|verify/i;

// Evidence echo tokens, e.g. [[evidence:decision|operator:correction|west]].
// Recovered verbatim out of folded text so exact facts survive paraphrase.
// The class excludes brackets and newlines so a truncation-cut token (no
// closing brackets on its line) can never pair with a later `]]` and swallow
// the lines between.
const EVIDENCE_TOKEN = /\[\[evidence:[^[\]\r\n]+\]\]/g;

function oneLine(text: string, maxChars: number): string {
  return text.replace(/\s+/g, " ").trim().slice(0, maxChars);
}

function textBlocks(turn: ConversationTurn): string[] {
  return turn.content.flatMap((block) =>
    block.type === "text" && block.text.length > 0 ? [block.text] : [],
  );
}

function userTexts(turn: ConversationTurn): string[] {
  if (turn.role !== "user") return [];
  return textBlocks(turn);
}

function isPriorSpineTurn(turn: ConversationTurn): boolean {
  if (turn.role !== "user") return false;
  const first = turn.content.find((block) => block.type === "text");
  return (
    first !== undefined &&
    first.type === "text" &&
    first.text.startsWith(COMPACTED_PREFIX)
  );
}

/** Sorted union of every evidence token across the given texts. */
export function recoverEvidenceMarkers(texts: readonly string[]): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(EVIDENCE_TOKEN)) found.add(match[0]);
  }
  return [...found].sort();
}

function toolCalls(turn: ConversationTurn): {
  id: string;
  name: string;
  args: Record<string, unknown>;
}[] {
  return turn.content.flatMap((block) => {
    if (block.type !== "tool_call") return [];
    const args =
      block.arguments !== null && typeof block.arguments === "object"
        ? (block.arguments as Record<string, unknown>)
        : {};
    return [{ id: block.id, name: block.name, args }];
  });
}

function toolResults(turn: ConversationTurn): {
  callId: string;
  isError: boolean;
  text: string;
}[] {
  return turn.content.flatMap((block) => {
    if (block.type !== "tool_result") return [];
    const text = block.content
      .flatMap((entry) =>
        entry.type === "text" && entry.text.length > 0 ? [entry.text] : [],
      )
      .join("\n");
    return [{ callId: block.callId, isError: block.isError === true, text }];
  });
}

function pushCapped(
  list: string[],
  value: string,
  cap: number,
  maxChars = MAX_ITEM_CHARS,
): void {
  const clean = value.trim();
  if (clean.length === 0 || list.length >= cap) return;
  const item =
    clean.length > maxChars ? `${clean.slice(0, maxChars)}...` : clean;
  if (!list.includes(item)) list.push(item);
}

export interface CarriedFacts {
  goal: string | undefined;
  constraints: string[];
  decisions: string[];
  evidenceMarkers: string[];
}

// Parse a prior thin spine back into carried facts so the next file merges
// prior + fresh verbatim (iterative fold) instead of stacking summaries, and
// the next spine renders the same bytes (fixed point the gate accepts).
function parseSpineText(text: string): CarriedFacts {
  const carried: CarriedFacts = {
    goal: undefined,
    constraints: [],
    decisions: [],
    evidenceMarkers: [],
  };
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("Goal: ")) {
      const goal = trimmed.slice("Goal: ".length).trim();
      if (goal.length > 0) carried.goal = goal;
    } else if (trimmed.startsWith("Constraints: ")) {
      for (const constraint of trimmed
        .slice("Constraints: ".length)
        .split(" | ")) {
        pushCapped(carried.constraints, constraint, MAX_CONSTRAINTS);
      }
    } else if (trimmed.startsWith("Decisions: ")) {
      for (const decision of trimmed.slice("Decisions: ".length).split(" | ")) {
        pushCapped(carried.decisions, decision, MAX_DECISIONS);
      }
    }
    // Evidence tokens ride every line (goal/constraints/decisions echo them),
    // so recover them from the whole spine text rather than one line.
    for (const marker of recoverEvidenceMarkers([trimmed])) {
      if (!carried.evidenceMarkers.includes(marker))
        carried.evidenceMarkers.push(marker);
    }
  }
  carried.evidenceMarkers.sort();
  return carried;
}

// The spine renders carried facts first (stability); the file merges fresh +
// carried (cumulative detail). A carried entry that is a prefix of a fresh
// entry is a truncation artifact of the 80-char spine render, not a distinct
// fact, so the merge drops it in favor of the full fresh text.
function mergeFreshCarried(
  fresh: string[],
  carried: string[],
  cap: number,
  maxChars = MAX_ITEM_CHARS,
): string[] {
  const merged = [...fresh];
  for (const item of carried) {
    if (merged.some((entry) => entry === item || entry.startsWith(item)))
      continue;
    pushCapped(merged, item, cap, maxChars);
  }
  return merged;
}

/** The carry-preferred facts the thin spine renders (see stability note). */
export interface SpineFacts {
  goal: string;
  constraints: string[];
  decisions: string[];
  evidenceMarkers: string[];
}

export interface ExtractedHandoff {
  /** Cumulative file content: fresh verbatim plus carried prior facts. */
  artifact: HandoffArtifact;
  /** Stable spine selection: carried first, fresh only without a prior spine. */
  spine: SpineFacts;
}

/**
 * Build the structured handoff artifact from the folded turn region plus the
 * fold's own summary narrative. Deterministic and verbatim: paths, commands,
 * counts, evidence markers, and user decisions are copied out of the turns,
 * never rewritten, so they survive paraphrase in the file. Prior spine turns
 * contribute their carried facts and are otherwise skipped (a spine restating
 * the folded region would double-count its own echo as fresh evidence).
 */
export function extractHandoffArtifact(
  foldedTurns: readonly ConversationTurn[],
  narrative: string,
): ExtractedHandoff {
  const carried: CarriedFacts = {
    goal: undefined,
    constraints: [],
    decisions: [],
    evidenceMarkers: [],
  };
  const freshUserTexts: string[] = [];
  const files: string[] = [];
  const commands: { id: string; command: string }[] = [];
  const resultsByCallId = new Map<string, { isError: boolean; text: string }>();
  const deadEnds: string[] = [];
  const freshConstraints: string[] = [];

  for (const turn of foldedTurns) {
    if (isPriorSpineTurn(turn)) {
      const parsed = parseSpineText(textBlocks(turn).join("\n"));
      if (carried.goal === undefined) carried.goal = parsed.goal;
      for (const constraint of parsed.constraints)
        pushCapped(carried.constraints, constraint, MAX_CONSTRAINTS);
      for (const decision of parsed.decisions)
        pushCapped(carried.decisions, decision, MAX_DECISIONS);
      for (const marker of parsed.evidenceMarkers) {
        if (!carried.evidenceMarkers.includes(marker))
          carried.evidenceMarkers.push(marker);
      }
      continue;
    }
    for (const text of userTexts(turn)) freshUserTexts.push(text);
    for (const call of toolCalls(turn)) {
      const path = call.args["path"] ?? call.args["file"];
      if (typeof path === "string" && path.length > 0)
        pushCapped(files, path, MAX_FILES);
      const command = call.args["command"];
      if (typeof command === "string") {
        const commandLine = oneLine(command, MAX_COMMAND_CHARS);
        if (
          commandLine.length > 0 &&
          commands.length < MAX_COMMANDS &&
          !commands.some((entry) => entry.command === commandLine)
        )
          commands.push({ id: call.id, command: commandLine });
      }
    }
    for (const result of toolResults(turn)) {
      resultsByCallId.set(result.callId, {
        isError: result.isError,
        text: result.text,
      });
      if (result.isError && result.text.length > 0)
        pushCapped(deadEnds, result.text, MAX_DEAD_ENDS);
    }
  }

  const nonEmptyUserTexts = freshUserTexts.filter(
    (text) => text.trim().length > 0,
  );
  // The carried goal wins so the spine survives the next fold byte-identical;
  // the fresh text that loses still lands in decisions below, never dropped.
  const goal =
    carried.goal ??
    (nonEmptyUserTexts.length > 0
      ? oneLine(nonEmptyUserTexts[0] ?? "", MAX_GOAL_CHARS)
      : "Unknown (no user message in folded turns)");
  const goalFromFreshIndex = carried.goal === undefined ? 0 : -1;

  const freshDecisions: string[] = [];
  nonEmptyUserTexts.forEach((text, index) => {
    if (index === goalFromFreshIndex) return;
    // A fresh text restating the carried goal is the same fact the spine
    // already anchors on, not a new decision — keeping it would grow a
    // Decisions line the prior spine lacks and break the fixed point.
    if (
      carried.goal !== undefined &&
      oneLine(text, SPINE_GOAL_CHARS) === carried.goal
    )
      return;
    if (freshDecisions.length >= MAX_DECISIONS) return;
    pushCapped(freshDecisions, oneLine(text, MAX_ITEM_CHARS), MAX_DECISIONS);
  });

  for (const text of nonEmptyUserTexts) {
    if (freshConstraints.length >= MAX_CONSTRAINTS) break;
    for (const line of text.split("\n")) {
      if (CONSTRAINT_SIGNAL.test(line))
        pushCapped(
          freshConstraints,
          oneLine(line, MAX_ITEM_CHARS),
          MAX_CONSTRAINTS,
        );
      if (freshConstraints.length >= MAX_CONSTRAINTS) break;
    }
  }

  const verification: string[] = [];
  for (const { id, command } of commands) {
    if (verification.length >= MAX_VERIFICATION) break;
    if (!VERIFICATION_SIGNAL.test(command)) continue;
    const result = resultsByCallId.get(id);
    if (result === undefined) {
      pushCapped(verification, `UNRESOLVED: ${command}`, MAX_VERIFICATION, 400);
    } else if (result.isError) {
      const firstLine = oneLine(result.text.split("\n")[0] ?? "", 200);
      pushCapped(
        verification,
        `FAIL: ${command} — ${firstLine}`,
        MAX_VERIFICATION,
        500,
      );
    } else {
      pushCapped(verification, `PASS: ${command}`, MAX_VERIFICATION, 400);
    }
  }

  const lastUserText = [...nonEmptyUserTexts].pop();
  const nextActions: string[] = [];
  if (
    lastUserText !== undefined &&
    oneLine(lastUserText, MAX_GOAL_CHARS) !== goal
  )
    pushCapped(
      nextActions,
      oneLine(lastUserText, MAX_ITEM_CHARS),
      MAX_NEXT_ACTIONS,
    );

  const mergedConstraints = mergeFreshCarried(
    freshConstraints,
    carried.constraints,
    MAX_CONSTRAINTS,
  );
  const mergedDecisions = mergeFreshCarried(
    freshDecisions,
    carried.decisions,
    MAX_DECISIONS,
  );
  const evidenceMarkers = recoverEvidenceMarkers([
    ...foldedTurns.flatMap((turn) => textBlocks(turn)),
    narrative,
  ]);

  let toolCallCount = 0;
  for (const turn of foldedTurns) toolCallCount += toolCalls(turn).length;

  const exactFacts: string[] = [
    `goal: ${oneLine(goal, 160)}`,
    `evidence: ${evidenceMarkers.join(" ") || "(none)"}`,
    `turns: ${foldedTurns.length}, tool calls: ${toolCallCount}`,
  ];
  const mergedFiles = [...files];
  if (mergedFiles.length > 0)
    pushCapped(
      exactFacts,
      `paths: ${mergedFiles.join(", ")}`,
      MAX_EXACT_FACTS,
      2000,
    );
  const mergedCommands = commands.map((entry) => entry.command);
  if (mergedCommands.length > 0)
    pushCapped(
      exactFacts,
      `commands: ${mergedCommands.join("; ")}`,
      MAX_EXACT_FACTS,
      2000,
    );
  for (const decision of mergedDecisions)
    pushCapped(
      exactFacts,
      `user decision: ${oneLine(decision, 200)}`,
      MAX_EXACT_FACTS,
      300,
    );

  const checked = HandoffArtifact({
    version: "1",
    goal,
    constraints: mergedConstraints,
    decisions: mergedDecisions,
    evidenceMarkers,
    files: mergedFiles,
    commands: mergedCommands,
    verification,
    deadEnds,
    nextActions,
    exactFacts,
  });
  if (checked instanceof ArkErrors)
    throw new Error(`Invalid handoff artifact: ${String(checked)}`);
  return {
    artifact: checked,
    spine: {
      goal,
      constraints:
        carried.constraints.length > 0 ? carried.constraints : freshConstraints,
      decisions:
        carried.decisions.length > 0 ? carried.decisions : freshDecisions,
      evidenceMarkers,
    },
  };
}

function section(title: string, items: readonly string[]): string {
  if (items.length === 0) return `## ${title}\n(none)`;
  return `## ${title}\n${items.map((item) => `- ${item}`).join("\n")}`;
}

/**
 * Render the fat handoff file. The narrative is the fold's own summary
 * (model-written, may paraphrase); the Exact facts appendix below it is
 * verbatim and is what later folds must preserve.
 */
export function renderHandoffFile(
  artifact: HandoffArtifact,
  narrative: string,
  pointerUri: string,
): string {
  return [
    "# Compaction handoff",
    "",
    `Full detail lives here; the live prompt carries only the spine plus this pointer: ${pointerUri}`,
    "",
    `## Goal\n${artifact.goal}`,
    section("Constraints", artifact.constraints),
    section("Decisions", artifact.decisions),
    section("Evidence markers (cumulative echo)", artifact.evidenceMarkers),
    `## Files and commands\n${section("Files", artifact.files)}\n${section("Commands", artifact.commands)}`,
    section("Verification", artifact.verification),
    section("Dead ends", artifact.deadEnds),
    section("Next actions", artifact.nextActions),
    `## Summary (this fold — may paraphrase)\n${narrative.trim().length > 0 ? narrative.trim() : "(none)"}`,
    `## Exact facts (verbatim — do not paraphrase)\n${artifact.exactFacts.map((fact) => `- ${fact}`).join("\n")}`,
  ].join("\n");
}

/**
 * Render the thin live spine. Stays short and byte-stable across folds:
 * goal, carried constraints/decisions, the cumulative evidence echo, and the
 * explicit file pointer. Starts with COMPACTED_PREFIX so the next fold
 * treats it as a foldable handoff turn. Counts, file lists, and next actions
 * stay in the fat file — they change every fold and would make each spine
 * novel (dropped novel text is what the completeness gate rejects).
 */
export function renderHandoffSpine(
  spine: SpineFacts,
  pointerUri: string,
): string {
  const lines = [
    COMPACTED_PREFIX,
    `Goal: ${oneLine(spine.goal, SPINE_GOAL_CHARS)}`,
  ];
  if (spine.constraints.length > 0)
    lines.push(
      `Constraints: ${spine.constraints
        .slice(0, MAX_SPINE_ITEMS)
        .map((constraint) => oneLine(constraint, MAX_SPINE_ITEM_CHARS))
        .join(" | ")}`,
    );
  if (spine.decisions.length > 0)
    lines.push(
      `Decisions: ${spine.decisions
        .slice(0, MAX_SPINE_ITEMS)
        .map((decision) => oneLine(decision, MAX_SPINE_ITEM_CHARS))
        .join(" | ")}`,
    );
  lines.push(
    `Evidence: ${spine.evidenceMarkers.length > 0 ? spine.evidenceMarkers.join(" ") : "(none)"}`,
  );
  lines.push(
    `Handoff: ${pointerUri} — re-read with read_file (offset/limit) for full detail: decisions, verification, dead ends, next actions.`,
  );
  return lines.join("\n");
}

/** Re-readable pointer for the spine: read_file resolves this via the blob store. */
export function handoffBlobUri(key: string): string {
  return `tool-output:///${key}`;
}

export interface HandoffFold {
  artifact: HandoffArtifact;
  /** Thin live spine: the only handoff text that stays in the prompt. */
  spineText: string;
  /** Fat file packaged as a context-store blob the reactor persists. */
  blob: StrategyBlob;
}

/**
 * Build one fold's handoff: extract the verbatim artifact from the folded
 * turns, render the fat file under the stable latest key, and return the
 * thin spine carrying the file's pointer.
 */
export function buildHandoffFold(
  foldedTurns: readonly ConversationTurn[],
  narrative: string,
): HandoffFold {
  const { artifact, spine } = extractHandoffArtifact(foldedTurns, narrative);
  const uri = handoffBlobUri(HANDOFF_LATEST_KEY);
  const fileText = renderHandoffFile(artifact, narrative, uri);
  return {
    artifact,
    spineText: renderHandoffSpine(spine, uri),
    blob: {
      key: HANDOFF_LATEST_KEY,
      bytes: new TextEncoder().encode(fileText),
      contentType: "text/markdown",
    },
  };
}
