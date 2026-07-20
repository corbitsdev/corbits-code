import type {
  ConversationTurn,
  InferenceOptions,
  ReactorAction,
  ReactorCapabilities,
} from "@intx/types/runtime";

export type GoalStatus =
  | "inactive"
  | "active"
  | "paused"
  | "achieved"
  | "cleared"
  | "budget_limited"
  | "blocked";

/**
 * Lifecycle phase for a live goal — orthogonal to autonomy status (paused /
 * budget_limited / blocked). Derived from acceptance checklist progress so the
 * UI can show Work during implement and Acceptance during review.
 *
 *   planning     → brief set, acceptance checklist not yet defined
 *   implementing → acceptance defined; work plan is the primary surface
 *   reviewing    → acceptance progress started (doing/done/blocked on any item)
 *   completed    → all non-cancelled criteria done (status usually achieved)
 */
export type GoalPhase = "planning" | "implementing" | "reviewing" | "completed";

export const GOAL_PHASES: readonly GoalPhase[] = [
  "planning",
  "implementing",
  "reviewing",
  "completed",
] as const;

/** One acceptance criterion in the expanded goal checklist. */
export type GoalCriterionStatus = "todo" | "doing" | "done" | "blocked" | "cancelled";

export type GoalCriterion = {
  id: string;
  /** Concrete, checkable success item — not a work step title. */
  title: string;
  status: GoalCriterionStatus;
  /** Optional evidence note when done/blocked. */
  note?: string;
};

export type GoalSnapshot = {
  status: GoalStatus;
  /**
   * Lifecycle phase derived from acceptance progress. Always present on values
   * returned from get()/emit(); may be absent on in-flight internal mutations
   * until the next attachPhase.
   */
  phase?: GoalPhase;
  /** Original operator brief from `/goal …` (not the expanded checklist). */
  brief: string;
  /** Expanded acceptance criteria — the real goal definition once planned. */
  criteria: GoalCriterion[];
  /**
   * Synthesized acceptance text for the evaluator / legacy paths.
   * Prefer `criteria` for UX and met checks when non-empty.
   */
  condition: string;
  startedAt: number;
  turnBudget: number;
  turnsUsed: number;
  tokenBudget?: number;
  mainTokens: number;
  evalTokens: number;
  lastReason?: string;
  consecutiveEvalFailures: number;
  consecutiveEmptyYields: number;
};

export type GoalEvaluateVerdict = {
  met: boolean;
  reason: string;
  /** Tokens spent on this evaluation call (input + output). */
  evalTokens?: number;
  /** True when the evaluator itself failed (network, parse, etc.). */
  error?: boolean;
};

export type GoalEvaluateArgs = {
  condition: string;
  evidence: string;
};

export type GoalEvaluateFn = (args: GoalEvaluateArgs) => Promise<GoalEvaluateVerdict>;

export type GoalSetOpts = {
  turnBudget?: number;
  tokenBudget?: number;
};

export type GoalResumeOpts = {
  extendTurnBudget?: number;
};

export type GoalInterceptContext = {
  /** Workflow gate steps are legitimate operator pauses — do not auto-continue. */
  atWorkflowGate: boolean;
  /** Last inference turn produced text or tool calls (false = empty yield). */
  lastTurnHadContent: boolean;
  /** Conversation excerpt for the evaluator. */
  evidence: string;
  /** Main-loop tokens from the just-finished inference turn, if known. */
  mainTurnTokens?: number;
};

export type CreateGoalGovernorOpts = {
  evaluate: GoalEvaluateFn;
  defaultTurnBudget?: number;
  maxConsecutiveEvalFailures?: number;
  maxConsecutiveEmptyYields?: number;
  defaultResumeExtend?: number;
  onChange?: (snapshot: GoalSnapshot) => void;
  now?: () => number;
};

export type GoalGovernor = ReturnType<typeof createGoalGovernor>;

export const DEFAULT_GOAL_TURN_BUDGET = 0;
export const DEFAULT_GOAL_RESUME_EXTEND = 25;
export const DEFAULT_MAX_EVAL_FAILURES = 3;
export const DEFAULT_MAX_EMPTY_YIELDS = 2;

