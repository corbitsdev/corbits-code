import { describe, test, expect } from "bun:test";

import { createCapabilities } from "@intx/inference";
import { setupHarness } from "@intx/inference-testing";

import { createCodingDirector, submitOutputDefinition } from "../../src/director.js";
import { buildSystemPrompt } from "../../src/prompts.js";

describe("agent loop", () => {
  test("director aborts after submitOutput", async () => {
    const harness = setupHarness();
    try {
      const director = createCodingDirector(
        buildSystemPrompt(),
        [submitOutputDefinition],
        10,
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
                name: "submitOutput",
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

  test("director aborts at max turns", async () => {
    const harness = setupHarness();
    try {
      const director = createCodingDirector(
        buildSystemPrompt(),
        [submitOutputDefinition],
        2,
      );

      const capabilities = createCapabilities();

      // Turn 1: empty text (no tools)
      const actions1 = await director.decide(
        {
          type: "inference.done",
          turn: {
            role: "assistant",
            model: "test",
            timestamp: 0,
            content: [{ type: "text", text: "Thinking..." }],
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

      // Default director replies and waits
      const arr1 = Array.isArray(actions1) ? actions1 : [actions1];
      expect(arr1.some((a) => a.type === "reply")).toBe(true);

      // Turn 2: empty text again (reaches max turns)
      const actions2 = await director.decide(
        {
          type: "inference.done",
          turn: {
            role: "assistant",
            model: "test",
            timestamp: 0,
            content: [{ type: "text", text: "Still thinking..." }],
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

      // Should reply because max turns reached
      const arr2 = Array.isArray(actions2) ? actions2 : [actions2];
      expect(arr2.some((a) => a.type === "reply")).toBe(true);
    } finally {
      harness.dispose();
    }
  });
});
