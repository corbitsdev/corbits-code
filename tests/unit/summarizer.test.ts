import { test, expect } from "bun:test";
import type { ConversationTurn, InferenceSource } from "@intx/types/runtime";
import {
  buildSummaryPrompt,
  condenseTurns,
  createModelSummarizer,
} from "../../src/session/summarizer.js";

const source: InferenceSource = {
  id: "test",
  provider: "openai",
  model: "test-model",
  baseURL: "http://localhost:1",
  apiKey: "k",
};

function turns(): ConversationTurn[] {
  return [
    {
      role: "user",
      content: [{ type: "text", text: "Fix the login bug, see https://example.com/ticket/42" }],
      timestamp: 1,
    },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Looking at the auth handler." },
        { type: "tool_call", id: "c1", name: "read_file", arguments: { path: "src/auth.ts" } },
      ],
      model: "test-model",
      timestamp: 2,
    },
    {
      role: "assistant",
      content: [
        { type: "tool_call", id: "c2", name: "edit_file", arguments: { path: "src/session.ts" } },
      ],
      model: "test-model",
      timestamp: 3,
    },
  ];
}

test("condenseTurns extracts files, tools, and links", () => {
  const out = condenseTurns(turns());
  expect(out).toContain("src/auth.ts");
  expect(out).toContain("src/session.ts");
  expect(out).toContain("read_file");
  expect(out).toContain("edit_file");
  expect(out).toContain("https://example.com/ticket/42");
});

test("buildSummaryPrompt injects active workflow context", () => {
  const prompt = buildSummaryPrompt(turns(), {
    workflow: { name: "build", stepLabel: "Implement", stepIndex: 2, total: 7 },
  });
  expect(prompt).toContain("/build");
  expect(prompt).toContain("step 3/7");
  expect(prompt).toContain("Implement");
  expect(prompt).toContain("mid-workflow");
});

test("buildSummaryPrompt omits workflow preamble when none active", () => {
  const prompt = buildSummaryPrompt(turns());
  expect(prompt).not.toContain("Active workflow");
  expect(prompt).toContain("Session excerpt");
});

test("model summarizer returns the model output", async () => {
  const summarize = createModelSummarizer({
    getSource: () => source,
    complete: async () => "## What Happened\n- read src/auth.ts",
  });
  const result = await summarize(turns());
  expect(result).toContain("What Happened");
});

test("model summarizer falls back to deterministic summary on failure", async () => {
  const summarize = createModelSummarizer({
    getSource: () => source,
    complete: async () => {
      throw new Error("model unreachable");
    },
  });
  const result = await summarize(turns());
  // Deterministic fallback (buildTurnSummary) reports tool usage stats.
  expect(result).toContain("Tools called");
});

test("model summarizer falls back when the model returns empty text", async () => {
  const summarize = createModelSummarizer({
    getSource: () => source,
    complete: async () => "",
  });
  const result = await summarize(turns());
  expect(result).toContain("Tools called");
});

test("model summarizer marks a failure fallback as distinguishable from a real summary (CL-6906)", async () => {
  const summarize = createModelSummarizer({
    getSource: () => source,
    complete: async () => {
      throw new Error("model unreachable");
    },
  });
  const result = await summarize(turns());
  expect(result).toContain("[Model summary unavailable");
  expect(result).toContain("summary call failed");
});

test("model summarizer marks an empty-output fallback as distinguishable from a real summary (CL-6906)", async () => {
  const summarize = createModelSummarizer({
    getSource: () => source,
    complete: async () => "",
  });
  const result = await summarize(turns());
  expect(result).toContain("[Model summary unavailable");
  expect(result).toContain("empty model output");
});

test("model summarizer does not mark a real summary with the fallback marker", async () => {
  const summarize = createModelSummarizer({
    getSource: () => source,
    complete: async () => "## What Happened\n- read src/auth.ts",
  });
  const result = await summarize(turns());
  expect(result).not.toContain("[Model summary unavailable");
});
