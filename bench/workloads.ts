// The deterministic, model-free workloads. Two families:
//
//   inference  — drive the real `@intx/inference` runInference loop through the
//                deterministic test harness (stubbed fetch, virtual clock).
//                Stresses the per-token buffering / event path (CL-3259, 3260).
//   transcript — drive the TUI retention state (`createAgentStreamState`) with
//                synthesized reactor events. Stresses content caps and retained
//                transcript size (CL-3261, 3262).
//
// Every workload returns the same `WorkloadResult` shape so the runner and the
// regression test compare them uniformly.

import { setupHarness } from "@intx/inference-testing";
import type { ConversationTurn, InferenceSource } from "@intx/types/runtime";
import type { ReactorEmittedEvent } from "@intx/inference";

import {
  createAgentStreamState,
  type AgentStreamState,
  type ContentBlockData,
} from "../src/tui/use-stream.js";
import type { WorkloadResult } from "./measure.js";
import { deltaPayloadBytes, textDeltaChunks, thinkingDeltaChunks } from "./wire.js";

export type Workload = {
  readonly name: string;
  readonly family: "inference" | "transcript";
  readonly description: string;
  run(): Promise<WorkloadResult>;
};

const SOURCE: InferenceSource = {
  id: "anthropic:claude-3-5-sonnet-20240620",
  provider: "anthropic",
  baseURL: "https://api.anthropic.com",
  apiKey: "test",
  model: "claude-3-5-sonnet-20240620",
};

const USER_TURN: ConversationTurn = {
  role: "user",
  content: [{ type: "text", text: "go" }],
  timestamp: 0,
};

// Benchmark fixtures populate only the fields `addEvent` reads; the cast bridges
// to the full reactor event union without reconstructing every event's schema.
function reactorEvent(
  type: string,
  data: unknown,
  seq: number,
): ReactorEmittedEvent {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test fixture, see comment above
  return { type, seq, data } as unknown as ReactorEmittedEvent;
}

function transcriptBytes(state: AgentStreamState): number {
  return Buffer.byteLength(JSON.stringify(state.contentBlocks), "utf8");
}

async function drainInference(chunks: Uint8Array[]): Promise<number> {
  const harness = setupHarness();
  try {
    const stream = harness.scenario.createStream();
    stream.enqueueAll(chunks, { startAt: harness.clock.now() + 1 });
    harness.scenario.whenRequestMatches(() => true, stream);

    let seq = 0;
    let eventCount = 0;
    const collected = (async () => {
      for await (const _event of harness.runInference({
        turns: [USER_TURN],
        source: SOURCE,
        nextSeq: () => ++seq,
      })) {
        eventCount++;
      }
    })();

    await harness.run({ wallClockBudgetMs: Infinity });
    await collected;
    return eventCount;
  } finally {
    harness.dispose();
  }
}

const SMALL_DELTA_COUNT = 3000;
const SMALL_DELTA_PIECE = "tok ";

const REASONING_DELTA_COUNT = 2500;
const REASONING_PIECE = "reasoning step; ";

const HUGE_TOOL_RESULT_CHARS = 4_000_000;
const TOOL_HEAVY_CYCLES = 400;
const TOOL_HEAVY_RESULT_CHARS = 2_000;
const RESUMED_BLOCK_COUNT = 5000;

export const WORKLOADS: readonly Workload[] = [
  {
    name: "small-token-deltas",
    family: "inference",
    description: `${String(SMALL_DELTA_COUNT)} tiny text deltas through the real inference loop`,
    async run() {
      const eventCount = await drainInference(
        textDeltaChunks(SMALL_DELTA_COUNT, SMALL_DELTA_PIECE),
      );
      return {
        eventCount,
        retainedBytes: deltaPayloadBytes(SMALL_DELTA_COUNT, SMALL_DELTA_PIECE),
      };
    },
  },
  {
    name: "long-reasoning-output",
    family: "inference",
    description: `${String(REASONING_DELTA_COUNT)} thinking deltas through the real inference loop`,
    async run() {
      const eventCount = await drainInference(
        thinkingDeltaChunks(REASONING_DELTA_COUNT, REASONING_PIECE),
      );
      return {
        eventCount,
        retainedBytes: deltaPayloadBytes(REASONING_DELTA_COUNT, REASONING_PIECE),
      };
    },
  },
  {
    name: "large-tool-results",
    family: "transcript",
    description: `one ${String(HUGE_TOOL_RESULT_CHARS)}-char tool result fed through the retention caps`,
    async run() {
      const state = createAgentStreamState([], () => SOURCE.model, []);
      state.addEvent(
        reactorEvent(
          "inference.tool_call.start",
          { name: "run_shell", callId: "c1" },
          1,
        ),
      );
      state.addEvent(
        reactorEvent(
          "inference.tool_call.end",
          { name: "run_shell", callId: "c1", arguments: { command: "ls -R /" } },
          2,
        ),
      );
      state.addEvent(
        reactorEvent(
          "tool.done",
          {
            result: {
              callId: "c1",
              content: "x".repeat(HUGE_TOOL_RESULT_CHARS),
              isError: false,
            },
          },
          3,
        ),
      );
      return { eventCount: 3, retainedBytes: transcriptBytes(state) };
    },
  },
  {
    name: "resumed-session",
    family: "transcript",
    description: `${String(RESUMED_BLOCK_COUNT)} hydrated transcript blocks through the retained-block cap`,
    async run() {
      const blocks: ContentBlockData[] = [];
      for (let i = 0; i < RESUMED_BLOCK_COUNT; i++) {
        blocks.push({ type: "text", content: `resumed line ${String(i)} content` });
      }
      const state = createAgentStreamState([], () => SOURCE.model, blocks);
      return {
        eventCount: RESUMED_BLOCK_COUNT,
        retainedBytes: transcriptBytes(state),
      };
    },
  },
  {
    name: "tool-heavy-transcript",
    family: "transcript",
    description: `${String(TOOL_HEAVY_CYCLES)} tool call/result cycles through the retention state`,
    async run() {
      const state = createAgentStreamState([], () => SOURCE.model, []);
      let seq = 0;
      for (let i = 0; i < TOOL_HEAVY_CYCLES; i++) {
        const callId = `call-${String(i)}`;
        state.addEvent(
          reactorEvent("inference.tool_call.start", { name: "grep", callId }, ++seq),
        );
        state.addEvent(
          reactorEvent(
            "inference.tool_call.end",
            { name: "grep", callId, arguments: { pattern: `p${String(i)}` } },
            ++seq,
          ),
        );
        state.addEvent(
          reactorEvent(
            "tool.done",
            {
              result: {
                callId,
                content: "r".repeat(TOOL_HEAVY_RESULT_CHARS),
                isError: false,
              },
            },
            ++seq,
          ),
        );
      }
      return { eventCount: seq, retainedBytes: transcriptBytes(state) };
    },
  },
];
