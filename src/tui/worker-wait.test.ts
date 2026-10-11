import { describe, expect, test } from "bun:test";

import type { PendingAskWake } from "../subagent/fleet-report.js";
import { ESCALATION_POLICY_VERSION } from "../subagent/escalation-policy.js";
import { stringWidth } from "./view/height.js";
import {
  composeWorkerWaitLine,
  NO_WORKER_WAIT,
  reduceWorkerWait,
  selectedWorkerWait,
  workerWaitMoreCount,
  workerWaitDecisionSummary,
  type WorkerWaitPart,
  type WorkerWaitState,
} from "./worker-wait.js";

function ask(
  sessionId: string,
  questionId: string,
  question = `question ${questionId}`,
): PendingAskWake {
  return {
    sessionId,
    agentId: "builder",
    description: `work ${sessionId}`,
    question,
    questionId,
  };
}

function fold(...snapshots: (readonly PendingAskWake[])[]): WorkerWaitState {
  return snapshots.reduce<WorkerWaitState>(reduceWorkerWait, NO_WORKER_WAIT);
}

function text(parts: readonly WorkerWaitPart[]): string {
  return parts.map((part) => part.text).join("");
}

function selectedIdentity(state: WorkerWaitState): readonly string[] | null {
  const item = selectedWorkerWait(state);
  return item === null ? null : [item.sessionId, item.questionId];
}

describe("worker wait view model", () => {
  test("an empty snapshot keeps the strip inactive", () => {
    const state = fold([]);
    expect(state).toBe(NO_WORKER_WAIT);
    expect(selectedWorkerWait(state)).toBeNull();
    expect(composeWorkerWaitLine(state, 80)).toEqual([]);
  });

  test("one pending ask activates one selected item", () => {
    const state = fold([ask("s1", "q1")]);
    expect(state.items).toHaveLength(1);
    expect(selectedIdentity(state)).toEqual(["s1", "q1"]);
    expect(workerWaitMoreCount(state)).toBe(0);
  });

  test("repeated reports of one identity produce one item and keep the same state", () => {
    const first = fold([ask("s1", "q1")]);
    const again = reduceWorkerWait(first, [ask("s1", "q1")]);
    expect(again).toBe(first);
    const doubled = fold([ask("s1", "q1"), ask("s1", "q1")]);
    expect(doubled.items).toHaveLength(1);
  });

  test("a new question for the same session replaces the old item atomically", () => {
    const before = fold([ask("s1", "q1", "Old preview?")]);
    const after = reduceWorkerWait(before, [ask("s1", "q2", "New preview?")]);
    expect(after.items).toHaveLength(1);
    expect(selectedIdentity(after)).toEqual(["s1", "q2"]);
    expect(text(composeWorkerWaitLine(after, 120))).toContain("New preview?");
    expect(text(composeWorkerWaitLine(after, 120))).not.toContain(
      "Old preview?",
    );
  });

  test("a replaced question does not inherit the selection", () => {
    const before = fold([ask("s1", "q1"), ask("s2", "q2")]);
    expect(selectedIdentity(before)).toEqual(["s1", "q1"]);
    // s1's new question moves behind s2 in source order; the old selected
    // identity is gone, so selection falls back to the first live item.
    const after = reduceWorkerWait(before, [ask("s2", "q2"), ask("s1", "q9")]);
    expect(selectedIdentity(after)).toEqual(["s2", "q2"]);
  });

  test("multiple wakes keep the displayed identity while it stays live", () => {
    const before = fold([ask("s1", "q1")]);
    const after = reduceWorkerWait(before, [
      ask("s0", "q0"),
      ask("s1", "q1"),
      ask("s2", "q2"),
    ]);
    expect(selectedIdentity(after)).toEqual(["s1", "q1"]);
    expect(workerWaitMoreCount(after)).toBe(2);
    expect(after.items.map((item) => item.sessionId)).toEqual([
      "s0",
      "s1",
      "s2",
    ]);
  });

  test("selection falls back to snapshot order when the displayed identity leaves", () => {
    const before = fold([ask("s1", "q1"), ask("s2", "q2"), ask("s3", "q3")]);
    const after = reduceWorkerWait(before, [ask("s3", "q3"), ask("s2", "q2")]);
    expect(selectedIdentity(after)).toEqual(["s3", "q3"]);
    expect(workerWaitMoreCount(after)).toBe(1);
  });

  test("the additional count tracks the live snapshot", () => {
    let state = fold([ask("s1", "q1"), ask("s2", "q2"), ask("s3", "q3")]);
    expect(text(composeWorkerWaitLine(state, 160))).toContain("(+2 more)");
    state = reduceWorkerWait(state, [ask("s1", "q1"), ask("s3", "q3")]);
    expect(text(composeWorkerWaitLine(state, 160))).toContain("(+1 more)");
    state = reduceWorkerWait(state, [ask("s1", "q1")]);
    expect(text(composeWorkerWaitLine(state, 160))).not.toContain("more");
  });

  test("a re-surfaced wake restating the same identity never duplicates the item", () => {
    const state = fold([ask("s1", "q1")]);
    // The stall-abort re-surface restates the question to the director; the
    // fleet snapshot it rides on still names the same identity.
    const resurfaced = reduceWorkerWait(state, [ask("s1", "q1")]);
    expect(resurfaced).toBe(state);
    expect(resurfaced.items).toHaveLength(1);
  });

  test("an item leaves only when the snapshot omits its identity", () => {
    let state = fold([ask("s1", "q1"), ask("s2", "q2")]);
    state = reduceWorkerWait(state, [ask("s2", "q2")]);
    expect(state.items.map((item) => item.sessionId)).toEqual(["s2"]);
    state = reduceWorkerWait(state, []);
    expect(state.items).toEqual([]);
    expect(state.selectedKey).toBeNull();
    expect(composeWorkerWaitLine(state, 80)).toEqual([]);
  });

  test("identity halves cannot alias across sessions", () => {
    const state = fold([ask("a", "b:c"), ask("a:b", "c")]);
    expect(state.items).toHaveLength(2);
    expect(new Set(state.items.map((item) => item.key)).size).toBe(2);
  });

  test("teardown state renders nothing", () => {
    const live = fold([ask("s1", "q1")]);
    expect(composeWorkerWaitLine(live, 80)).not.toEqual([]);
    expect(composeWorkerWaitLine(NO_WORKER_WAIT, 80)).toEqual([]);
  });
});

