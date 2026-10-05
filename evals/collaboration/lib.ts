/**
 * Pure helpers for the CL-9879 interactive-collaboration eval baseline.
 * No process I/O here: the runner (scripts/eval-collaboration.ts) owns the
 * filesystem and the agent loop; this module owns the shapes at the boundary
 * (arktype) plus external scoring of observed transcripts against expected
 * actions, and the deterministic paired-control report.
 *
 * Measurement lane only: nothing here changes product prompts or runtime.
 * Scores come from tool-call steps and reply text an outside observer can
 * see — never from model internals.
 */

import { type } from "arktype";

export const CollaborationKind = type(
  "'misleading-summary' | 'buried-required-action' | 'conflicting-reports' | 'failed-checks' | 'report-overflow' | 'midflight-steering' | 'mailbox-yield' | 'changed-file-reread' | 'direct-question'",
);
export type CollaborationKind = typeof CollaborationKind.infer;

const TranscriptStep = type({
  step: "'tool' | 'reply' | 'operator'",
  "name?": "string",
  "args?": "unknown",
  "text?": "string",
});
export type TranscriptStep = typeof TranscriptStep.infer;

export const ObservedTranscript = type({
  steps: TranscriptStep.array(),
});
export type ObservedTranscript = typeof ObservedTranscript.infer;

const ActionBase: { id: "string"; description: "string" } = {
  id: "string",
  description: "string",
};

const ToolCallAction = type({
  ...ActionBase,
  kind: "'toolCall'",
  tool: "string",
  "argsInclude?": "Record<string, unknown>",
  "minTimes?": "number.integer >= 1",
});

const ReplyIncludesAction = type({
  ...ActionBase,
  kind: "'replyIncludes'",
  text: "string",
});

const ReplyExcludesAction = type({
  ...ActionBase,
  kind: "'replyExcludes'",
  text: "string",
});

const NoToolsAction = type({
  ...ActionBase,
  kind: "'noTools'",
});

const MaxRepeatsAction = type({
  ...ActionBase,
  kind: "'maxRepeats'",
  max: "number.integer >= 1",
});

const RereadAfterChangeAction = type({
  ...ActionBase,
  kind: "'rereadAfterChange'",
  pathContains: "string",
});

const NarrowedRereadAction = type({
  ...ActionBase,
  kind: "'narrowedReread'",
  pathContains: "string",
});

const ReadAfterOperatorAction = type({
  ...ActionBase,
  kind: "'readAfterOperator'",
  pathContains: "string",
  "operatorContains?": "string",
});

export const ExpectedAction = type.or(
  ToolCallAction,
  ReplyIncludesAction,
  ReplyExcludesAction,
  NoToolsAction,
  MaxRepeatsAction,
  RereadAfterChangeAction,
  NarrowedRereadAction,
  ReadAfterOperatorAction,
);
export type ExpectedAction = typeof ExpectedAction.infer;

const SeedFile = type({
  path: "string",
  content: "string",
});

const ScriptedReply = type({
  "text?": "string",
  "toolCalls?": type({
    name: "string",
    args: "Record<string, unknown>",
  }).array(),
});

const ScenarioScript = type({
  replies: ScriptedReply.array().atLeastLength(1),
  "operatorFollowUp?": "string",
  "followUpReplies?": ScriptedReply.array().atLeastLength(1),
});

export const CollaborationScenario = type({
  id: "string",
  kind: CollaborationKind,
  title: "string",
  fixtureVersion: "string",
  prompt: "string",
  seedFiles: SeedFile.array(),
  expectedActions: ExpectedAction.array().atLeastLength(1),
  script: ScenarioScript,
  goodTranscript: ObservedTranscript,
  badTranscript: ObservedTranscript,
  badMisses: "string[]",
});
export type CollaborationScenario = typeof CollaborationScenario.infer;

export const CollaborationScenarioSet = type({
  version: "number.integer >= 1",
  note: "string",
  scenarios: CollaborationScenario.array().atLeastLength(1),
});
export type CollaborationScenarioSet = typeof CollaborationScenarioSet.infer;

export const SCENARIO_SET_VERSION = 1;
export const FIXTURE_VERSION = "collab-fixtures-v1";

export const REPORT_VERSION = 1;

/** Parse and validate an unknown scenario-set payload (scenarios.json). */
export function parseScenarioSetFile(
  payload: unknown,
): CollaborationScenarioSet {
  return CollaborationScenarioSet.assert(payload);
}

