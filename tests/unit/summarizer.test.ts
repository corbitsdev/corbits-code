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
      content: [
        {
          type: "text",
          text: "Fix the login bug, see https://example.com/ticket/42",
        },
      ],
      timestamp: 1,
    },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Looking at the auth handler." },
        {
          type: "tool_call",
          id: "c1",
          name: "read_file",
          arguments: { path: "src/auth.ts" },
        },
      ],
      model: "test-model",
      timestamp: 2,
    },
    {
      role: "assistant",
      content: [
        {
          type: "tool_call",
          id: "c2",
          name: "edit_file",
          arguments: { path: "src/session.ts" },
        },
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

test("model summarizer throws on failure instead of substituting a stats stub", async () => {
  const summarize = createModelSummarizer({
    getSource: () => source,
    complete: async () => {
      throw new Error("model unreachable");
    },
  });
  await expect(summarize(turns())).rejects.toThrow("model unreachable");
});

test("model summarizer throws when the model returns empty text", async () => {
  const summarize = createModelSummarizer({
    getSource: () => source,
    complete: async () => "",
  });
  await expect(summarize(turns())).rejects.toThrow("empty text");
});

test("model summarizer feeds archive payloads into the prompt instead of clipped turns", async () => {
  const longPayload = `FULL_ARCHIVE_PAYLOAD ${"x".repeat(600)}`;
  let captured = "";
  const summarize = createModelSummarizer({
    getSource: () => source,
    complete: async (promptTurns) => {
      const user = promptTurns.find((t) => t.role === "user");
      const block = user?.content.find((b) => b.type === "text");
      captured = block !== undefined && block.type === "text" ? block.text : "";
      return "## What Happened\n- used archive evidence";
    },
    getArchive: () => ({
      listOccurrences: async () => [
        {
          occurrenceId: "occ-user",
          sessionId: "s1",
          kind: "user_message" as const,
          contentHash: "h1",
          blobKey: "k1",
          recordedAt: 1,
        },
      ],
      readAuthorizedPayload: async () => longPayload,
    }),
  });
  const result = await summarize(turns());
  expect(result).toContain("What Happened");
  expect(captured).toContain(longPayload);
  expect(captured).toContain("archive:///occ-user");
});

test("buildSummaryPrompt uses a supplied excerpt instead of condensing turns", () => {
  const prompt = buildSummaryPrompt(turns(), undefined, "ARCHIVE_EXCERPT_BODY");
  expect(prompt).toContain("ARCHIVE_EXCERPT_BODY");
  expect(prompt).not.toContain("Turns dropped");
});
