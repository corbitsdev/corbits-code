import { afterEach, describe, expect, test } from "bun:test";
import {
  RING_CAPACITY,
  clear,
  end,
  mark,
  sanitizeTags,
  snapshot,
  start,
  type PerfSpan,
} from "./index.js";

afterEach(() => {
  clear();
});

describe("start / end / mark", () => {
  test("records a completed span with monotonic times", () => {
    const id = start("inference");
    expect(id.length).toBeGreaterThan(0);
    end(id);

    const spans = snapshot();
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.name).toBe("inference");
    expect(span.endNs).toBeDefined();
    expect(span.endNs! >= span.startNs).toBe(true);
  });

  test("nests via parentId", () => {
    const turnId = start("turn");
    const infId = start("inference", { parentId: turnId });
    end(infId);
    end(turnId);

    const spans = snapshot();
    expect(spans).toHaveLength(2);
    const inference = spans.find((s) => s.name === "inference")!;
    const turn = spans.find((s) => s.name === "turn")!;
    expect(inference.parentId).toBe(turnId);
    expect(turn.parentId).toBeUndefined();
  });

  test("mark is a completed point-in-time span", () => {
    const id = mark("adapter.transport", { transport: "http_sse" });
    expect(id.length).toBeGreaterThan(0);

    const spans = snapshot();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.startNs).toBe(spans[0]!.endNs!);
    expect(spans[0]!.tags).toEqual({ transport: "http_sse" });
  });

  test("open spans appear in snapshot without endNs", () => {
    const id = start("session");
    const spans = snapshot();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.id).toBe(id);
    expect(spans[0]!.endNs).toBeUndefined();
  });

  test("unknown span names are ignored", () => {
    expect(start("not.a.phase")).toBe("");
    expect(mark("also.bad")).toBe("");
    expect(snapshot()).toHaveLength(0);
  });

  test("end of unknown id is a no-op", () => {
    end("nope");
    end("");
    expect(snapshot()).toHaveLength(0);
  });

  test("end merges sanitized tags onto the span", () => {
    const id = start("tool", { tags: { tool_id: "t1" } });
    end(id, { count: 3, prompt: "secret" });
    const span = snapshot()[0]!;
    expect(span.tags).toEqual({ tool_id: "t1", count: 3 });
  });
});

describe("ring overflow", () => {
  test("drops oldest completed spans when capacity is exceeded", () => {
    // Fill past capacity with marks (cheap completed spans).
    for (let i = 0; i < RING_CAPACITY + 10; i += 1) {
      mark("tool", { count: i });
    }

    const spans = snapshot();
    expect(spans).toHaveLength(RING_CAPACITY);

    // Oldest surviving should be count = 10 (0..9 dropped).
    const first = spans[0]!;
    const last = spans[spans.length - 1]!;
    expect(first.tags?.count).toBe(10);
    expect(last.tags?.count).toBe(RING_CAPACITY + 9);
  });

  test("clear empties ring and open spans", () => {
    start("session");
    mark("turn");
    clear();
    expect(snapshot()).toHaveLength(0);
  });
});

describe("sanitizeTags", () => {
  test("keeps allowlisted enums, numbers, and opaque ids", () => {
    const tags = sanitizeTags({
      provider_id: "openai",
      model_id: "gpt-5.4",
      transport: "ws",
      duration_ms: 12.5,
      bytes: 1024,
      payload_bytes: 2048,
      count: 2,
      input_tokens: 100,
      output_tokens: 50,
      turn_id: "t1a2b3",
      subagent_id: "sa_9",
      tool_id: "call-01",
    });
    expect(tags).toEqual({
      provider_id: "openai",
      model_id: "gpt-5.4",
      transport: "ws",
      duration_ms: 12.5,
      bytes: 1024,
      payload_bytes: 2048,
      count: 2,
      input_tokens: 100,
      output_tokens: 50,
      turn_id: "t1a2b3",
      subagent_id: "sa_9",
      tool_id: "call-01",
    });
  });

  test("strips free-text, paths, prompts, and unknown keys", () => {
    const tags = sanitizeTags({
      prompt: "system: you are a helpful assistant",
      path: "/Users/me/secret/repo/src/main.ts",
      error: "ENOENT: no such file or directory",
      message: "user said hello",
      stack: "Error\n    at foo (/app/x.ts:1:1)",
      tool_args: JSON.stringify({ cmd: "rm -rf /" }),
      completion: "sure, here is the code",
      repo: "abklabs/corbits-code",
      unknown_key: "whatever",
      // also invalid values on allowed keys
      transport: "grpc",
      model_id: "has spaces and /path",
      provider_id: "a".repeat(100),
      duration_ms: Number.NaN,
      count: Infinity,
      bytes: "not-a-number",
    });
    expect(tags).toBeUndefined();
  });

  test("returns undefined for null, undefined, or empty input", () => {
    expect(sanitizeTags(undefined)).toBeUndefined();
    expect(sanitizeTags(null)).toBeUndefined();
    expect(sanitizeTags({})).toBeUndefined();
  });

  test("strips path-like opaque ids", () => {
    expect(sanitizeTags({ turn_id: "../../etc/passwd" })).toBeUndefined();
    expect(sanitizeTags({ model_id: "C:\\Windows\\System32" })).toBeUndefined();
  });
});

describe("open/close budget", () => {
  test("start+end stays well under 50µs average", () => {
    // Warm up JIT / maps.
    for (let i = 0; i < 200; i += 1) {
      const id = start("inference");
      end(id);
    }
    clear();

    const iterations = 5_000;
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < iterations; i += 1) {
      const id = start("inference", { tags: { provider_id: "openai", model_id: "gpt-5.4" } });
      end(id, { duration_ms: 1 });
    }
    const t1 = process.hrtime.bigint();
    const avgNs = Number(t1 - t0) / iterations;
    // Budget: open/close on the order of microseconds. 50µs avg is a loose
    // ceiling that still fails if we regress into heavy work (I/O, crypto, etc.).
    expect(avgNs).toBeLessThan(50_000);
  });
});

describe("snapshot shape", () => {
  test("completed spans retain only allowlisted fields", () => {
    const id = start("adapter.request_build", {
      parentId: "parent1",
      tags: {
        transport: "http_sse",
        payload_bytes: 4096,
        prompt: "DROP ME",
      },
    });
    end(id);

    const span: PerfSpan = snapshot()[0]!;
    expect(Object.keys(span).sort()).toEqual(["endNs", "id", "name", "parentId", "startNs", "tags"].sort());
    expect(span.tags).toEqual({ transport: "http_sse", payload_bytes: 4096 });
    expect(span.parentId).toBe("parent1");
  });
});