/** `0` (and negative) means no turn soft-stop — goal runs until met, paused, or cleared. */
export function isUnlimitedTurnBudget(turnBudget: number): boolean {
  return turnBudget <= 0;
}

/** Display helper for status lines and the TUI header. */
export function formatGoalTurns(turnsUsed: number, turnBudget: number): string {
  if (isUnlimitedTurnBudget(turnBudget)) return `${turnsUsed}/∞`;
  return `${turnsUsed}/${turnBudget}`;
}

/** Progress over non-cancelled criteria. */
export function goalCriteriaProgress(criteria: GoalCriterion[]): { done: number; total: number } {
  const counted = criteria.filter((c) => c.status !== "cancelled");
  return {
    done: counted.filter((c) => c.status === "done").length,
    total: counted.length,
  };
}

export function criteriaAllDone(criteria: GoalCriterion[]): boolean {
  const counted = criteria.filter((c) => c.status !== "cancelled");
  return counted.length > 0 && counted.every((c) => c.status === "done");
}

/**
 * Derive lifecycle phase from checklist progress.
 * Autonomy status (paused / blocked / budget_limited) does not change phase —
 * only acceptance progress and achieved do.
 */
export function deriveGoalPhase(
  criteria: GoalCriterion[],
  status: GoalStatus,
): GoalPhase {
  if (status === "achieved" || criteriaAllDone(criteria)) return "completed";
  if (criteria.length === 0) return "planning";
  // Any acceptance progress means the agent is checking criteria (review).
  const acceptanceStarted = criteria.some(
    (c) => c.status === "doing" || c.status === "done" || c.status === "blocked",
  );
  if (acceptanceStarted) return "reviewing";
  return "implementing";
}

/** Full Acceptance panel: planning (define it), reviewing, completed. */
export function goalShowsAcceptancePanel(phase: GoalPhase): boolean {
  return phase === "planning" || phase === "reviewing" || phase === "completed";
}

/** Work is the primary chrome surface while implementing. */
export function goalShowsWorkPrimary(phase: GoalPhase): boolean {
  return phase === "implementing";
}

/** Build evaluator/legacy condition text from brief + criteria. */
export function synthesizeGoalCondition(brief: string, criteria: GoalCriterion[]): string {
  if (criteria.length === 0) return brief;
  const lines = criteria
    .filter((c) => c.status !== "cancelled")
    .map((c) => `- [${c.status}] ${c.title}`);
  return `Brief: ${brief}\nAcceptance criteria:\n${lines.join("\n")}`;
}

function cloneCriteria(criteria: GoalCriterion[]): GoalCriterion[] {
  return criteria.map((c) => ({ ...c }));
}

function emptySnapshot(defaultTurnBudget: number): GoalSnapshot {
  return {
    status: "inactive",
    brief: "",
    criteria: [],
    condition: "",
    startedAt: 0,
    turnBudget: defaultTurnBudget,
    turnsUsed: 0,
    mainTokens: 0,
    evalTokens: 0,
    consecutiveEvalFailures: 0,
    consecutiveEmptyYields: 0,
  };
}

function attachPhase(snap: GoalSnapshot): GoalSnapshot {
  return {
    ...snap,
    phase: deriveGoalPhase(snap.criteria, snap.status),
  };
}

function goalNudgeTurn(text: string): ConversationTurn {
  return {
    role: "user",
    content: [{ type: "text", text: text.trim() }],
    timestamp: Date.now(),
  };
}

function withEphemeralNudge(options: InferenceOptions, nudge: string): InferenceOptions {
  const turn = goalNudgeTurn(nudge);
  const existing = options.ephemeralTurns;
  if (existing === undefined || existing.length === 0) {
    return { ...options, ephemeralTurns: [turn] };
  }
  return { ...options, ephemeralTurns: [...existing, turn] };
}

function inferWithNudge(
  capabilities: ReactorCapabilities,
  nudge: string,
  options?: InferenceOptions,
): ReactorAction {
  return capabilities.infer(withEphemeralNudge(options ?? {}, nudge));
}

