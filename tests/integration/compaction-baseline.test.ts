import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { type } from "arktype";
import { wire } from "@intx/inference-testing";
import { ContentBlock } from "@intx/types/runtime";
import { createPermissionGate } from "../../src/permission/gate.js";
import { COMPACTED_PREFIX } from "../../src/session/compactor.js";
import {
  BASELINE,
  CORRECTION,
  FAILED_OUTPUT,
  INITIAL,
  OVERSIZED_OUTPUT,
  REQUIRED_EVIDENCE,
  evidenceText,
} from "../../evals/compaction/fixtures.js";
import {
  qualifyingFold,
  recoverEvidence,
  repeatedWork,
  type Fold,
  type Work,
} from "../../evals/compaction/metrics.js";
import {
  closeIntegrationSession,
  openIntegrationSession,
  runUntilDone,
  type IntegrationSession,
  type TurnResult,
} from "./harness.js";

const PersistedTurn = type({ role: "string", content: ContentBlock.array(), timestamp: "number" });
const WireRequest = type({ messages: type({ role: "string", content: "unknown" }).array() });
const usage = (input: number) => ({ input, output: 1, cacheRead: 0, cacheWrite: 0, thinking: 0 });

function observedWork(events: TurnResult["events"]): Work[] {
  return events.flatMap((event) => {
    if (event.type !== "tool.start") return [];
    const call = event.data.call;
    const done = events.find(
      (candidate) => candidate.type === "tool.done" && candidate.data.result.callId === call.id,
    );
    if (done?.type !== "tool.done") throw new Error(`Missing tool result: ${call.id}`);
    const result = done.data.result;
    const failedShellExit =
      call.name === "run_shell" &&
      typeof result.content === "string" &&
      /^exit code -?[1-9]\d*\n/.test(result.content);
    return [
      {
        name: call.name,
        argumentsKey: JSON.stringify(call.arguments),
        outcome: result.isError === true || failedShellExit ? "failure" : "success",
        purpose: call.id.startsWith("fold-") ? "verification" : "action",
      },
    ];
  });
}

async function snapshot(session: IntegrationSession) {
  const raw = await readFile(join(session.workdir, "turns.jsonl"), "utf8");
  const turns = raw
    .trim()
    .split("\n")
    .map((line) => PersistedTurn.assert(JSON.parse(line)));
  return { hash: createHash("sha256").update(raw).digest("hex"), turns };
}

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Compaction baseline timed out")),
          BASELINE.wallTimeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// Each response is selectable only if its exact evidence set is in the actual wire request.
function queueEvidenceReply(session: IntegrationSession, callId: string) {
  for (let mask = 0; mask < 1 << REQUIRED_EVIDENCE.length; mask++) {
    const facts = REQUIRED_EVIDENCE.filter((_, index) => (mask & (1 << index)) !== 0);
    const text = evidenceText(facts) || "Missing all required evidence.";
    const stream = session.harness.scenario.createStream();
    stream.enqueueAll(wire.completeResponse("anthropic", { text }), {
      startAt: session.harness.clock.now() + 1,
    });
    session.harness.scenario.whenRequestBodyMatches((body) => {
      const request = WireRequest.assert(JSON.parse(body));
      const recovered = recoverEvidence(body);
      return (
        JSON.stringify(request.messages.at(-1)?.content).includes(callId) &&
        recovered.length === facts.length &&
        facts.every((fact) =>
          recovered.some(
            (answer) =>
              answer.id === fact.id && answer.source === fact.source && answer.value === fact.value,
          ),
        )
      );
    }, stream);
  }
}

