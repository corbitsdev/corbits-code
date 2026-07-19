import type {
  ReactorAction,
  ReactorCapabilities,
  InferenceOptions,
  ConversationTurn,
} from "@intx/types/runtime";

export type GoalStatus =
  | "inactive"
  | "active"
  | "paused"
  | "achieved"
  | "cleared"
  | "budget_limited"
  | "blocked";

export type GoalSnapshot = {
  status: GoalStatus;
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

function notMetNudge(condition: string, reason: string): string {
  return (
    "\n\nGoal still active and not yet met.\n" +
    `Condition: ${condition}\n` +
    `Evaluator: ${reason}\n` +
    "Continue working toward the condition. Do not stop until it is verifiably met " +
    "or the operator pauses/clears the goal. If success criteria are still ambiguous, " +
    "ask the operator once — do not thrash on vague goals."
  );
}

/**
 * User message injected when `/goal` sets or resumes. Clarify-first: vague
 * conditions must lock a checkable success criterion before substantial work.
 */
export function goalKickoffUserMessage(
  condition: string,
  phase: "set" | "resume" = "set",
): string {
  if (phase === "resume") {
    return (
      `Goal resumed: ${condition}\n` +
      "Continue until this condition is verifiably met. Prefer tools and evidence over claims. " +
      "If success criteria are still ambiguous, ask once before more work — do not thrash."
    );
  }
  return (
    `Session goal is set:\n${condition}\n\n` +
    "Order of operations (do not invert):\n" +
    "1. If this condition is vague or multi-interpretable, ask the operator ONE short " +
    "clarifying question to lock a concrete, checkable success criterion. " +
    "Do not run tests, make edits, install deps, or explore the repo until success is defined.\n" +
    "2. If the condition is already concrete and verifiable " +
    '(e.g. "bun test exits 0", "typecheck clean", "PR open with CI green"), skip clarification and start immediately.\n' +
    "3. Once criteria are clear, work until they are met with evidence. Do not stop at partial progress."
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

  let snapshot: GoalSnapshot = {
    status: "inactive",
    condition: "",
    startedAt: 0,
    turnBudget: defaultTurnBudget,
    turnsUsed: 0,
    mainTokens: 0,
    evalTokens: 0,
    consecutiveEvalFailures: 0,
    consecutiveEmptyYields: 0,
  };

  function emit(): GoalSnapshot {
    const copy = { ...snapshot };
    opts.onChange?.(copy);
    return copy;
  }

  function get(): GoalSnapshot | null {
    if (snapshot.status === "inactive") return null;
    return { ...snapshot };
  }

  function set(condition: string, setOpts?: GoalSetOpts): GoalSnapshot {
    const trimmed = condition.trim();
    snapshot = {
      status: "active",
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
    snapshot = {
      status: "inactive",
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

  /**
   * Restore from session disk. Active goals become paused so autonomy is never
   * silently re-armed; achieved/cleared stay terminal; inactive is a no-op.
   */
  function restore(saved: {
    status: GoalStatus;
    condition: string;
    startedAt: number;
    turnBudget: number;
    turnsUsed?: number;
    tokenBudget?: number;
    mainTokens?: number;
    evalTokens?: number;
    lastReason?: string;
  }): GoalSnapshot | null {
    if (saved.status === "inactive" || saved.status === "cleared") {
      snapshot = {
        status: "inactive",
        condition: "",
        startedAt: 0,
        turnBudget: defaultTurnBudget,
        turnsUsed: 0,
        mainTokens: 0,
        evalTokens: 0,
        consecutiveEvalFailures: 0,
        consecutiveEmptyYields: 0,
      };
      return null;
    }
    const restoredStatus: GoalStatus =
      saved.status === "active" ? "paused" : saved.status === "achieved" ? "achieved" : "paused";
    snapshot = {
      status: restoredStatus,
      condition: saved.condition,
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
    opts.onChange?.({ ...snapshot });
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
      inferWithNudge(capabilities, notMetNudge(snapshot.condition, reason)),
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
        "Empty yield while goal active — continuing.",
      );
    }

    snapshot = { ...snapshot, consecutiveEmptyYields: 0 };

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
      return continueOrBudget(actions, capabilities, verdict.reason);
    }

    snapshot = {
      ...snapshot,
      consecutiveEvalFailures: 0,
      lastReason: verdict.reason,
    };

    if (verdict.met) {
      snapshot = { ...snapshot, status: "achieved" };
      emit();
      return null;
    }

    return continueOrBudget(actions, capabilities, verdict.reason);
  }

  return {
    get,
    set,
    pause,
    resume,
    clear,
    restore,
    noteMainTokens,
    interceptTerminal,
  };
}

export function formatGoalStatus(snap: GoalSnapshot | null): string {
  if (snap === null || snap.status === "inactive") {
    return "No goal is set. Use /goal <condition> to start one.";
  }
  const durationMs = Date.now() - snap.startedAt;
  const mins = Math.floor(durationMs / 60_000);
  const secs = Math.floor((durationMs % 60_000) / 1000);
  const duration = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  const tokens = tokensTotal(snap);
  const lines = [
    `Goal: ${snap.condition}`,
    `Status: ${snap.status}`,
    `Duration: ${duration}`,
    `Turns: ${formatGoalTurns(snap.turnsUsed, snap.turnBudget)}`,
    `Tokens: ${tokens}` +
      (snap.tokenBudget !== undefined ? `/${snap.tokenBudget}` : "") +
      ` (main ${snap.mainTokens}, eval ${snap.evalTokens})`,
  ];
  if (snap.lastReason !== undefined && snap.lastReason.length > 0) {
    lines.push(`Last reason: ${snap.lastReason}`);
  }
  return lines.join("\n");
}
