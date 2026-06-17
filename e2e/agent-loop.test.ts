import { describe, test, expect } from "bun:test";

import { createCapabilities } from "@intx/inference";
import { setupHarness } from "@intx/inference-testing";

import { createCodingDirector, submitOutputDefinition } from "../src/agent/director.js";
import { buildSystemPrompt } from "../src/agent/prompts.js";

describe("agent loop", () => {
  test("director aborts after submitOutput", async () => {
    const harness = setupHarness();
    try {
      const director = createCodingDirector(
        buildSystemPrompt(),
        [submitOutputDefinition],
        {
          turnsUsed: 0,
          submitCalled: false,
          callIdToName: {},
          idleCycles: 0,
          tasks: [],
          filesRead: [],
        },
      );

      const capabilities = createCapabilities();

      // Turn 1: model calls submitOutput
      const actions1 = await director.decide(
        {
          type: "inference.done",
          turn: {
            role: "assistant",
            model: "test",
            timestamp: 0,
            content: [
              {
                type: "tool_call",
                id: "call-1",
                name: "submit_output",
                arguments: { summary: "Done" },
              },
            ],
          },
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, thinking: 0 },
          source: { id: "xai", model: "test" },
        },
        {
          turns: [],
          activeForks: [],
          pendingOperations: [],
          activeGates: [],
          tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 },
          lastCycleUsage: null,
          lastCycleSource: null,
          sessionId: "test",
        },
        capabilities,
      );

      // Should execute tools (submitOutput is a tool call)
      expect(Array.isArray(actions1)).toBe(true);
      const arr1 = Array.isArray(actions1) ? actions1 : [actions1];
      expect(arr1.some((a) => a.type === "execute_tools")).toBe(true);

      // Tool result comes back
      const actions2 = await director.decide(
        {
          type: "tool.done",
          result: { callId: "call-1", content: "Submission accepted." },
        },
        {
          turns: [],
          activeForks: [],
          pendingOperations: [],
          activeGates: [],
          tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 },
          lastCycleUsage: null,
          lastCycleSource: null,
          sessionId: "test",
        },
        capabilities,
      );

      // Should re-infer after tools complete
      expect(Array.isArray(actions2)).toBe(true);
      const arr2 = Array.isArray(actions2) ? actions2 : [actions2];
      expect(arr2.some((a) => a.type === "infer")).toBe(true);

      // Turn 2: model returns empty text after seeing tool result
      const actions3 = await director.decide(
        {
          type: "inference.done",
          turn: {
            role: "assistant",
            model: "test",
            timestamp: 0,
            content: [{ type: "text", text: "" }],
          },
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, thinking: 0 },
          source: { id: "xai", model: "test" },
        },
        {
          turns: [],
          activeForks: [],
          pendingOperations: [],
          activeGates: [],
          tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 },
          lastCycleUsage: null,
          lastCycleSource: null,
          sessionId: "test",
        },
        capabilities,
      );

      // Should reply because submitOutput was previously called
      expect(Array.isArray(actions3)).toBe(true);
      const arr3 = Array.isArray(actions3) ? actions3 : [actions3];
      expect(arr3.some((a) => a.type === "reply")).toBe(true);
    } finally {
      harness.dispose();
    }
  });

  test("director aborts after 3 idle cycles", async () => {
    const harness = setupHarness();
    try {
      const director = createCodingDirector(
        buildSystemPrompt(),
        [submitOutputDefinition],
      );

      const capabilities = createCapabilities();
      const emptyState = {
        turns: [],
        activeForks: [],
        pendingOperations: [],
        activeGates: [],
        tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 },
        lastCycleUsage: null,
        lastCycleSource: null,
        sessionId: "test",
      };

      // 3 idle inference.done events with no tool calls
      for (let i = 0; i < 2; i++) {
        const actions = await director.decide(
          {
            type: "inference.done",
            turn: {
              role: "assistant",
              model: "test",
              timestamp: 0,
              content: [{ type: "text", text: "thinking..." }],
            },
            usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, thinking: 0 },
            source: { id: "xai", model: "test" },
          },
          emptyState,
          capabilities,
        );
        const arr = Array.isArray(actions) ? actions : [actions];
        expect(arr.some((a) => a.type === "reply")).toBe(true);
        expect(arr.some((a) => a.type === "done")).toBe(false);
      }

      // 3rd idle cycle should trigger abort
      const actions = await director.decide(
        {
          type: "inference.done",
          turn: {
            role: "assistant",
            model: "test",
            timestamp: 0,
            content: [{ type: "text", text: "still thinking..." }],
          },
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, thinking: 0 },
          source: { id: "xai", model: "test" },
        },
        emptyState,
        capabilities,
      );
      const arr = Array.isArray(actions) ? actions : [actions];
      expect(arr.some((a) => a.type === "done")).toBe(true);
    } finally {
      harness.dispose();
    }
  });

  test("director accepts submitOutput without a plan", async () => {
    const harness = setupHarness();
    try {
      const director = createCodingDirector(
        buildSystemPrompt(),
        [submitOutputDefinition],
      );

      const capabilities = createCapabilities();
      const emptyState = {
        turns: [],
        activeForks: [],
        pendingOperations: [],
        activeGates: [],
        tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 },
        lastCycleUsage: null,
        lastCycleSource: null,
        sessionId: "test",
      };

      // Turn 1: model calls submitOutput
      const actions1 = await director.decide(
        {
          type: "inference.done",
          turn: {
            role: "assistant",
            model: "test",
            timestamp: 0,
            content: [
              {
                type: "tool_call",
                id: "out-1",
                name: "submit_output",
                arguments: { summary: "Done" },
              },
            ],
          },
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, thinking: 0 },
          source: { id: "xai", model: "test" },
        },
        emptyState,
        capabilities,
      );
      expect(Array.isArray(actions1)).toBe(true);

      // Tool result for submitOutput
      const actions2 = await director.decide(
        {
          type: "tool.done",
          result: { callId: "out-1", content: "Submission accepted." },
        },
        emptyState,
        capabilities,
      );
      const arr2 = Array.isArray(actions2) ? actions2 : [actions2];
      expect(arr2.some((a) => a.type === "infer")).toBe(true);

      // Turn 2: empty text after seeing tool result
      const actions3 = await director.decide(
        {
          type: "inference.done",
          turn: {
            role: "assistant",
            model: "test",
            timestamp: 0,
            content: [{ type: "text", text: "" }],
          },
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, thinking: 0 },
          source: { id: "xai", model: "test" },
        },
        emptyState,
        capabilities,
      );
      const arr3 = Array.isArray(actions3) ? actions3 : [actions3];
      expect(arr3.some((a) => a.type === "reply")).toBe(true);
      expect(director.getState().submitCalled).toBe(true);
    } finally {
      harness.dispose();
    }
  });

});
