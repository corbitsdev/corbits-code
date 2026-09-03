import { describe, expect, test } from "bun:test";

import {
  ASK_DIRECTOR_MAX_BYTES,
  ASK_DIRECTOR_MAX_QUESTIONS,
  commitAskDirector,
  createAskDirectorState,
  evaluateAskDirector,
  handleAskDirector,
  releaseAskDirector,
  skipStallContinuationWhileAskPending,
} from "./ask-director.js";

describe("evaluateAskDirector", () => {
  test("rejects a missing or empty question without suspending", () => {
    const state = createAskDirectorState();
    expect(evaluateAskDirector({ question: undefined, state }).ok).toBe(false);
    expect(evaluateAskDirector({ question: "   ", state }).ok).toBe(false);
    expect(state.questions).toBe(0);
    expect(state.pending).toBe(false);
  });

  test("rejects an oversized question without suspending", () => {
    const state = createAskDirectorState();
    const oversized = "a".repeat(ASK_DIRECTOR_MAX_BYTES + 1);
    const outcome = evaluateAskDirector({ question: oversized, state });
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("exceeds");
    expect(state.questions).toBe(0);
    expect(state.pending).toBe(false);
  });

  test("accepts a question at the byte cap without consuming a slot until commit", () => {
    const state = createAskDirectorState();
    const outcome = evaluateAskDirector({
      question: "a".repeat(ASK_DIRECTOR_MAX_BYTES),
      state,
    });
    expect(outcome.ok).toBe(true);
    expect(state.questions).toBe(0);
    expect(state.pending).toBe(true);
    commitAskDirector(state);
    expect(state.questions).toBe(1);
  });

  test("a second parallel ask errors without incrementing or suspending", () => {
    const state = createAskDirectorState();
    expect(evaluateAskDirector({ question: "which file?", state }).ok).toBe(true);
    commitAskDirector(state);
    const second = evaluateAskDirector({ question: "and which function?", state });
    expect(second.ok).toBe(false);
    expect(second.message).toContain("pending question");
    expect(state.questions).toBe(1);
    expect(state.pending).toBe(true);
  });

  test("question cap refuses a 4th ask after prior asks are released", () => {
    const state = createAskDirectorState();
    for (let i = 0; i < ASK_DIRECTOR_MAX_QUESTIONS; i++) {
      expect(evaluateAskDirector({ question: `q${i}`, state }).ok).toBe(true);
      commitAskDirector(state);
      releaseAskDirector(state);
    }
    const capped = evaluateAskDirector({ question: "one more", state });
    expect(capped.ok).toBe(false);
    expect(capped.message).toContain("question cap");
    expect(state.questions).toBe(ASK_DIRECTOR_MAX_QUESTIONS);
    expect(state.pending).toBe(false);
  });

  test("releaseAskDirector allows a later sequential ask under the cap", () => {
    const state = createAskDirectorState();
    expect(evaluateAskDirector({ question: "first", state }).ok).toBe(true);
    commitAskDirector(state);
    releaseAskDirector(state);
    const second = evaluateAskDirector({ question: "second", state });
    expect(second.ok).toBe(true);
    expect(second.question).toBe("second");
    commitAskDirector(state);
    expect(state.questions).toBe(2);
  });

  test("abort before register leaves questions count unchanged", async () => {
    const state = createAskDirectorState();
    const registered: string[] = [];
    const port = {
      register: async ({ question }: { question: string; questionId: string }) => {
        registered.push(question);
        return "answer";
      },
      cancel: () => {},
    };
    const controller = new AbortController();
    controller.abort();
    const message = await handleAskDirector({
      question: "which file?",
      state,
      port,
      signal: controller.signal,
    });
    expect(message).toContain("cancelled");
    expect(registered).toEqual([]);
    expect(state.questions).toBe(0);
    expect(state.pending).toBe(false);
  });

  test("abort during register does not consume a cap slot", async () => {
    const state = createAskDirectorState();
    const controller = new AbortController();
    let cancelled = 0;
    const port = {
      register: (): Promise<string> => {
        controller.abort();
        return new Promise<string>(() => {});
      },
      cancel: () => {
        cancelled += 1;
      },
    };
    const message = await handleAskDirector({
      question: "which file?",
      state,
      port,
      signal: controller.signal,
    });
    expect(message).toContain("cancelled");
    expect(state.questions).toBe(0);
    expect(state.pending).toBe(false);
    expect(cancelled).toBeGreaterThan(0);
  });

  test("register throw does not consume a cap slot", async () => {
    const state = createAskDirectorState();
    const port = {
      register: (): Promise<string> => {
        throw new Error("ask_director could not register a pending question");
      },
      cancel: () => {},
    };
    const message = await handleAskDirector({
      question: "which file?",
      state,
      port,
      signal: new AbortController().signal,
    });
    expect(message).toContain("could not register");
    expect(state.questions).toBe(0);
    expect(state.pending).toBe(false);
  });
});

describe("requestContinuation stall skip", () => {
  test("is a no-op while askDirectorState.pending", () => {
    const state = createAskDirectorState();
    let delivered = 0;
    skipStallContinuationWhileAskPending(state, () => {
      delivered += 1;
    });
    expect(delivered).toBe(1);

    expect(evaluateAskDirector({ question: "which file?", state }).ok).toBe(true);
    skipStallContinuationWhileAskPending(state, () => {
      delivered += 1;
    });
    expect(delivered).toBe(1);
  });
});
