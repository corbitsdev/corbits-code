/**
 * ask_director evaluation: pure caps, unit-testable without an agent loop.
 * run.ts wires this into the leaf tool handler and owns per-turn AskDirectorState.
 */

import {
  decideEscalation,
  parseEscalationAssessment,
  type EscalationAssessment,
} from "./escalation-policy.js";

export const ASK_DIRECTOR_MAX_BYTES = 4096;
export const ASK_DIRECTOR_MAX_QUESTIONS = 3;

export interface AskDirectorState {
  questions: number;
  pending: boolean;
}

export function createAskDirectorState(): AskDirectorState {
  return { questions: 0, pending: false };
}

export interface AskDirectorInput {
  question: unknown;
  escalation: unknown;
  state: AskDirectorState;
}

export interface AskDirectorPort {
  register: (input: {
    question: string;
    questionId: string;
    assessment: EscalationAssessment;
    grantRequestId?: string;
  }) => Promise<string>;
  cancel: (reason: string) => void;
  /** Routine evaluations are recorded for audit; they never register or wake. */
  recordRoutineEvaluation?: (assessment: EscalationAssessment) => void;
}

/** Non-terminal by design: over-cap / second-ask returns `ok: false` so the worker does not suspend. */
export function evaluateAskDirector(input: AskDirectorInput):
  | { ok: false; message: string }
  | {
      ok: true;
      message: string;
      question: string;
      assessment: EscalationAssessment;
      continueInternal?: true;
    } {
  if (typeof input.question !== "string") {
    return {
      ok: false,
      message: "Error: ask_director requires question (string).",
    };
  }
  const question = input.question.trim();
  if (question.length === 0) {
    return {
      ok: false,
      message: "Error: ask_director requires a non-empty question.",
    };
  }
  const bytes = new TextEncoder().encode(question).byteLength;
  if (bytes > ASK_DIRECTOR_MAX_BYTES) {
    return {
      ok: false,
      message: `Error: ask_director question exceeds ${ASK_DIRECTOR_MAX_BYTES} bytes (got ${bytes}).`,
    };
  }
  if (input.state.pending) {
    return {
      ok: false,
      message:
        "Error: ask_director already has a pending question. Wait for the director's send_input answer before asking again.",
    };
  }
  if (input.state.questions >= ASK_DIRECTOR_MAX_QUESTIONS) {
    return {
      ok: false,
      message: `Error: ask_director question cap (${ASK_DIRECTOR_MAX_QUESTIONS}) reached for this turn. No further questions accepted — finish with the markdown report envelope instead.`,
    };
  }
  // The policy contract is mandatory at the tool boundary: a worker that
  // omits `escalation` is rejected and must never park a prompt-prose-only
  // question. The wire schema also lists these fields, but the local tool
  // wrapper does no schema validation, so the runtime check is the gate.
  if (input.escalation === undefined) {
    return {
      ok: false,
      message:
        "Error: ask_director requires escalation (object) with policyVersion, classification, blockedOutcome, unavailableDirectorPath, permittedAlternatives, minimumAddition, and declineConsequence.",
    };
  }
  const assessment = parseEscalationAssessment(input.escalation);
  if (assessment instanceof Error) {
    return { ok: false, message: `Error: ${assessment.message}` };
  }
  if (decideEscalation(assessment).kind === "continue_internal") {
    return {
      ok: true,
      message:
        "Continue with the recorded permitted alternative; do not park or escalate. Report its result in the final outcome.",
      question,
      assessment,
      continueInternal: true,
    };
  }
  // Reserve the one-at-a-time lock so a parallel ask errors, but do not
  // consume a cap slot until commitAskDirector (register reached the director).
  input.state.pending = true;
  return { ok: true, message: "ok", question, assessment };
}

/** Count this question against the per-turn cap once abort is ruled out and register will run. */
export function commitAskDirector(state: AskDirectorState): void {
  state.questions += 1;
}

export function releaseAskDirector(state: AskDirectorState): void {
  state.pending = false;
}

/** Fresh 3-question cap for a resume_agent / send_input(interrupt) turn. */
export function resetAskDirectorTurn(state: AskDirectorState): void {
  state.questions = 0;
  state.pending = false;
}

/**
 * Compact continuation shares the stall ping channel. Skipping while
 * ask_director is parked must not drop the only continue: remember the skip
 * and flush after the ask releases.
 */
export function createDeferredContinuation(): {
  request: (state: AskDirectorState, deliver: () => void) => void;
  flush: (state: AskDirectorState, deliver: () => void) => void;
} {
  let deferred = false;
  return {
    request(state, deliver) {
      if (state.pending) {
        deferred = true;
        return;
      }
      deferred = false;
      deliver();
    },
    flush(state, deliver) {
      if (!deferred || state.pending) return;
      deferred = false;
      deliver();
    },
  };
}

export async function handleAskDirector(args: {
  question: unknown;
  escalation?: unknown;
  grantRequestId?: unknown;
  state: AskDirectorState;
  port: AskDirectorPort;
  signal: AbortSignal;
}): Promise<string> {
  const outcome = evaluateAskDirector({
    question: args.question,
    escalation: args.escalation,
    state: args.state,
  });
  if (!outcome.ok) return outcome.message;
  if (outcome.continueInternal === true) {
    args.port.recordRoutineEvaluation?.(outcome.assessment);
    return outcome.message;
  }
  try {
    const onAbort = (): void => {
      args.port.cancel("ask_director aborted");
    };
    // Listener first: an abort between the old pre-check and addEventListener
    // would otherwise miss {once:true} on an already-aborted signal.
    args.signal.addEventListener("abort", onAbort, { once: true });
    if (args.signal.aborted) {
      onAbort();
      return "Error: ask_director was cancelled.";
    }
    const questionId = `ask-${args.state.questions + 1}`;
    const grantRequestId =
      typeof args.grantRequestId === "string" ? args.grantRequestId : undefined;
    try {
      const answerP = args.port.register({
        question: outcome.question,
        questionId,
        assessment: outcome.assessment,
        ...(grantRequestId !== undefined ? { grantRequestId } : {}),
      });
      if (args.signal.aborted) {
        onAbort();
        try {
          await answerP;
        } catch {
          // cancelAsk rejects this; await so it is not an unhandledRejection.
        }
        return "Error: ask_director was cancelled.";
      }
      commitAskDirector(args.state);
      return await answerP;
    } catch (cause) {
      if (args.signal.aborted) return "Error: ask_director was cancelled.";
      const detail =
        cause instanceof Error ? cause.message : "ask_director cancelled";
      return `Error: ${detail}`;
    } finally {
      args.signal.removeEventListener("abort", onAbort);
    }
  } finally {
    releaseAskDirector(args.state);
  }
}