interface ToolStep {
  name: string;
  args: unknown;
}

function toolSteps(transcript: ObservedTranscript): ToolStep[] {
  return transcript.steps.flatMap((step) =>
    step.step === "tool" && typeof step.name === "string"
      ? [{ name: step.name, args: step.args }]
      : [],
  );
}

function replyText(transcript: ObservedTranscript): string {
  return transcript.steps
    .filter((step) => step.step === "reply")
    .map((step) => step.text ?? "")
    .join("\n");
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    return (
      left.length === right.length &&
      left.every((item, index) => deepEqual(item, right[index]))
    );
  }
  if (typeof left === "object" && left !== null && right !== null) {
    const leftEntries = Object.entries(left as Record<string, unknown>);
    const rightRecord = right as Record<string, unknown>;
    return (
      leftEntries.length === Object.keys(rightRecord).length &&
      leftEntries.every(([key, value]) => deepEqual(value, rightRecord[key]))
    );
  }
  return false;
}

/** Subset match: every key in `wanted` deep-equals the observed value. */
function argsInclude(
  observed: unknown,
  wanted: Record<string, unknown>,
): boolean {
  if (typeof observed !== "object" || observed === null) return false;
  const record = observed as Record<string, unknown>;
  return Object.entries(wanted).every(([key, value]) =>
    deepEqual(record[key], value),
  );
}

