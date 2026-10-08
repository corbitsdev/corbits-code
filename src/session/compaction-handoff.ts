// Copyright (c) 2026 ABK Labs. All rights reserved.
//
// SPDX-License-Identifier: GPL-2.0-only WITH AI-Exception-2.0
//
// A fold writes a fat structured handoff file (the HandoffArtifact sections)
// under one STABLE key every fold overwrites, plus a thin spine in the live
// prompt: goal cut at a token boundary, standing output tokens uncut, top
// constraints/decisions, cumulative evidence echo, activated tools, and a
// tool-output:/// pointer back to the file.
//
// Everything carried is verbatim out of the folded turns — never paraphrased —
// so exact facts survive; each fold unions the prior file with fresh detail.
// The spine starts with COMPACTED_PREFIX so the compactor's foldable-handoff
// detection picks it up. A dropped prior spine passes the completeness gate
// only when its bytes are archived as a user_message or still verbatim in the
// output.

import { ArkErrors, type } from "arktype";
import type { ConversationTurn, StrategyBlob } from "@intx/types/runtime";
import { VERIFY_REPAIR_HEADING } from "./compaction-verify.js";

// Canonical home of the fold marker. compactor.ts re-exports it; this module
// owns the literal.
export const COMPACTED_PREFIX = "[Compacted prior context]";

// Stable blob key for the fat handoff file; every fold overwrites the same
// key.
export const HANDOFF_LATEST_KEY = "compaction-handoff-latest.md";

const HANDOFF_TOOLS_LINE_PREFIX =
  "Tools still activated and callable directly (no tool_search needed): ";
const HANDOFF_OUTPUT_LINE_PREFIX = "Output: ";

// The fat file's sections; every entry is verbatim.
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
const SPINE_CUT_SENTINEL = "...";

// User-text lines carrying an obligation or restriction read as constraints.
// `should` / `only` are too common in ordinary prose to be a signal.
const CONSTRAINT_SIGNAL =
  /\bmust\b|\bnever\b|\balways\b|requir\w*|constraint|\bdo not\b|don't|cannot|can't/i;

// Shell invocations worth recording verbatim for replay or audit.
const VERIFICATION_SIGNAL = /test|check|lint|build|typecheck|verify/i;

// Evidence echo tokens ([[evidence:...]]). Excludes brackets and newlines so
// a truncation-cut token (no closing bracket on its line) can never pair with
// a later `]]` and swallow the lines between.
const EVIDENCE_TOKEN = /\[\[evidence:[^[\]\r\n]+\]\]/g;

// Standing reply-contract tokens (FILES_DONE=...). The spine and file goal
// keep these whole — a char slice makes them FILES_DO. Harvest from the
// uncapped source so a cap cannot drop a token starting just past the cut.
function outputFormatTokenRe(): RegExp {
  return /\b[A-Z][A-Z0-9_]+=\S+/g;
}

function oneLine(text: string, maxChars: number): string {
  return text.replace(/\s+/g, " ").trim().slice(0, maxChars);
}

function outputFormatTokens(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(outputFormatTokenRe())) {
    const token = match[0];
    if (token !== undefined && !found.includes(token)) found.push(token);
  }
  return found;
}

function capGoal(text: string, maxChars: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  const tokens = outputFormatTokens(line);
  let end = Math.min(maxChars, line.length);
  for (const match of line.matchAll(outputFormatTokenRe())) {
    const start = match.index ?? 0;
    const tokenEnd = start + match[0].length;
    if (start < end && tokenEnd > end) end = tokenEnd;
  }
  let capped = line.slice(0, end);
  const present = new Set(outputFormatTokens(capped));
  for (const token of tokens) {
    if (present.has(token)) continue;
    capped = `${capped} ${token}`;
    present.add(token);
  }
  return capped;
}

function hasStandingOutputToken(goal: string, token: string): boolean {
  return outputFormatTokens(goal).includes(token);
}

function trailingEllipsisIsStandingToken(goal: string): boolean {
  if (!goal.endsWith(SPINE_CUT_SENTINEL)) return false;
  return outputFormatTokens(goal).some(
    (token) => token.endsWith(SPINE_CUT_SENTINEL) && goal.endsWith(token),
  );
}

