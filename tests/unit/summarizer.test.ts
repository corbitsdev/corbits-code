import { test, expect } from "bun:test";
import { setupHarness } from "@intx/inference-testing";
import type { ConversationTurn, InferenceSource } from "@intx/types/runtime";
import {
  buildSummaryPrompt,
  condenseTurns,
  createModelSummarizer,
  DEFAULT_SUMMARIZER_TIMEOUT_MS,
} from "../../src/session/summarizer.js";
import type { Telemetry, TelemetryEvent } from "../../src/telemetry/index.js";

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

function stubTelemetry(): {
  telemetry: Telemetry;
  events: {
    event: TelemetryEvent;
    properties?: Record<string, unknown> | undefined;
  }[];
} {
  const events: {
    event: TelemetryEvent;
    properties?: Record<string, unknown> | undefined;
  }[] = [];
  const telemetry: Telemetry = {
    enabled: true,
    installationId: "test",
    capture: (event, properties) => {
      events.push({ event, properties });
    },
    captureIntentional: () => false,
    flush: async () => undefined,
    discard: () => undefined,
  };
  return { telemetry, events };
}

// Structured InferenceError riding `cause`, exactly how defaultComplete
// rethrows the harness's classified error.
function inferenceFailure(fields: {
  category: string;
  message: string;
  statusCode?: number;
}): Error {
  return new Error(fields.message, {
    cause: {
      category: fields.category,
      message: fields.message,
      ...(fields.statusCode !== undefined
        ? { statusCode: fields.statusCode }
        : {}),
    },
  });
}

test("summarizer timeout is honoured independently of the director total timeout", async () => {
  const harness = setupHarness({ enableInferenceTimers: true });
  try {
    // The stream parks forever; only the summarizer's own timer can end the call.
    harness.scenario.stall();
    const summarize = createModelSummarizer({
      getSource: () => ({
        id: "anthropic",
        provider: "anthropic",
        model: "claude-test",
        baseURL: "https://api.anthropic.com",
        apiKey: "k",
      }),
      deps: harness.deps,
      timeoutMs: 30_000,
    });
    const pending = summarize(turns());
    await harness.run();
    await expect(pending).rejects.toThrow("total timeout (30000 ms");
  } finally {
    harness.dispose();
  }
});

test("default summarizer timeout stays well under the director's 600s", () => {
  expect(DEFAULT_SUMMARIZER_TIMEOUT_MS).toBeLessThanOrEqual(120_000);
  expect(DEFAULT_SUMMARIZER_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
});

test("a 401 retries once after a credential re-read", async () => {
  let calls = 0;
  let refreshes = 0;
  const summarize = createModelSummarizer({
    getSource: () => source,
    refreshAuth: async () => {
      refreshes++;
    },
    complete: async () => {
      calls++;
      if (calls === 1)
        throw inferenceFailure({
          category: "credential_failure",
          message: "Unauthorized",
          statusCode: 401,
        });
      return "## What Happened\n- recovered";
    },
  });
  const result = await summarize(turns());
  expect(result).toContain("recovered");
  expect(calls).toBe(2);
  expect(refreshes).toBe(1);
});

test("a second 401 fails: retry budget is spent once", async () => {
  let calls = 0;
  let refreshes = 0;
  const notices: string[] = [];
  const summarize = createModelSummarizer({
    getSource: () => source,
    refreshAuth: async () => {
      refreshes++;
    },
    onFailure: (text) => notices.push(text),
    complete: async () => {
      calls++;
      throw new Error("HTTP 401 Unauthorized");
    },
  });
  await expect(summarize(turns())).rejects.toThrow("401");
  expect(calls).toBe(2);
  expect(refreshes).toBe(1);
  expect(notices).toHaveLength(1);
  expect(notices[0]).toContain("401");
});

test("a 401 without a refresh hook is not retried", async () => {
  let calls = 0;
  const summarize = createModelSummarizer({
    getSource: () => source,
    complete: async () => {
      calls++;
      throw new Error("HTTP 401 Unauthorized");
    },
  });
  await expect(summarize(turns())).rejects.toThrow("401");
  expect(calls).toBe(1);
});

test("a provider 5xx retries exactly once", async () => {
  let calls = 0;
  let refreshes = 0;
  const summarize = createModelSummarizer({
    getSource: () => source,
    refreshAuth: async () => {
      refreshes++;
    },
    complete: async () => {
      calls++;
      if (calls <= 2)
        throw inferenceFailure({
          category: "retryable",
          message: "HTTP 503 Service Unavailable",
          statusCode: 503,
        });
      return "done";
    },
  });
  await expect(summarize(turns())).rejects.toThrow("503");
  expect(calls).toBe(2);
  expect(refreshes).toBe(0);
});

test("a provider internal-generation error retries once", async () => {
  let calls = 0;
  const summarize = createModelSummarizer({
    getSource: () => source,
    complete: async () => {
      calls++;
      if (calls === 1)
        throw inferenceFailure({
          category: "protocol_mismatch",
          message: "grok-responses: Internal error during token generation",
        });
      return "## What Happened\n- recovered";
    },
  });
  const result = await summarize(turns());
  expect(result).toContain("recovered");
  expect(calls).toBe(2);
});

test("a timeout is never retried", async () => {
  let calls = 0;
  const summarize = createModelSummarizer({
    getSource: () => source,
    complete: async () => {
      calls++;
      throw inferenceFailure({
        category: "timeout",
        message: "inference call exceeded total timeout (90000 ms wall-clock)",
      });
    },
  });
  await expect(summarize(turns())).rejects.toThrow("total timeout");
  expect(calls).toBe(1);
});

test("final failure throws, notices once, and reports telemetry", async () => {
  const { telemetry, events } = stubTelemetry();
  const notices: string[] = [];
  let calls = 0;
  const summarize = createModelSummarizer({
    getSource: () => source,
    telemetry,
    onFailure: (text) => notices.push(text),
    complete: async () => {
      calls++;
      throw inferenceFailure({
        category: "retryable",
        message: "HTTP 500 Internal Server Error",
        statusCode: 500,
      });
    },
  });
  await expect(summarize(turns())).rejects.toThrow("500");
  expect(calls).toBe(2);
  expect(notices).toHaveLength(1);
  expect(notices[0]).toContain("500");
  expect(events).toHaveLength(1);
  expect(events[0]?.event).toBe("summarizer_failure");
  expect(events[0]?.properties?.error_kind).toBe("provider");
  expect(events[0]?.properties?.provider).toBe("openai");
  expect(events[0]?.properties?.model).toBe("test-model");
  expect(typeof events[0]?.properties?.duration_ms).toBe("number");
});