function isCleanTerminal(actions: ReactorAction[]): boolean {
  const hasTerminal = actions.some((a) => a.type === "wait" || a.type === "reply");
  if (!hasTerminal) return false;
  return !actions.some((a) => a.type === "infer" || a.type === "execute_tools");
}

function stripTerminal(actions: ReactorAction[]): ReactorAction[] {
  return actions.filter(
    (a): a is Exclude<ReactorAction, { type: "wait" } | { type: "reply" }> =>
      a.type !== "wait" && a.type !== "reply",
  );
}

function tokensTotal(snap: GoalSnapshot): number {
  return snap.mainTokens + snap.evalTokens;
}

function notMetNudge(brief: string, reason: string, criteria: GoalCriterion[]): string {
  const progress = goalCriteriaProgress(criteria);
  const open = criteria.filter(
    (c) => c.status === "todo" || c.status === "doing" || c.status === "blocked",
  );
  const openLines =
    open.length > 0
      ? open.map((c) => `  - [${c.status}] ${c.title}`).join("\n")
      : "  (none listed — define criteria with manage_goal if still empty)";
  return (
    "\n\nGoal still active — acceptance criteria not all done.\n" +
    `Brief: ${brief}\n` +
    `Progress: ${progress.done}/${progress.total}\n` +
    `Open:\n${openLines}\n` +
    `Note: ${reason}\n` +
    "Mark each acceptance criterion done via manage_goal only when verifiably complete. " +
    "Keep manage_tasks (Work) live — add, cancel, re-title, and status-update steps as the plan changes. " +
    "Do not stop until every criterion is done, or the operator pauses/clears the goal."
  );
}

/**
 * User message injected when `/goal` sets or resumes.
 * The expanded checklist (via manage_goal) is the real goal — not the raw brief.
 */
export function goalKickoffUserMessage(
  brief: string,
  phase: "set" | "resume" = "set",
): string {
  if (phase === "resume") {
    return (
      `Goal resumed.\nBrief: ${brief}\n` +
      "Continue the lifecycle: planning → implementing → reviewing → completed. " +
      "Update manage_tasks (Work) during implementing; mark manage_goal (Acceptance) as you verify in review. " +
      "If criteria are still empty or vague, define or clarify them before more work."
    );
  }
  return (
    `Session goal brief:\n${brief}\n\n` +
    "Two lists (do not conflate them):\n" +
    "- manage_goal = Acceptance — what \"done\" means (checkable success criteria).\n" +
    "- manage_tasks = Work — the steps you take to get there.\n\n" +
    "Lifecycle phases (the UI follows these):\n" +
    "1. planning — define Acceptance via manage_goal create (before heavy work).\n" +
    "2. implementing — execute Work via manage_tasks; leave Acceptance items todo until you verify.\n" +
    "3. reviewing — mark Acceptance doing/done with evidence as you check each criterion.\n" +
    "4. completed — every non-cancelled Acceptance item is done (auto-achieves the goal).\n\n" +
    "Order of operations (do not invert):\n" +
    "1. If the brief is vague or multi-interpretable, ask_operator ONE short clarifying question. " +
    "Do not run tests, make edits, install deps, or explore the repo until success is defined.\n" +
    "2. Call manage_goal with action=\"create\" and a detailed multi-item acceptance checklist " +
    "(typically 3–12 concrete, checkable conditions). Expand the brief — do not restate it as a single item. " +
    "Each item must be independently verifiable (e.g. \"bun test exits 0\", \"typecheck clean\", " +
    "\"PR description documents migration steps\").\n" +
    "3. Call manage_tasks with action=\"create\" for the work plan to satisfy those criteria " +
    "(implementation steps, not acceptance restatements).\n" +
    "4. Implement with Work live: update/add/cancel manage_tasks as the plan evolves. " +
    "Do not mass-mark Acceptance done until you are verifying — progressive manage_goal updates " +
    "during review (doing → done with evidence). " +
    "The goal is achieved only when every acceptance criterion is done."
  );
}