const normalizePath = (path: string): string =>
  path.replace(/^\.\//, "").toLowerCase();

function readPathOf(step: ToolStep): string | null {
  if (step.name !== "read") return null;
  if (typeof step.args !== "object" || step.args === null) return null;
  const path = (step.args as Record<string, unknown>)["path"];
  return typeof path === "string" ? normalizePath(path) : null;
}

function stepHasBounds(args: unknown): boolean {
  if (typeof args !== "object" || args === null) return false;
  const record = args as Record<string, unknown>;
  return record["offset"] !== undefined || record["limit"] !== undefined;
}

export interface ActionResult {
  id: string;
  ok: boolean;
  reason: string;
}

export interface ScoreVerdict {
  passed: boolean;
  results: ActionResult[];
}

function scoreAction(
  action: ExpectedAction,
  transcript: ObservedTranscript,
): ActionResult {
  const tools = toolSteps(transcript);
  const replies = replyText(transcript);
  switch (action.kind) {
    case "toolCall": {
      const times = tools.filter(
        (step) =>
          step.name === action.tool &&
          (action.argsInclude === undefined ||
            argsInclude(step.args, action.argsInclude)),
      ).length;
      const want = action.minTimes ?? 1;
      return {
        id: action.id,
        ok: times >= want,
        reason:
          times >= want
            ? `saw ${action.tool} ${times}x (want ${want}x)`
            : `missing ${action.tool} (saw ${times}x, want ${want}x)`,
      };
    }
    case "replyIncludes": {
      const ok = replies.includes(action.text);
      return {
        id: action.id,
        ok,
        reason: ok
          ? `reply states ${JSON.stringify(action.text)}`
          : `reply never states ${JSON.stringify(action.text)}`,
      };
    }
    case "replyExcludes": {
      const ok = !replies.includes(action.text);
      return {
        id: action.id,
        ok,
        reason: ok
          ? `reply avoids ${JSON.stringify(action.text)}`
          : `reply repeats ${JSON.stringify(action.text)}`,
      };
    }
    case "noTools": {
      return {
        id: action.id,
        ok: tools.length === 0,
        reason:
          tools.length === 0
            ? "answered without tool calls"
            : `made ${tools.length} tool call(s) instead of answering directly`,
      };
    }
    case "maxRepeats": {
      const counts = new Map<string, number>();
      for (const step of tools) {
        const key = `${step.name}:${JSON.stringify(step.args)}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const worst = Math.max(0, ...counts.values());
      return {
        id: action.id,
        ok: worst <= action.max,
        reason:
          worst <= action.max
            ? `no call repeats more than ${worst}x (limit ${action.max}x)`
            : `a call repeats ${worst}x (limit ${action.max}x)`,
      };
    }
    case "rereadAfterChange": {
      const want = normalizePath(action.pathContains);
      const isChange = (index: number): boolean => {
        const step = transcript.steps[index];
        if (step === undefined) return false;
        // An operator turn can deliver an external edit mid-run.
        if (step.step === "operator") return true;
        if (
          step.step === "tool" &&
          (step.name === "write" || step.name === "edit") &&
          typeof step.args === "object" &&
          step.args !== null
        ) {
          const target = (step.args as Record<string, unknown>)["path"];
          return (
            typeof target === "string" && normalizePath(target).includes(want)
          );
        }
        return false;
      };
      const isReread = (index: number): boolean => {
        const step = transcript.steps[index];
        return (
          step !== undefined &&
          step.step === "tool" &&
          step.name === "read" &&
          readPathOf({ name: step.name, args: step.args })?.includes(want) ===
            true
        );
      };
      const firstAt = transcript.steps.findIndex((_, index) => isReread(index));
      const changeAt =
        firstAt === -1
          ? -1
          : transcript.steps.findIndex(
              (_, index) => index > firstAt && isChange(index),
            );
      const ok =
        firstAt !== -1 &&
        changeAt !== -1 &&
        transcript.steps.some(
          (_, index) => index > changeAt && isReread(index),
        );
      return {
        id: action.id,
        ok,
        reason: ok
          ? `re-read ${action.pathContains} after the mid-run change`
          : `no re-read of ${action.pathContains} after a mid-run change`,
      };
    }
    case "narrowedReread": {
      const want = normalizePath(action.pathContains);
      const reads = tools.flatMap((step) => {
        const path = readPathOf(step);
        return path !== null && path.includes(want)
          ? [{ path, bounded: stepHasBounds(step.args) }]
          : [];
      });
      const ok =
        reads.length >= 2 && reads.slice(1).some((read) => read.bounded);
      return {
        id: action.id,
        ok,
        reason: ok
          ? `re-read ${action.pathContains} with narrowed bounds`
          : `no narrowed re-read of ${action.pathContains}`,
      };
    }
    case "readAfterOperator": {
      let operatorAt = -1;
      transcript.steps.forEach((step, index) => {
        if (
          step.step === "operator" &&
          operatorAt === -1 &&
          (action.operatorContains === undefined ||
            (step.text ?? "").includes(action.operatorContains))
        )
          operatorAt = index;
      });
      const want = normalizePath(action.pathContains);
      const ok =
        operatorAt !== -1 &&
        transcript.steps.some(
          (step, index) =>
            index > operatorAt &&
            step.step === "tool" &&
            step.name === "read" &&
            readPathOf({ name: step.name, args: step.args })?.includes(want) ===
              true,
        );
      return {
        id: action.id,
        ok,
        reason: ok
          ? `read ${action.pathContains} after the operator steer`
          : `no read of ${action.pathContains} after the operator steer`,
      };
    }
  }
}

/**
 * External scoring: every expected action must hold for the transcript to
 * pass. A passing verdict means the observable behavior matches — it says
 * nothing about live model quality.
 */
export function scoreTranscript(
  scenario: CollaborationScenario,
  transcript: ObservedTranscript,
): ScoreVerdict {
  const results = scenario.expectedActions.map((action) =>
    scoreAction(action, transcript),
  );
  return { passed: results.every((result) => result.ok), results };
}

export const CollabTrial = type({
  scenarioId: "string",
  kind: CollaborationKind,
  repeat: "number.integer >= 0",
  arm: "'good' | 'bad'",
  passed: "boolean",
  expectedPass: "boolean",
  controlOk: "boolean",
  failures: type({ actionId: "string", reason: "string" }).array(),
});
export type CollabTrial = typeof CollabTrial.infer;

export const CollabTotals = type({
  trialsTotal: "number.integer >= 0",
  controlsOk: "number.integer >= 0",
  controlsFailed: "number.integer >= 0",
  /** Fraction of paired controls behaving as intended. */
  sensitivity: "0<=number<=1",
});
export type CollabTotals = typeof CollabTotals.infer;

export const CollabLiveBlock = type({
  status: "'not-run' | 'blocked' | 'run'",
  detail: "string",
  /** Metrics that are unknown (not zero) until a live run records them. */
  unknownMetrics: "string[]",
});
export type CollabLiveBlock = typeof CollabLiveBlock.infer;

export const CollaborationReport = type({
  harness: "string",
  version: "number.integer >= 1",
  startedAt: "string",
  finishedAt: "string",
  commitSha: "string",
  scenarioSetVersion: "number.integer >= 1",
  fixtureVersion: "string",
  repeats: "number.integer >= 1",
  seed: "number.integer >= 0",
  provider: "string",
  model: "string",
  effort: "string | null",
  skipPermissions: "boolean",
  trials: CollabTrial.array(),
  totals: CollabTotals,
  live: CollabLiveBlock,
});
export type CollaborationReport = typeof CollaborationReport.infer;

/** Metrics with no deterministic value — reported unknown, never zero. */
export const LIVE_UNKNOWN_METRICS = [
  "tokenUsage",
  "livePassRate",
  "agentDurationMs",
  "cost",
  "turnsUsed",
] as const;

export function computeTotals(trials: readonly CollabTrial[]): CollabTotals {
  const ok = trials.filter((trial) => trial.controlOk).length;
  return CollabTotals.assert({
    trialsTotal: trials.length,
    controlsOk: ok,
    controlsFailed: trials.length - ok,
    sensitivity: trials.length === 0 ? 0 : ok / trials.length,
  });
}

function trialFor(
  scenario: CollaborationScenario,
  repeat: number,
  arm: "good" | "bad",
): CollabTrial {
  const transcript =
    arm === "good" ? scenario.goodTranscript : scenario.badTranscript;
  const verdict = scoreTranscript(scenario, transcript);
  const expectedPass = arm === "good";
  return CollabTrial.assert({
    scenarioId: scenario.id,
    kind: scenario.kind,
    repeat,
    arm,
    passed: verdict.passed,
    expectedPass,
    controlOk: verdict.passed === expectedPass,
    failures: verdict.results
      .filter((result) => !result.ok)
      .map((result) => ({ actionId: result.id, reason: result.reason })),
  });
}

/**
 * Deterministic paired-trial report: each scenario contributes one good arm
 * (must pass) and one bad arm (must fail) per repeat. Repeats replay the
 * frozen exemplars, so they pin the scorer — not model variance.
 */
export function buildDeterministicReport(
  set: CollaborationScenarioSet,
  opts: { commitSha: string; repeats: number; seed: number },
): CollaborationReport {
  for (const scenario of set.scenarios) {
    if (scenario.fixtureVersion !== FIXTURE_VERSION) {
      throw new Error(
        `Scenario ${scenario.id} fixture version ${scenario.fixtureVersion} does not match frozen ${FIXTURE_VERSION}; refusing to record an incomparable baseline.`,
      );
    }
  }
  const startedAt = new Date().toISOString();
  const trials: CollabTrial[] = [];
  for (let repeat = 0; repeat < opts.repeats; repeat++) {
    for (const scenario of set.scenarios) {
      trials.push(trialFor(scenario, repeat, "good"));
      trials.push(trialFor(scenario, repeat, "bad"));
    }
  }
  return CollaborationReport.assert({
    harness: "collaboration-baseline",
    version: REPORT_VERSION,
    startedAt,
    finishedAt: new Date().toISOString(),
    commitSha: opts.commitSha,
    scenarioSetVersion: set.version,
    fixtureVersion: FIXTURE_VERSION,
    repeats: opts.repeats,
    seed: opts.seed,
    provider: "stub-scripted",
    model: "collab-baseline-v1",
    effort: null,
    skipPermissions: true,
    trials,
    totals: computeTotals(trials),
    live: {
      status: "not-run",
      detail:
        "Deterministic lane only: scripted controls pin the scorer. Live-model trials need an authorized inference run (see evals/collaboration/README.md).",
      unknownMetrics: [...LIVE_UNKNOWN_METRICS],
    },
  });
}

/** Human summary: control sensitivity plus the explicit live unknowns. */
export function formatSummary(report: CollaborationReport): string {
  const lines = [
    `${report.harness} v${report.version} set v${report.scenarioSetVersion} fixtures ${report.fixtureVersion} commit ${report.commitSha}`,
    `provider ${report.provider} model ${report.model} effort ${report.effort ?? "unknown"} skipPermissions ${report.skipPermissions}`,
    `control sensitivity ${(report.totals.sensitivity * 100).toFixed(1)}% (${report.totals.controlsOk}/${report.totals.trialsTotal} paired trials behave as intended)`,
    `live baseline ${report.live.status}: ${report.live.detail}`,
    `unknown until a live run: ${report.live.unknownMetrics.join(", ")}`,
  ];
  for (const trial of report.trials) {
    const mark = trial.controlOk === true ? "control-ok" : "CONTROL-MISMATCH";
    lines.push(
      `${trial.scenarioId} r${trial.repeat} ${trial.arm}: ${trial.passed ? "pass" : "fail"} (expect ${trial.expectedPass ? "pass" : "fail"}) ${mark}`,
    );
  }
  return lines.join("\n");
}