function mergeStandingOutputToken(
  goal: string | undefined,
  token: string,
): string {
  if (goal === undefined || goal.length === 0) return token;
  if (hasStandingOutputToken(goal, token)) return goal;
  // cutSpineGoal glues "..." onto a start-at-0 token over the cap; the token
  // regex eats that sentinel, so Goal's token is token+"..." and never equals
  // Output's. Strip the glued sentinel and keep the standing token once, even
  // when it already ends with "...".
  if (goal.endsWith(SPINE_CUT_SENTINEL)) {
    const prefix = goal.slice(0, -SPINE_CUT_SENTINEL.length);
    if (
      hasStandingOutputToken(prefix, token) ||
      outputFormatTokens(goal).includes(`${token}${SPINE_CUT_SENTINEL}`)
    )
      return prefix;
  }
  const prefix =
    goal.endsWith(SPINE_CUT_SENTINEL) && !trailingEllipsisIsStandingToken(goal)
      ? goal.slice(0, -SPINE_CUT_SENTINEL.length)
      : goal;
  return `${prefix} ${token}`;
}

function cutSpineGoal(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= SPINE_GOAL_CHARS) return line;
  // A prior spine cut already ended with the sentinel and sits at the cap.
  // Recutting a 159-char spaceless prefix plus "..." eats the first dot and
  // glues another sentinel, growing "..." into "....".
  if (line.endsWith(SPINE_CUT_SENTINEL)) {
    const without = line.slice(0, -SPINE_CUT_SENTINEL.length);
    if (without.length <= SPINE_GOAL_CHARS) return line;
  }
  let cap = SPINE_GOAL_CHARS;
  for (const match of line.matchAll(outputFormatTokenRe())) {
    const start = match.index ?? 0;
    const tokenEnd = start + match[0].length;
    if (start < SPINE_GOAL_CHARS && tokenEnd > SPINE_GOAL_CHARS) {
      if (start === 0) {
        const kept = match[0];
        return kept.length < line.length
          ? `${kept}${SPINE_CUT_SENTINEL}`
          : kept;
      }
      cap = start;
      break;
    }
  }
  const head = line.slice(0, cap);
  const lastSpace = head.lastIndexOf(" ");
  const kept = lastSpace > 0 ? head.slice(0, lastSpace) : head.trimEnd();
  if (kept.length === 0) return SPINE_CUT_SENTINEL;
  return `${kept}${SPINE_CUT_SENTINEL}`;
}

function cutSpineItem(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= MAX_SPINE_ITEM_CHARS) return line;
  return `${line.slice(0, MAX_SPINE_ITEM_CHARS)}${SPINE_CUT_SENTINEL}`;
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

function turnEvidenceTexts(turn: ConversationTurn): string[] {
  return [
    ...textBlocks(turn),
    ...toolResults(turn).map((result) => result.text),
  ];
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
  activatedTools: string[];
}

function emptyCarried(): CarriedFacts {
  return {
    goal: undefined,
    constraints: [],
    decisions: [],
    evidenceMarkers: [],
    activatedTools: [],
  };
}

// Parse a prior thin spine back into carried facts so the next fold unions
// prior + fresh verbatim.
function parseSpineText(text: string): CarriedFacts {
  const carried = emptyCarried();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("Goal: ")) {
      // Keep operator-authored trailing "..." (Fix the tests...,
      // FILES_DONE=src/foo...). The spine cut sentinel is stripped only when
      // mergeStandingOutputToken restores an Output token onto a truncated
      // Goal prefix.
      const goal = trimmed.slice("Goal: ".length).trim();
      if (goal.length > 0) carried.goal = goal;
    } else if (trimmed.startsWith(HANDOFF_OUTPUT_LINE_PREFIX)) {
      for (const token of outputFormatTokens(
        trimmed.slice(HANDOFF_OUTPUT_LINE_PREFIX.length),
      )) {
        carried.goal = mergeStandingOutputToken(carried.goal, token);
      }
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
    } else if (trimmed.startsWith(HANDOFF_TOOLS_LINE_PREFIX)) {
      for (const name of trimmed
        .slice(HANDOFF_TOOLS_LINE_PREFIX.length)
        .split(", ")) {
        const tool = name.trim();
        if (tool.length > 0 && !carried.activatedTools.includes(tool))
          carried.activatedTools.push(tool);
      }
    }
    for (const marker of recoverEvidenceMarkers([trimmed])) {
      if (!carried.evidenceMarkers.includes(marker))
        carried.evidenceMarkers.push(marker);
    }
  }
  carried.evidenceMarkers.sort();
  return carried;
}