describe("worker wait strip copy", () => {
  const destination = fold([
    {
      sessionId: "sess-1",
      agentId: "builder",
      description: "copy assets",
      question: "Which destination path should I use?",
      questionId: "q1",
    },
  ]);

  test("full width names the waiting worker, its question, and director ownership", () => {
    const line = text(composeWorkerWaitLine(destination, 120));
    expect(line).toContain("WORKER WAITING");
    expect(line).toContain("director reply needed");
    expect(line).toContain("send_input");
    expect(line).toContain("builder (copy assets)");
    expect(line).toContain("Which destination path should I use?");
  });

  test("the waiting label and routing copy carry the meaning without color", () => {
    const parts = composeWorkerWaitLine(destination, 120);
    const roles = new Map(parts.map((part) => [part.role, part.text]));
    expect(roles.get("label")).toBe("WORKER WAITING");
    expect(roles.get("routing")).toContain("director");
  });

  test("an assessed decision shows the question plus actionable policy detail without changing its identity", () => {
    const assessed: PendingAskWake = {
      ...ask("sess-assessed", "q1", "Which branch should I target?"),
      assessment: {
        policyVersion: ESCALATION_POLICY_VERSION,
        classification: "operator_decision_required",
        blockedOutcome: "cannot verify authenticated release status",
        unavailableDirectorPath: "director lacks authenticated read access",
        permittedAlternatives: [
          {
            attempted: "checked cached status",
            result: "snapshot is stale",
            comparableConfidence: false,
          },
        ],
        minimumAddition: "authenticated read access",
        requestedMechanism: "broad web access",
        minimumAuthority: "authenticated release-status read",
        declineConsequence: "release verification remains blocked",
        recommendation: "grant the narrow read",
        safeDefault: "do not publish",
      },
    };
    const state = fold([assessed]);
    const item = selectedWorkerWait(state);
    expect(item).not.toBeNull();
    if (item === null) throw new Error("expected assessed worker wait item");
    expect(workerWaitDecisionSummary(item)).toContain(
      "Which branch should I target?",
    );
    expect(workerWaitDecisionSummary(item)).toContain(
      "classification: operator_decision_required",
    );
    const line = text(composeWorkerWaitLine(state, 1_000));
    expect(line).toContain("Which branch should I target?");
    expect(line).toContain(
      "outcome: cannot verify authenticated release status",
    );
    expect(line).toContain("minimum: authenticated release-status read");
    expect(line).toContain("consequence: release verification remains blocked");
    expect(line).toContain("recommendation: grant the narrow read");
    expect(line).toContain("target: sess-assessed");
    expect(reduceWorkerWait(state, [assessed])).toBe(state);
  });

  test("every width fits the strip inside its row", () => {
    const many = fold([
      ask("s1", "q1", "A long question ".repeat(12)),
      ask("s2", "q2"),
      ask("s3", "q3"),
    ]);
    for (let width = 1; width <= 160; width++) {
      const parts = composeWorkerWaitLine(many, width);
      expect(stringWidth(text(parts))).toBeLessThanOrEqual(width);
      expect(parts.length).toBeGreaterThan(0);
    }
  });

  test("narrowing truncates the question before requester metadata", () => {
    const question = "Which destination path should I use for the bundle?";
    const long = fold([ask("s1", "q1", question), ask("s2", "q2")]);
    const partAt = (width: number, role: WorkerWaitPart["role"]) =>
      composeWorkerWaitLine(long, width).find((part) => part.role === role)
        ?.text;
    expect(partAt(200, "question")).toBe(question);
    expect(partAt(200, "requester")).toBe("builder (work s1)");
    // A standard 80-column terminal still previews the question.
    expect(partAt(78, "question")).toEndWith("…");
    expect(text(composeWorkerWaitLine(long, 78))).toContain("(+1 more)");
    for (let width = 200; width >= 1; width--) {
      const preview = partAt(width, "question");
      const requester = partAt(width, "requester");
      // Metadata only shrinks once the question is already cut short.
      if (requester !== "builder (work s1)") {
        expect(preview === undefined || preview.endsWith("…")).toBe(true);
      }
      // The question only drops once the description is already gone.
      if (preview === undefined) {
        expect(requester === undefined || requester === "builder").toBe(true);
      }
    }
  });

  test("narrow widths keep a compact explicit label and the additional count", () => {
    const two = fold([ask("s1", "q1"), ask("s2", "q2")]);
    const narrow = text(composeWorkerWaitLine(two, 30));
    expect(narrow).toContain("WAITING");
    expect(narrow).toContain("(+1 more)");
    const tiny = text(composeWorkerWaitLine(two, 20));
    expect(tiny).toContain("WAITING");
    expect(tiny).toContain("(+1 more)");
  });

  test("worker text cannot inject terminal sequences or extra rows", () => {
    const hostile = fold([
      {
        sessionId: "s1",
        agentId: "builder\u001b[2J",
        description: "desc\nnext",
        question:
          "Pick\u001b[31m red\u001b[0m\r\nor \u001b]52;c;Zm9v\u0007blue?",
        questionId: "q1",
      },
    ]);
    const line = text(composeWorkerWaitLine(hostile, 200));
    expect(line).not.toContain("\u001b");
    expect(line).not.toContain("\n");
    expect(line).not.toContain("\r");
    expect(line).toContain("Pick red or blue?");
    expect(line).toContain("builder (desc next)");
  });
});
