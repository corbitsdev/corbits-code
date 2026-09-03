/**
 * ask_director evaluation: pure caps, unit-testable without an agent loop.
 * run.ts wires this into the leaf tool handler and owns per-run AskDirectorState.
 */

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
  state: AskDirectorState;
}

export interface AskDirectorPort {
  register: (input: { question: string; questionId: string }) => Promise<string>;
  cancel: (reason: string) => void;
}

/** Non-terminal by design: over-cap / second-ask returns `ok: false` so the worker does not suspend. */
export function evaluateAskDirector(input: AskDirectorInput): {
  ok: boolean;
  message: string;
  question?: string;
} {
  if (typeof input.question !== "string") {
    return { ok: false, message: "Error: ask_director requires question (string)." };
  }
  const question = input.question.trim();
  if (question.length === 0) {
    return { ok: false, message: "Error: ask_director requires a non-empty question." };
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
      message: `Error: ask_director question cap (${ASK_DIRECTOR_MAX_QUESTIONS}) reached for this run. No further questions accepted — finish with the markdown report envelope instead.`,
    };
  }
  // Reserve the one-at-a-time lock so a parallel ask errors, but do not
  // consume a cap slot until commitAskDirector (register reached the director).
  input.state.pending = true;
  return { ok: true, message: "ok", question };
}

/** Count this question against the per-run cap once abort is ruled out and register will run. */
export function commitAskDirector(state: AskDirectorState): void {
  state.questions += 1;
}

export function releaseAskDirector(state: AskDirectorState): void {
  state.pending = false;
}

/**
 * Waiting on the spawning director is work, not silence. A stall ping
 * would otherwise salvage a blocked ask_director as stalled.
 */
export function skipStallContinuationWhileAskPending(
  state: AskDirectorState,
  deliver: () => void,
): void {
  if (state.pending) return;
  deliver();
}

export async function handleAskDirector(args: {
  question: unknown;
  state: AskDirectorState;
  port: AskDirectorPort;
  signal: AbortSignal;
}): Promise<string> {
  const outcome = evaluateAskDirector({ question: args.question, state: args.state });
  if (!outcome.ok || outcome.question === undefined) return outcome.message;
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
    try {
      const answerP = args.port.register({
        question: outcome.question,
        questionId,
      });
      if (args.signal.aborted) {
        onAbort();
        return "Error: ask_director was cancelled.";
      }
      commitAskDirector(args.state);
      return await answerP;
    } catch (cause) {
      if (args.signal.aborted) return "Error: ask_director was cancelled.";
      const detail = cause instanceof Error ? cause.message : "ask_director cancelled";
      return `Error: ${detail}`;
    } finally {
      args.signal.removeEventListener("abort", onAbort);
    }
  } finally {
    releaseAskDirector(args.state);
  }
}