/**
 * Session-scoped goal continue-rule. Same family as CompactionGovernor: a
 * factory that owns state and rewrites terminal actions when the goal is active
 * and not yet met. Does not shrink the tool surface — only decides whether to
 * re-enter inference after a clean yield.
 */
export function createGoalGovernor(opts: CreateGoalGovernorOpts) {
  const defaultTurnBudget = opts.defaultTurnBudget ?? DEFAULT_GOAL_TURN_BUDGET;
  const maxEvalFailures = opts.maxConsecutiveEvalFailures ?? DEFAULT_MAX_EVAL_FAILURES;
  const maxEmptyYields = opts.maxConsecutiveEmptyYields ?? DEFAULT_MAX_EMPTY_YIELDS;
  const defaultResumeExtend = opts.defaultResumeExtend ?? DEFAULT_GOAL_RESUME_EXTEND;
  const now = opts.now ?? (() => Date.now());

  let snapshot: GoalSnapshot = emptySnapshot(defaultTurnBudget);

  function emit(): GoalSnapshot {
    snapshot = attachPhase(snapshot);
    const copy: GoalSnapshot = {
      ...snapshot,
      criteria: cloneCriteria(snapshot.criteria),
    };
    opts.onChange?.(copy);
    return copy;
  }

  function get(): GoalSnapshot | null {
    if (snapshot.status === "inactive") return null;
    const phased = attachPhase(snapshot);
    return {
      ...phased,
      criteria: cloneCriteria(phased.criteria),
    };
  }

  function set(brief: string, setOpts?: GoalSetOpts): GoalSnapshot {
    const trimmed = brief.trim();
    snapshot = {
      status: "active",
      brief: trimmed,
      criteria: [],
      condition: trimmed,
      startedAt: now(),
      turnBudget: setOpts?.turnBudget ?? defaultTurnBudget,
      turnsUsed: 0,
      ...(setOpts?.tokenBudget !== undefined ? { tokenBudget: setOpts.tokenBudget } : {}),
      mainTokens: 0,
      evalTokens: 0,
      consecutiveEvalFailures: 0,
      consecutiveEmptyYields: 0,
    };
    return emit();
  }

  /** Replace the full acceptance checklist (manage_goal create). */
  function setCriteria(criteria: GoalCriterion[]): GoalSnapshot | null {
    if (snapshot.status === "inactive" || snapshot.status === "cleared") return null;
    const next = criteria.map((c) => ({
      id: c.id,
      title: c.title.trim(),
      status: c.status,
      ...(c.note !== undefined && c.note.length > 0 ? { note: c.note } : {}),
    }));
    snapshot = {
      ...snapshot,
      criteria: next,
      condition: synthesizeGoalCondition(snapshot.brief, next),
    };
    maybeAchieveFromCriteria();
    return emit();
  }

  /** Patch criteria by id (manage_goal update). */
  function updateCriteria(
    updates: Array<{ id: string; title?: string; status?: GoalCriterionStatus; note?: string }>,
  ): GoalSnapshot | null {
    if (snapshot.status === "inactive" || snapshot.status === "cleared") return null;
    if (updates.length === 0) return get();
    const byId = new Map(updates.map((u) => [u.id, u]));
    const next = snapshot.criteria.map((c) => {
      const patch = byId.get(c.id);
      if (patch === undefined) return c;
      return {
        id: c.id,
        title: patch.title !== undefined ? patch.title.trim() : c.title,
        status: patch.status ?? c.status,
        ...(patch.note !== undefined
          ? patch.note.length > 0
            ? { note: patch.note }
            : {}
          : c.note !== undefined
            ? { note: c.note }
            : {}),
      };
    });
    snapshot = {
      ...snapshot,
      criteria: next,
      condition: synthesizeGoalCondition(snapshot.brief, next),
    };
    maybeAchieveFromCriteria();
    return emit();
  }

  /**
   * Checklist is the source of truth: once every non-cancelled criterion is done,
   * flip to achieved immediately (do not wait for the next clean yield).
   */
  function maybeAchieveFromCriteria(): void {
    if (snapshot.status === "achieved" || snapshot.status === "cleared" || snapshot.status === "inactive") {
      return;
    }
    if (!criteriaAllDone(snapshot.criteria)) return;
    snapshot = {
      ...snapshot,
      status: "achieved",
      lastReason: "All acceptance criteria marked done.",
    };
  }

  function pause(): GoalSnapshot | null {
    if (snapshot.status !== "active") return get();
    snapshot = { ...snapshot, status: "paused" };
    return emit();
  }

  function resume(resumeOpts?: GoalResumeOpts): GoalSnapshot | null {
    if (
      snapshot.status !== "paused" &&
      snapshot.status !== "budget_limited" &&
      snapshot.status !== "blocked"
    ) {
      return get();
    }
    const extend = resumeOpts?.extendTurnBudget ?? defaultResumeExtend;
    const { lastReason: _cleared, ...rest } = snapshot;
    // Unlimited goals stay unlimited on resume. Finite budgets get headroom so
    // /goal resume after budget_limited (or pause) can keep going.
    const nextTurnBudget = isUnlimitedTurnBudget(snapshot.turnBudget)
      ? 0
      : snapshot.turnsUsed + extend;
    snapshot = {
      ...rest,
      status: "active",
      turnBudget: nextTurnBudget,
      consecutiveEvalFailures: 0,
      consecutiveEmptyYields: 0,
    };
    return emit();
  }

  function clear(): void {
    if (snapshot.status === "inactive") return;
    const { lastReason: _cleared, ...rest } = snapshot;
    snapshot = {
      ...rest,
      status: "cleared",
    };
    emit();
    snapshot = emptySnapshot(defaultTurnBudget);
  }

  /**
   * Restore from session disk. Active goals become paused so autonomy is never
   * silently re-armed; achieved/cleared stay terminal; inactive is a no-op.
   */
  function restore(saved: {
    status: GoalStatus;
    condition: string;
    brief?: string;
    criteria?: GoalCriterion[];
    startedAt: number;
    turnBudget: number;
    turnsUsed?: number;
    tokenBudget?: number;
    mainTokens?: number;
    evalTokens?: number;
    lastReason?: string;
  }): GoalSnapshot | null {
    if (saved.status === "inactive" || saved.status === "cleared") {
      snapshot = emptySnapshot(defaultTurnBudget);
      return null;
    }
    const restoredStatus: GoalStatus =
      saved.status === "active" ? "paused" : saved.status === "achieved" ? "achieved" : "paused";
    const brief = (saved.brief ?? saved.condition).trim();
    const criteria = cloneCriteria(saved.criteria ?? []);
    snapshot = {
      status: restoredStatus,
      brief,
      criteria,
      condition: synthesizeGoalCondition(brief, criteria) || saved.condition,
      startedAt: saved.startedAt,
      turnBudget: saved.turnBudget,
      turnsUsed: saved.turnsUsed ?? 0,
      ...(saved.tokenBudget !== undefined ? { tokenBudget: saved.tokenBudget } : {}),
      mainTokens: saved.mainTokens ?? 0,
      evalTokens: saved.evalTokens ?? 0,
      ...(saved.lastReason !== undefined ? { lastReason: saved.lastReason } : {}),
      consecutiveEvalFailures: 0,
      consecutiveEmptyYields: 0,
    };
    return emit();
  }

  function noteMainTokens(n: number): void {
    if (snapshot.status !== "active" && snapshot.status !== "paused") return;
    if (n <= 0) return;
    snapshot = { ...snapshot, mainTokens: snapshot.mainTokens + n };
    opts.onChange?.({ ...snapshot, criteria: cloneCriteria(snapshot.criteria) });
  }

  function turnBudgetExhausted(): boolean {
    // 0 = unlimited: never soft-stop on turns alone.
    if (isUnlimitedTurnBudget(snapshot.turnBudget)) return false;
    // turnsUsed is the number of continue attempts already spent. Soft-stop when
    // the next continue would exceed the budget (turnsUsed >= turnBudget means
    // no more continues remain).
    return snapshot.turnsUsed >= snapshot.turnBudget;
  }

  function tokenBudgetExceeded(): boolean {
    return (
      snapshot.tokenBudget !== undefined && tokensTotal(snapshot) >= snapshot.tokenBudget
    );
  }

  function markBudgetLimited(kind: "turns" | "tokens"): null {
    const reason =
      kind === "turns"
        ? `Turn budget reached (${snapshot.turnsUsed}/${snapshot.turnBudget}). Use /goal resume to continue.`
        : `Token budget reached (${tokensTotal(snapshot)}/${snapshot.tokenBudget}). Use /goal resume to continue.`;
    snapshot = {
      ...snapshot,
      status: "budget_limited",
      lastReason: reason,
    };
    emit();
    // Keep the base terminal yield; status is visible via get()/onChange.
    return null;
  }

  /**
   * Soft-stop after a not-met decision: count the continue attempt, then either
   * re-infer or enter budget_limited. Budget N means N re-infers are allowed.
   */
  function continueOrBudget(
    actions: ReactorAction[],
    capabilities: ReactorCapabilities,
    reason: string,
  ): ReactorAction[] | null {
    if (turnBudgetExhausted()) {
      snapshot = { ...snapshot, lastReason: reason };
      return markBudgetLimited("turns");
    }
    if (tokenBudgetExceeded()) {
      snapshot = { ...snapshot, lastReason: reason };
      return markBudgetLimited("tokens");
    }
    snapshot = {
      ...snapshot,
      turnsUsed: snapshot.turnsUsed + 1,
      lastReason: reason,
    };
    if (tokenBudgetExceeded()) {
      return markBudgetLimited("tokens");
    }
    emit();
    return [
      ...stripTerminal(actions),
      inferWithNudge(
        capabilities,
        notMetNudge(snapshot.brief || snapshot.condition, reason, snapshot.criteria),
      ),
    ];
  }

  /**
   * After base decide (and compaction / workflow / open-task rules), rewrite a
   * clean terminal yield into a re-infer when the goal is active and not met.
   * Returns null when the base actions should stand unchanged (including soft-stop).
   */
  async function interceptTerminal(
    actions: ReactorAction[],
    capabilities: ReactorCapabilities,
    ctx: GoalInterceptContext,
  ): Promise<ReactorAction[] | null> {
    if (snapshot.status !== "active") return null;
    if (ctx.atWorkflowGate) return null;
    if (!isCleanTerminal(actions)) return null;

    if (ctx.mainTurnTokens !== undefined && ctx.mainTurnTokens > 0) {
      snapshot = { ...snapshot, mainTokens: snapshot.mainTokens + ctx.mainTurnTokens };
    }

    if (tokenBudgetExceeded()) {
      return markBudgetLimited("tokens");
    }
    if (turnBudgetExhausted()) {
      return markBudgetLimited("turns");
    }

    // Empty / contentless yield: progress guard before spending an eval call.
    if (!ctx.lastTurnHadContent) {
      const empty = snapshot.consecutiveEmptyYields + 1;
      snapshot = { ...snapshot, consecutiveEmptyYields: empty };
      if (empty >= maxEmptyYields) {
        snapshot = {
          ...snapshot,
          status: "paused",
          lastReason: `Paused after ${empty} consecutive empty yields. Use /goal resume to continue.`,
        };
        emit();
        return null;
      }
      return continueOrBudget(
        actions,
        capabilities,
        "Empty yield — no text or tool calls on the last turn.",
      );
    }
    snapshot = { ...snapshot, consecutiveEmptyYields: 0 };

    // Checklist is the source of truth once planned.
    if (snapshot.criteria.length === 0) {
      return continueOrBudget(
        actions,
        capabilities,
        "Acceptance criteria not defined yet. Call manage_goal create with a detailed multi-item checklist " +
          "(or ask_operator if the brief is still vague).",
      );
    }

    if (criteriaAllDone(snapshot.criteria)) {
      snapshot = {
        ...snapshot,
        status: "achieved",
        lastReason: "All acceptance criteria marked done.",
      };
      emit();
      return null;
    }

    // Open criteria: nudge with the list. Optional LLM evaluator as a soft
    // second opinion when evidence is rich — skip if empty evidence to save tokens.
    const open = snapshot.criteria.filter(
      (c) => c.status === "todo" || c.status === "doing" || c.status === "blocked",
    );
    const progress = goalCriteriaProgress(snapshot.criteria);
    const openSummary = open.map((c) => `[${c.status}] ${c.title}`).join("; ");

    // Fail-open evaluator still available for long evidence-backed runs, but
    // met is never true while criteria remain open (checklist wins).
    let verdict: GoalEvaluateVerdict;
    try {
      verdict = await opts.evaluate({
        condition: snapshot.condition,
        evidence: ctx.evidence,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      verdict = { met: false, reason: `Evaluator error: ${message}`, error: true };
    }

    if (verdict.evalTokens !== undefined && verdict.evalTokens > 0) {
      snapshot = { ...snapshot, evalTokens: snapshot.evalTokens + verdict.evalTokens };
    }

    if (verdict.error === true) {
      const failures = snapshot.consecutiveEvalFailures + 1;
      snapshot = {
        ...snapshot,
        consecutiveEvalFailures: failures,
        lastReason: verdict.reason,
      };
      if (failures >= maxEvalFailures) {
        snapshot = {
          ...snapshot,
          status: "paused",
          lastReason: `Paused after ${failures} consecutive evaluator failures. Last: ${verdict.reason}`,
        };
        emit();
        return null;
      }
      return continueOrBudget(
        actions,
        capabilities,
        `${progress.done}/${progress.total} criteria done. Open: ${openSummary}. ${verdict.reason}`,
      );
    }

    snapshot = {
      ...snapshot,
      consecutiveEvalFailures: 0,
      lastReason: verdict.reason,
    };

    // Checklist still open — never auto-achieve from evaluator alone.
    return continueOrBudget(
      actions,
      capabilities,
      `${progress.done}/${progress.total} criteria done. Open: ${openSummary}. ${verdict.reason}`,
    );
  }

  return {
    get,
    set,
    setCriteria,
    updateCriteria,
    pause,
    resume,
    clear,
    restore,
    noteMainTokens,
    interceptTerminal,
  };
}

const CRITERION_GLYPH: Record<GoalCriterionStatus, string> = {
  todo: "○",
  doing: "●",
  done: "✓",
  blocked: "!",
  cancelled: "✗",
};

export function formatGoalStatus(snap: GoalSnapshot | null): string {
  if (snap === null || snap.status === "inactive") {
    return "No goal is set. Use /goal <brief> to start one — the agent expands it into a checklist.";
  }

  const progress = goalCriteriaProgress(snap.criteria);
  const phase = snap.phase ?? deriveGoalPhase(snap.criteria, snap.status);
  const lines: string[] = [
    `Brief: ${snap.brief || snap.condition}`,
    `Phase: ${phase}`,
  ];

  if (snap.criteria.length === 0) {
    lines.push("Criteria: (not planned yet — waiting for manage_goal create)");
  } else {
    lines.push(`Progress: ${progress.done}/${progress.total}`);
    for (const c of snap.criteria) {
      const glyph = CRITERION_GLYPH[c.status];
      const note = c.note !== undefined && c.note.length > 0 ? ` — ${c.note}` : "";
      lines.push(`  ${glyph} ${c.title}${note}`);
    }
  }

  if (snap.status !== "active") {
    lines.push(`State: ${snap.status}`);
  }
  if (snap.lastReason !== undefined && snap.lastReason.length > 0) {
    lines.push(`Note: ${snap.lastReason}`);
  }
  // Budget only when finite (operator opted in) or when limited.
  if (!isUnlimitedTurnBudget(snap.turnBudget) || snap.status === "budget_limited") {
    lines.push(`Turns: ${formatGoalTurns(snap.turnsUsed, snap.turnBudget)}`);
  }
  if (snap.tokenBudget !== undefined) {
    lines.push(`Tokens: ${tokensTotal(snap)}/${snap.tokenBudget}`);
  }

  return lines.join("\n");
}