const HANDOFF_SCHEMA_HEADINGS = new Set([
  "Goal",
  "Constraints",
  "Decisions",
  "Evidence markers (cumulative echo)",
  "Files",
  "Commands",
  "Verification",
  "Dead ends",
  "Next actions",
  "Exact facts (verbatim — do not paraphrase)",
]);

const HANDOFF_SUMMARY_HEADING = "Summary (this fold — may paraphrase)";
const HANDOFF_EXACT_FACTS_HEADING =
  "Exact facts (verbatim — do not paraphrase)";

function listItems(body: string): string[] {
  if (body.length === 0 || body === "(none)") return [];
  const items: string[] = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("- ")) continue;
    const item = trimmed.slice(2).trim();
    if (item.length > 0 && item !== "(none)") items.push(item);
  }
  return items;
}

/** Parse a previously written fat handoff file into structured sections. */
function parseHandoffFile(text: string): Partial<HandoffArtifact> {
  const sections = new Map<string, string[]>();
  let current: string | undefined;
  let inSummary = false;
  for (const line of text.split("\n")) {
    const heading = /^## (.+)$/.exec(line);
    if (heading !== null) {
      const title = (heading[1] ?? "").trim();
      if (title === HANDOFF_SUMMARY_HEADING) {
        inSummary = true;
        current = undefined;
        continue;
      }
      if (title === HANDOFF_EXACT_FACTS_HEADING) inSummary = false;
      if (inSummary || !HANDOFF_SCHEMA_HEADINGS.has(title)) {
        current = undefined;
        continue;
      }
      if (sections.has(title)) {
        current = undefined;
        continue;
      }
      current = title;
      sections.set(title, []);
      continue;
    }
    if (current !== undefined) sections.get(current)?.push(line);
  }

  const body = (title: string): string =>
    (sections.get(title) ?? []).join("\n").trim();
  const maybeList = (title: string): string[] | undefined => {
    const items = listItems(body(title));
    return items.length > 0 ? items : undefined;
  };
  const goal = body("Goal");
  const constraints = maybeList("Constraints");
  const decisions = maybeList("Decisions");
  const evidenceMarkers = maybeList("Evidence markers (cumulative echo)");
  const files = maybeList("Files");
  const commands = maybeList("Commands");
  const verification = maybeList("Verification");
  const deadEnds = maybeList("Dead ends");
  const nextActions = maybeList("Next actions");
  const exactFacts = maybeList(HANDOFF_EXACT_FACTS_HEADING);
  return {
    ...(goal.length > 0 && goal !== "(none)" ? { goal } : {}),
    ...(constraints !== undefined ? { constraints } : {}),
    ...(decisions !== undefined ? { decisions } : {}),
    ...(evidenceMarkers !== undefined ? { evidenceMarkers } : {}),
    ...(files !== undefined ? { files } : {}),
    ...(commands !== undefined ? { commands } : {}),
    ...(verification !== undefined ? { verification } : {}),
    ...(deadEnds !== undefined ? { deadEnds } : {}),
    ...(nextActions !== undefined ? { nextActions } : {}),
    ...(exactFacts !== undefined ? { exactFacts } : {}),
  };
}

// Prefer full prior-file text over a spine-truncated prefix of the same fact;
// production prior text is full, so `Must never write to /tmp` and
// `.../tmp/cache` stay distinct even when the shorter fact is naturally 80
// chars. Prefix collapse applies only to cuts marked SPINE_CUT_SENTINEL.
function isSpineTruncationOf(fragment: string, full: string): boolean {
  if (!fragment.endsWith(SPINE_CUT_SENTINEL)) return false;
  const prefix = fragment.slice(0, -SPINE_CUT_SENTINEL.length);
  return (
    prefix.length === MAX_SPINE_ITEM_CHARS &&
    full.length > prefix.length &&
    full.startsWith(prefix)
  );
}

