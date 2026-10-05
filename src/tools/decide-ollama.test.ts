import { describe, expect, test } from "bun:test";
import { createOllamaSystemOneEvaluator } from "./decide-ollama.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const choiceQuestion = {
  id: "route",
  type: "choice" as const,
  instructions: "Which route?",
  criteria: { cheap: "Cheap model", strong: "Strong model" },
};

describe("createOllamaSystemOneEvaluator (stub fetch)", () => {
  test("success posts model/state/questions and returns decisions", async () => {
    let seenUrl = "";
    let seenBody: Record<string, unknown> = {};
    const fetchFn = (async (url: unknown, init?: RequestInit) => {
      seenUrl = String(url);
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({
        answers: { route: { choice: "cheap", confidence: 0.9 } },
      });
    }) as unknown as typeof fetch;
    const evaluate = createOllamaSystemOneEvaluator({
      rootURL: "http://127.0.0.1:11434/",
      model: "clef-flash",
      fetchFn,
    });
    const result = await evaluate({
      state: { task: "route this" },
      questions: [choiceQuestion],
    });
    expect(seenUrl).toBe("http://127.0.0.1:11434/v1/systemone");
    expect(seenBody.model).toBe("clef-flash");
    expect(seenBody.state).toEqual({ task: "route this" });
    expect(seenBody.questions).toEqual({
      route: {
        type: "choice",
        instructions: "Which route?",
        criteria: { cheap: "Cheap model", strong: "Strong model" },
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.decisions).toEqual([
        { id: "route", choice: "cheap", confidence: 0.9 },
      ]);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    }
  });

  test("unknown choice maps to fallback", async () => {
    const fetchFn = (async () =>
      jsonResponse({
        answers: { route: { choice: "nope" } },
      })) as unknown as typeof fetch;
    const evaluate = createOllamaSystemOneEvaluator({
      rootURL: "http://127.0.0.1:11434",
      model: "clef-flash",
      fetchFn,
    });
    const result = await evaluate({
      state: {},
      questions: [choiceQuestion],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fallback).toBe(true);
      expect(result.reason).toBe("parse-error");
      expect(result.detail).toContain("unknown choice");
    }
  });

  test("timeout maps to fallback", async () => {
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      await new Promise<void>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("This operation was aborted", "AbortError"));
        });
      });
      throw new Error("unreachable");
    }) as unknown as typeof fetch;
    const evaluate = createOllamaSystemOneEvaluator({
      rootURL: "http://127.0.0.1:11434",
      model: "clef-flash",
      fetchFn,
    });
    const result = await evaluate({
      state: {},
      questions: [choiceQuestion],
      timeoutMs: 20,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fallback).toBe(true);
      expect(result.reason).toBe("timeout");
    }
  });

  test("http error maps to fallback", async () => {
    const fetchFn = (async () =>
      new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const evaluate = createOllamaSystemOneEvaluator({
      rootURL: "http://127.0.0.1:11434",
      model: "clef-flash",
      fetchFn,
    });
    const result = await evaluate({
      state: {},
      questions: [choiceQuestion],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fallback).toBe(true);
      expect(result.reason).toBe("http-error");
      expect(result.detail).toContain("500");
    }
  });

  test("connection refused maps to fallback", async () => {
    const fetchFn = (async () => {
      throw new TypeError("fetch failed: connection refused");
    }) as unknown as typeof fetch;
    const evaluate = createOllamaSystemOneEvaluator({
      rootURL: "http://127.0.0.1:9",
      model: "clef-flash",
      fetchFn,
    });
    const result = await evaluate({
      state: {},
      questions: [choiceQuestion],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fallback).toBe(true);
      expect(result.reason).toBe("network");
    }
  });
});

describe("createOllamaSystemOneEvaluator (live, opt-in)", () => {
  test("live ollama answers a choice question", async () => {
    let reachable = false;
    try {
      const probe = await fetch("http://127.0.0.1:11434/", {
        signal: AbortSignal.timeout(1000),
      });
      reachable = probe.status < 500;
    } catch {
      reachable = false;
    }
    if (!reachable) {
      return;
    }
    const evaluate = createOllamaSystemOneEvaluator({
      rootURL: "http://127.0.0.1:11434",
      model: "clef-flash",
    });
    const result = await evaluate({
      state: { task: "route this" },
      questions: [choiceQuestion],
      timeoutMs: 30_000,
    });
    // Live behavior is informative only: either a decision or a clean fallback.
    if (result.ok) {
      expect(result.decisions).toHaveLength(1);
    } else {
      expect(result.fallback).toBe(true);
    }
  }, 60_000);
});