describe("integration — frozen compaction mechanics baseline", () => {
  test.serial(
    "counts repeated real nonzero shell exits as failed attempts",
    async () => {
      const session = await openIntegrationSession({
        permissionGate: createPermissionGate({
          approvals: [],
          interactive: false,
          skipPermissions: true,
          reactorGated: false,
        }),
      });
      const trace: Work[] = [];
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          session.harness.scenario.replyOnce("anthropic", {
            text: `Run diagnostic attempt ${attempt}.`,
            toolCalls: [{ name: "run_shell", args: { command: "exit 7", timeout: 5000 } }],
          });
          session.harness.scenario.replyOnce("anthropic", { text: "Diagnostic finished." });
          const { events } = await withTimeout(
            runUntilDone(session, `Diagnose attempt ${attempt}.`),
          );
          trace.push(...observedWork(events));
        }
        expect(trace.map((work) => work.outcome)).toEqual(["failure", "failure"]);
        expect(repeatedWork(trace).repeatedFailedAttempts).toBe(1);
      } finally {
        await closeIntegrationSession(session);
      }
    },
    40000,
  );

  test.serial(
    "the primary responder recovers reordered evidence",
    async () => {
      const session = await openIntegrationSession({
        permissionGate: createPermissionGate({
          approvals: [],
          interactive: false,
          skipPermissions: true,
          reactorGated: false,
        }),
      });
      try {
        queueEvidenceReply(session, "reordered-evidence");
        const { reply } = await withTimeout(
          runUntilDone(
            session,
            `reordered-evidence\n${evidenceText([...REQUIRED_EVIDENCE].reverse())}`,
          ),
        );
        expect(recoverEvidence(reply)).toEqual([...REQUIRED_EVIDENCE]);
      } finally {
        await closeIntegrationSession(session);
      }
    },
    40000,
  );

  test.serial(
    "the primary responder reports missing evidence instead of fixture answers",
    async () => {
      const session = await openIntegrationSession({
        permissionGate: createPermissionGate({
          approvals: [],
          interactive: false,
          skipPermissions: true,
          reactorGated: false,
        }),
      });
      try {
        queueEvidenceReply(session, "absent-evidence");
        const { reply } = await withTimeout(runUntilDone(session, "absent-evidence"));
        expect(reply).toBe("Missing all required evidence.");
        expect(recoverEvidence(reply)).toEqual([]);
      } finally {
        await closeIntegrationSession(session);
      }
    },
  );

  test.serial(
    "persists three real folds and resumes primary inference after each",
    async () => {
      const summaryInputs: string[] = [];
      const session = await openIntegrationSession({
        permissionGate: createPermissionGate({
          approvals: [],
          interactive: false,
          skipPermissions: true,
          reactorGated: false,
        }),
        compactionCompletion: async (turns) => {
          const context = turns
            .flatMap((turn) =>
              turn.content.flatMap((block) => (block.type === "text" ? [block.text] : [])),
            )
            .join("\n");
          summaryInputs.push(context);
          return (
            evidenceText(recoverEvidence(context)) ||
            "No required evidence in the supplied excerpt."
          );
        },
      });
      const folds: Fold[] = [];
      const trace: Work[] = [];
      try {
        await writeFile(join(session.cwd, "diagnostic.log"), OVERSIZED_OUTPUT);
        await writeFile(
          join(session.cwd, "diagnose.ts"),
          `process.stdout.write(${JSON.stringify(FAILED_OUTPUT)}); process.exit(1);`,
        );
        for (const message of [INITIAL, CORRECTION]) {
          session.harness.scenario.replyOnce("anthropic", {
            text: "Acknowledged.",
            headUsage: usage(BASELINE.syntheticLowInput),
          });
          await withTimeout(runUntilDone(session, message));
        }
        for (const toolCall of [
          { name: "run_shell", args: { command: "bun diagnose.ts", timeout: 5000 } },
          { name: "read_file", args: { path: "diagnostic.log", offset: 0, limit: 4000 } },
          { name: "read_file", args: { path: "diagnostic.log", offset: 1500, limit: 1 } },
        ]) {
          session.harness.scenario.replyOnce("anthropic", {
            text: "Inspecting evidence.",
            toolCalls: [toolCall],
            headUsage: usage(BASELINE.syntheticLowInput),
          });
          session.harness.scenario.replyOnce("anthropic", {
            text: "Inspection complete.",
            headUsage: usage(BASELINE.syntheticLowInput),
          });
          const { events } = await withTimeout(
            runUntilDone(session, "Inspect the next diagnostic source."),
          );
          trace.push(...observedWork(events));
        }
        const evidenceBefore = recoverEvidence(JSON.stringify((await snapshot(session)).turns));
        expect(evidenceBefore).toEqual([...REQUIRED_EVIDENCE]);
        for (let fold = 0; fold < BASELINE.folds; fold++) {
          for (let growth = 0; growth < BASELINE.growthTurnsPerFold; growth++) {
            session.harness.scenario.replyOnce("anthropic", {
              text: `Checked independent audit item ${fold}-${growth}.`,
              headUsage: usage(BASELINE.syntheticLowInput),
            });
            await withTimeout(runUntilDone(session, `Verify audit item ${fold}-${growth}.`));
          }
          const before = await snapshot(session);
          const requestCount = session.harness.scenario.matchedRequests().length;
          session.harness.scenario.replyOnce("anthropic", {
            text: `Verify diagnostic row ${fold}.`,
            toolCalls: [
              {
                callId: `fold-${fold}`,
                name: "read_file",
                args: { path: "diagnostic.log", offset: fold, limit: 1 },
              },
            ],
            headUsage: usage(BASELINE.syntheticTriggerInput),
          });
          queueEvidenceReply(session, `fold-${fold}`);
          const startedAt = performance.now();
          const { events, reply } = await withTimeout(
            runUntilDone(session, `Finish audit phase ${fold}.`),
          );
          trace.push(...observedWork(events));
          const after = await snapshot(session);
          const inferenceCount = events.filter((event) => event.type === "inference.start").length;
          const observation: Fold = {
            requestedAtCall: requestCount + 1,
            beforeHash: before.hash,
            afterHash: after.hash,
            beforeTurns: before.turns.length,
            afterTurns: after.turns.length,
            persisted:
              after.turns.filter((turn) =>
                turn.content.some(
                  (block) => block.type === "text" && block.text.startsWith(COMPACTED_PREFIX),
                ),
              ).length ===
              fold + 1,
            continuedAtCall: inferenceCount >= 2 ? requestCount + 2 : null,
          };
          folds.push(observation);
          expect(qualifyingFold(observation)).toBe(true);
          expect(summaryInputs.length).toBe(fold + 1);
          expect(recoverEvidence(reply)).toEqual(REQUIRED_EVIDENCE.slice(0, 1));
          process.stdout.write(
            `${JSON.stringify({ phase: fold + 1, ...observation, recoveredFacts: recoverEvidence(reply).length, requiredFacts: REQUIRED_EVIDENCE.length, phaseLatencyMs: performance.now() - startedAt })}\n`,
          );
        }
        expect(folds.filter(qualifyingFold)).toHaveLength(3);
        expect(trace).toHaveLength(6);
        expect(repeatedWork(trace)).toEqual({
          repeatedReads: 0,
          repeatedSearches: 0,
          repeatedFailedAttempts: 0,
          duplicatedEdits: 0,
          verificationCalls: 3,
        });
        expect(
          qualifyingFold({
            requestedAtCall: 1,
            beforeHash: "same",
            afterHash: "same",
            beforeTurns: 1,
            afterTurns: 1,
            persisted: false,
            continuedAtCall: null,
          }),
        ).toBe(false);
      } finally {
        await closeIntegrationSession(session);
      }
    },
    120000,
  );
});