function mergeUnique(
  primary: readonly string[],
  extra: readonly string[],
  cap: number,
  maxChars = MAX_ITEM_CHARS,
  mode: "prefix" | "exact" = "exact",
): string[] {
  const merged: string[] = [];
  const consider = (raw: string): void => {
    const clean = raw.trim();
    if (clean.length === 0) return;
    const item =
      clean.length > maxChars ? `${clean.slice(0, maxChars)}...` : clean;
    const related = merged.findIndex((entry) =>
      mode === "exact"
        ? entry === item
        : entry === item ||
          isSpineTruncationOf(item, entry) ||
          isSpineTruncationOf(entry, item),
    );
    if (related >= 0) {
      const existing = merged[related];
      // Cuts are 83 chars (80 + "..."). Longer-string-wins would replace an
      // 81- or 82-char complete fact with that cut and drop the last chars.
      if (existing !== undefined && isSpineTruncationOf(existing, item))
        merged[related] = item;
      return;
    }
    if (merged.length >= cap) return;
    merged.push(item);
  };
  for (const value of primary) consider(value);
  for (const value of extra) consider(value);
  return merged;
}

function preferFull(prior: string | undefined, next: string): string {
  if (prior === undefined || prior.length === 0) return next;
  if (prior === next || prior.startsWith(next) || next.startsWith(prior))
    return prior.length >= next.length ? prior : next;
  return prior;
}

/** The facts the thin spine renders. */
export interface SpineFacts {
  goal: string;
  constraints: string[];
  decisions: string[];
  evidenceMarkers: string[];
  activatedTools: string[];
}

export interface ExtractedHandoff {
  /** Cumulative file content: prior file union fresh verbatim. */
  artifact: HandoffArtifact;
  /** Live spine: carried facts plus newly discovered tokens. */
  spine: SpineFacts;
}

export interface HandoffExtractOpts {
  /** Previous compaction-handoff-latest.md body, when the blob is readable. */
  priorFileText?: string;
  /** Live activated-tool names; omitted means reuse the prior spine's list. */
  activatedTools?: readonly string[];
}

/**
 * Build the artifact from the folded turns plus the fold's own summary.
 * Prior spine turns contribute their carried facts and are skipped so the
 * spine is not double-counted as a fresh turn.
 */
export function extractHandoffArtifact(
  foldedTurns: readonly ConversationTurn[],
  narrative: string,
  opts?: HandoffExtractOpts,
): ExtractedHandoff {
  const carried = emptyCarried();
  const priorFile =
    opts?.priorFileText !== undefined && opts.priorFileText.length > 0
      ? parseHandoffFile(opts.priorFileText)
      : {};
  const freshUserTexts: string[] = [];
  const files: string[] = [];
  const commands: { id: string; command: string }[] = [];
  const resultsByCallId = new Map<string, { isError: boolean; text: string }>();
  const freshConstraints: string[] = [];
  let freshTurnCount = 0;
  let toolCallCount = 0;

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
      for (const tool of parsed.activatedTools) {
        if (!carried.activatedTools.includes(tool))
          carried.activatedTools.push(tool);
      }
      continue;
    }
    freshTurnCount += 1;
    for (const text of userTexts(turn)) freshUserTexts.push(text);
    for (const call of toolCalls(turn)) {
      toolCallCount += 1;
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
    }
  }

  const nonEmptyUserTexts = freshUserTexts.filter(
    (text) => text.trim().length > 0,
  );
  // A budgeted tail can lift every user turn out of the region, leaving no
  // fresh text to name the goal; fall back to the fold's summary before
  // Unknown so the next fold still names the work. Strip the verify-repair
  // appendix first: its exact file lists stay in the fat file, not the spine.
  const narrativeGoal = capGoal(
    narrative.split(VERIFY_REPAIR_HEADING)[0] ?? "",
    MAX_GOAL_CHARS,
  );
  const extractedGoal =
    carried.goal ??
    (nonEmptyUserTexts.length > 0
      ? capGoal(nonEmptyUserTexts[0] ?? "", MAX_GOAL_CHARS)
      : narrativeGoal.length > 0
        ? narrativeGoal
        : "Unknown (no user message in folded turns)");
  const goalFromFreshIndex = carried.goal === undefined ? 0 : -1;
  const fileGoal = preferFull(priorFile.goal, extractedGoal);

  const lastUserText = [...nonEmptyUserTexts].pop();
  const lastUserAsNext =
    lastUserText !== undefined &&
    capGoal(lastUserText, MAX_GOAL_CHARS) !== extractedGoal &&
    oneLine(lastUserText, SPINE_GOAL_CHARS) !== carried.goal;

  const freshDecisions: string[] = [];
  nonEmptyUserTexts.forEach((text, index) => {
    if (index === goalFromFreshIndex) return;
    if (lastUserAsNext && text === lastUserText) return;
    if (
      carried.goal !== undefined &&
      oneLine(text, SPINE_GOAL_CHARS) === carried.goal
    )
      return;
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

  const verificationCommandIds = new Set<string>();
  const freshVerification: string[] = [];
  for (const { id, command } of commands) {
    if (freshVerification.length >= MAX_VERIFICATION) break;
    if (!VERIFICATION_SIGNAL.test(command)) continue;
    const result = resultsByCallId.get(id);
    if (result === undefined) {
      pushCapped(
        freshVerification,
        `UNRESOLVED: ${command}`,
        MAX_VERIFICATION,
        400,
      );
    } else if (result.isError) {
      verificationCommandIds.add(id);
      const firstLine = oneLine(result.text.split("\n")[0] ?? "", 200);
      pushCapped(
        freshVerification,
        `FAIL: ${command} — ${firstLine}`,
        MAX_VERIFICATION,
        500,
      );
    } else {
      pushCapped(freshVerification, `PASS: ${command}`, MAX_VERIFICATION, 400);
    }
  }

  const freshDeadEnds: string[] = [];
  for (const [callId, result] of resultsByCallId) {
    if (
      result.isError &&
      result.text.length > 0 &&
      !verificationCommandIds.has(callId)
    )
      pushCapped(freshDeadEnds, result.text, MAX_DEAD_ENDS);
  }

  const nextActions: string[] = [];
  if (lastUserAsNext && lastUserText !== undefined)
    pushCapped(
      nextActions,
      oneLine(lastUserText, MAX_ITEM_CHARS),
      MAX_NEXT_ACTIONS,
    );

  const mergedConstraints = mergeUnique(
    mergeUnique(
      priorFile.constraints ?? [],
      carried.constraints,
      MAX_CONSTRAINTS,
      MAX_ITEM_CHARS,
      "prefix",
    ),
    freshConstraints,
    MAX_CONSTRAINTS,
  );
  const mergedDecisions = mergeUnique(
    mergeUnique(
      priorFile.decisions ?? [],
      carried.decisions,
      MAX_DECISIONS,
      MAX_ITEM_CHARS,
      "prefix",
    ),
    freshDecisions,
    MAX_DECISIONS,
  );
  const evidenceMarkers = recoverEvidenceMarkers([
    ...foldedTurns.flatMap((turn) => turnEvidenceTexts(turn)),
    narrative,
    ...(priorFile.evidenceMarkers ?? []),
  ]);
  const mergedFiles = mergeUnique(
    priorFile.files ?? [],
    files,
    MAX_FILES,
    MAX_ITEM_CHARS,
    "exact",
  );
  const mergedCommands = mergeUnique(
    priorFile.commands ?? [],
    commands.map((entry) => entry.command),
    MAX_COMMANDS,
    MAX_COMMAND_CHARS,
    "exact",
  );
  const mergedVerification = mergeUnique(
    priorFile.verification ?? [],
    freshVerification,
    MAX_VERIFICATION,
    500,
  );
  const mergedDeadEnds = mergeUnique(
    priorFile.deadEnds ?? [],
    freshDeadEnds,
    MAX_DEAD_ENDS,
  );
  const mergedNextActions = mergeUnique(
    nextActions,
    priorFile.nextActions ?? [],
    MAX_NEXT_ACTIONS,
  );

  const exactFacts: string[] = [
    `goal: ${oneLine(fileGoal, 160)}`,
    `evidence: ${evidenceMarkers.join(" ") || "(none)"}`,
    `turns: ${freshTurnCount}, tool calls: ${toolCallCount}`,
  ];
  if (mergedFiles.length > 0)
    pushCapped(
      exactFacts,
      `paths: ${mergedFiles.join(", ")}`,
      MAX_EXACT_FACTS,
      2000,
    );
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
    goal: fileGoal,
    constraints: mergedConstraints,
    decisions: mergedDecisions,
    evidenceMarkers,
    files: mergedFiles,
    commands: mergedCommands,
    verification: mergedVerification,
    deadEnds: mergedDeadEnds,
    nextActions: mergedNextActions,
    exactFacts,
  });
  if (checked instanceof ArkErrors)
    throw new Error(`Invalid handoff artifact: ${String(checked)}`);

  const activatedTools =
    opts?.activatedTools !== undefined
      ? [...opts.activatedTools]
      : [...carried.activatedTools];

  return {
    artifact: checked,
    spine: {
      goal: fileGoal,
      constraints: mergeUnique(
        carried.constraints,
        freshConstraints,
        MAX_CONSTRAINTS,
      ),
      decisions: mergeUnique(carried.decisions, freshDecisions, MAX_DECISIONS),
      evidenceMarkers,
      activatedTools,
    },
  };
}

function section(title: string, items: readonly string[]): string {
  if (items.length === 0) return `## ${title}\n(none)`;
  return `## ${title}\n${items.map((item) => `- ${item}`).join("\n")}`;
}

/**
 * Render the fat handoff file. The narrative is the fold's own summary
 * (model-written, may paraphrase); the Exact facts appendix is verbatim and
 * is what later folds must preserve.
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
    section("Files", artifact.files),
    section("Commands", artifact.commands),
    section("Verification", artifact.verification),
    section("Dead ends", artifact.deadEnds),
    section("Next actions", artifact.nextActions),
    `## Summary (this fold — may paraphrase)\n${narrative.trim().length > 0 ? narrative.trim() : "(none)"}`,
    `## Exact facts (verbatim — do not paraphrase)\n${artifact.exactFacts.map((fact) => `- ${fact}`).join("\n")}`,
  ].join("\n");
}

/**
 * Render the thin live spine: goal cut at a token boundary, standing output
 * tokens uncut, constraints/decisions, the evidence echo, activated tools,
 * and the file pointer. Starts with COMPACTED_PREFIX so the next fold parses
 * it as a handoff turn. Counts, file lists, and next actions stay in the fat
 * file.
 */
export function renderHandoffSpine(
  spine: SpineFacts,
  pointerUri: string,
): string {
  const lines = [COMPACTED_PREFIX, `Goal: ${cutSpineGoal(spine.goal)}`];
  const output = outputFormatTokens(spine.goal);
  if (output.length > 0)
    lines.push(`${HANDOFF_OUTPUT_LINE_PREFIX}${output.join(" ")}`);
  if (spine.constraints.length > 0)
    lines.push(
      `Constraints: ${spine.constraints
        .slice(0, MAX_SPINE_ITEMS)
        .map((constraint) => cutSpineItem(constraint))
        .join(" | ")}`,
    );
  if (spine.decisions.length > 0)
    lines.push(
      `Decisions: ${spine.decisions
        .slice(0, MAX_SPINE_ITEMS)
        .map((decision) => cutSpineItem(decision))
        .join(" | ")}`,
    );
  lines.push(
    `Evidence: ${spine.evidenceMarkers.length > 0 ? spine.evidenceMarkers.join(" ") : "(none)"}`,
  );
  if (spine.activatedTools.length > 0)
    lines.push(
      `${HANDOFF_TOOLS_LINE_PREFIX}${spine.activatedTools.join(", ")}`,
    );
  lines.push(
    `Handoff: ${pointerUri} — re-read with read_file (offset/limit) for the full operator ask, output contract, decisions, verification, dead ends, next actions.`,
  );
  return lines.join("\n");
}

/** Re-readable pointer for the spine: read_file resolves this via the blob store. */
export function handoffBlobUri(key: string): string {
  return `tool-output:///${key}`;
}

export async function tryReadPriorHandoffFile(
  readBlob: ((key: string) => Promise<Uint8Array>) | undefined,
): Promise<string | undefined> {
  if (readBlob === undefined) return undefined;
  try {
    return new TextDecoder().decode(await readBlob(HANDOFF_LATEST_KEY));
  } catch {
    return undefined;
  }
}

export interface HandoffFold {
  artifact: HandoffArtifact;
  /** Thin live spine: the only handoff text that stays in the prompt. */
  spineText: string;
  /** Fat file packaged as a context-store blob the reactor persists. */
  blob: StrategyBlob;
}

/**
 * Build one fold's handoff: extract the artifact from the folded turns
 * (unioned with the previous fat file when provided), render the fat file,
 * and return the thin spine carrying the file's pointer.
 */
export function buildHandoffFold(
  foldedTurns: readonly ConversationTurn[],
  narrative: string,
  opts?: HandoffExtractOpts,
): HandoffFold {
  const { artifact, spine } = extractHandoffArtifact(
    foldedTurns,
    narrative,
    opts,
  );
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
