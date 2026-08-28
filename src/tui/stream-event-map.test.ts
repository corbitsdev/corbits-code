import { describe, expect, test } from "bun:test";
import {
  createStreamMapContext,
  mapProductionEvent,
  mapProductionSequence,
  mapReactorLike,
} from "./stream-event-map.js";

describe("mapProductionEvent", () => {
  test("message.received → user text", () => {
    expect(
      mapProductionEvent({
        type: "message.received",
        data: { message: { content: "hello" } },
      }),
    ).toEqual([{ type: "user", text: "hello" }]);
  });

  test("inference.start → busy run", () => {
    expect(mapProductionEvent({ type: "inference.start" })).toEqual([
      { type: "attempt", action: "mark" },
      { type: "run", state: "busy" },
    ]);
  });

  test("text deltas stream as assistant.delta", () => {
    const ctx = createStreamMapContext();
    expect(
      mapProductionEvent({ type: "inference.text.delta", data: { token: "Hi" } }, ctx),
    ).toEqual([{ type: "assistant.delta", text: "Hi" }]);
    expect(mapProductionEvent({ type: "inference.text.delta", data: { token: "!" } }, ctx)).toEqual(
      [{ type: "assistant.delta", text: "!" }],
    );
  });

  test("tool_call.start+end paints once with args (stateful)", () => {
    const ctx = createStreamMapContext();
    expect(
      mapProductionEvent(
        {
          type: "inference.tool_call.start",
          data: { name: "read_file", callId: "c1" },
        },
        ctx,
      ),
    ).toEqual([]);
    expect(
      mapProductionEvent(
        {
          type: "inference.tool_call.end",
          data: {
            name: "read_file",
            callId: "c1",
            arguments: { path: "a.ts" },
          },
        },
        ctx,
      ),
    ).toEqual([
      {
        type: "tool_call",
        name: "read_file",
        detail: JSON.stringify({ path: "a.ts" }),
        callId: "c1",
      },
    ]);
  });

  test("tool.done → tool_result + tool.boundary", () => {
    const out = mapProductionEvent({
      type: "tool.done",
      data: {
        result: {
          name: "read_file",
          content: "ok",
          isError: false,
        },
      },
    });
    expect(out).toEqual([
      { type: "tool_result", name: "read_file", detail: "ok" },
      { type: "tool.boundary" },
    ]);
  });

  test("reactor.done → idle + boundary", () => {
    expect(mapProductionEvent({ type: "reactor.done" })).toEqual([
      { type: "run", state: "idle" },
      { type: "tool.boundary" },
    ]);
  });

  test("connector.reply after deltas is skipped (already painted)", () => {
    const ctx = createStreamMapContext();
    mapProductionEvent({ type: "inference.text.delta", data: { token: "partial" } }, ctx);
    expect(
      mapProductionEvent({ type: "connector.reply", data: { content: "final answer" } }, ctx),
    ).toEqual([]);
  });

  test("connector.reply without prior deltas becomes assistant", () => {
    expect(
      mapProductionEvent({
        type: "connector.reply",
        data: { content: "final answer" },
      }),
    ).toEqual([{ type: "assistant", text: "final answer" }]);
  });

  test("empty user content ignored", () => {
    expect(
      mapProductionEvent({
        type: "message.received",
        data: { message: { content: "   " } },
      }),
    ).toEqual([]);
  });

  test("mapReactorLike matches stateless mapProductionEvent", () => {
    const ev = { type: "inference.start" as const };
    expect(mapReactorLike(ev)).toEqual(mapProductionEvent(ev));
  });

  test("mapProductionSequence folds context across events", () => {
    const out = mapProductionSequence([
      { type: "inference.start" },
      {
        type: "inference.tool_call.start",
        data: { name: "grep", callId: "t1" },
      },
      {
        type: "inference.tool_call.end",
        data: { name: "grep", callId: "t1", arguments: { q: "x" } },
      },
      {
        type: "tool.done",
        data: { result: { callId: "t1", name: "grep", content: "hits" } },
      },
      { type: "reactor.done" },
    ]);
    expect(out.map((e) => e.type)).toEqual([
      "attempt",
      "run",
      "tool_call",
      "tool_result",
      "tool.boundary",
      "attempt",
      "run",
      "tool.boundary",
    ]);
  });
});

describe("stream sanitization", () => {
  const textDelta = (token: string) => ({
    type: "inference.text.delta",
    data: { token },
  });
  const joined = (events: readonly { type: string; data?: unknown }[]) =>
    mapProductionSequence(events)
      .filter((e) => e.type === "assistant.delta" || e.type === "thinking.delta")
      .map((e) => (e as { text: string }).text)
      .join("");

  test("strips an escape sequence contained in one delta", () => {
    expect(joined([textDelta("hi \x1b[31mred\x1b[0m"), { type: "reactor.done" }])).toBe("hi red");
  });

  test("strips a CSI sequence split across two deltas", () => {
    expect(joined([textDelta("hi \x1b["), textDelta("31mred"), { type: "reactor.done" }])).toBe(
      "hi red",
    );
  });

  test("strips an OSC 52 payload split across three deltas", () => {
    expect(
      joined([
        textDelta("a\x1b]52;c;"),
        textDelta("ZXZpbA=="),
        textDelta("\x07b"),
        { type: "reactor.done" },
      ]),
    ).toBe("ab");
  });

  test("strips bidi overrides from thinking deltas", () => {
    expect(
      joined([
        {
          type: "inference.thinking.delta",
          data: { token: "safe\u202eevil\u202c" },
        },
        { type: "reactor.done" },
      ]),
    ).toBe("safeevil");
  });

  test("keeps markdown syntax and an emoji split across deltas", () => {
    const rocket = "\u{1f680}";
    expect(
      joined([
        textDelta("**bold** `code` [x](y) " + rocket.slice(0, 1)),
        textDelta(rocket.slice(1) + " done"),
        { type: "reactor.done" },
      ]),
    ).toBe(`**bold** \`code\` [x](y) ${rocket} done`);
  });

  test("drops a partial sequence still held when the burst ends", () => {
    const ctx = createStreamMapContext();
    expect(mapProductionEvent(textDelta("x\x1b["), ctx)).toEqual([
      { type: "assistant.delta", text: "x" },
    ]);
    expect(mapProductionEvent({ type: "reactor.done" }, ctx).map((e) => e.type)).toEqual([
      "run",
      "tool.boundary",
    ]);
  });

  test("sanitizes non-streamed connector replies", () => {
    expect(
      mapProductionEvent({
        type: "connector.reply",
        data: { content: "ok\x1b[2Jgone" },
      }),
    ).toEqual([{ type: "assistant", text: "okgone" }]);
  });
});

describe("inference.retry", () => {
  const actions = (events: readonly { type: string }[]) =>
    events
      .filter((e): e is { type: "attempt"; action: string } => e.type === "attempt")
      .map((e) => e.action);

  test("a harness pre-commit retry retracts nothing", () => {
    const ctx = createStreamMapContext();
    expect(mapProductionEvent({ type: "inference.retry", data: { attempt: 1 } }, ctx)).toEqual([]);
  });

  test("a committed retry after a streamed attempt rolls back", () => {
    const out = mapProductionSequence([
      { type: "inference.start" },
      { type: "inference.text.delta", data: { token: "partial" } },
      { type: "inference.retry", data: { attempt: 1 } },
      { type: "inference.start" },
    ]);
    expect(actions(out)).toEqual(["mark", "rollback", "mark"]);
  });

  test("a committed retry consumes the boundary handed off by inference.error", () => {
    const out = mapProductionSequence([
      { type: "inference.start" },
      { type: "inference.text.delta", data: { token: "partial" } },
      { type: "inference.error", data: { error: { message: "rate limited" } } },
      { type: "inference.retry", data: { attempt: 1 } },
    ]);
    expect(actions(out)).toEqual(["mark", "rollback"]);
  });

  test("a settled cycle disarms, so the next cycle's pre-commit retry is inert", () => {
    const out = mapProductionSequence([
      { type: "inference.start" },
      { type: "inference.text.delta", data: { token: "answer" } },
      { type: "inference.done" },
      { type: "inference.retry", data: { attempt: 1 } },
    ]);
    expect(actions(out)).toEqual(["mark", "clear"]);
  });

  test("any event other than the retry expires the error handoff", () => {
    const out = mapProductionSequence([
      { type: "inference.start" },
      { type: "inference.text.delta", data: { token: "partial" } },
      { type: "inference.error", data: { error: { message: "fatal" } } },
      { type: "message.received", data: { message: { content: "next" } } },
      { type: "inference.retry", data: { attempt: 1 } },
    ]);
    expect(actions(out)).toEqual(["mark", "clear"]);
  });

  test("a user message disarms so a retry can never erase it", () => {
    const out = mapProductionSequence([
      { type: "inference.start" },
      { type: "message.received", data: { message: { content: "steer" } } },
      { type: "inference.retry", data: { attempt: 1 } },
    ]);
    expect(actions(out)).toEqual(["mark", "clear"]);
  });

  test("rollback forgets tool calls the failed attempt opened", () => {
    const ctx = createStreamMapContext();
    mapProductionSequence(
      [
        { type: "inference.start" },
        {
          type: "inference.tool_call.end",
          data: { name: "bash", callId: "c1", arguments: { command: "ls" } },
        },
        { type: "inference.retry", data: { attempt: 1 } },
      ],
      ctx,
    );
    expect(ctx.callIdToName.has("c1")).toBe(false);
    expect(ctx.emittedToolCalls.has("c1")).toBe(false);
  });
});

describe("inference.error text", () => {
  const message = (error: unknown) => {
    const [event] = mapProductionEvent({ type: "inference.error", data: { error } });
    return event?.type === "error" ? event.message : undefined;
  };

  test("a classified failure gets its written line, not the provider body", () => {
    expect(message({ category: "credential_failure", message: '{"error":{"code":401}}' })).toBe(
      "Authentication failed — log in again.",
    );
    expect(message({ category: "quota_exhausted", message: "429" })).toBe(
      "Quota exhausted — usage limit reached.",
    );
  });

  test("a context overflow mislabeled as quota is read from the message", () => {
    expect(
      message({ category: "quota_exhausted", message: "input is too long for this model" }),
    ).toContain("Context window full");
  });

  test("Codex usage_limit_reached raw body surfaces reset ETA and profile switch", () => {
    const line = message({
      category: "quota_exhausted",
      message: "Too Many Requests",
      statusCode: 429,
      providerId: "codex/abk-labs",
      raw: {
        detail: {
          error: {
            code: "usage_limit_reached",
            message: "You have reached your usage limit.",
            plan_type: "workspace_member",
            resets_in_seconds: 3435,
          },
        },
      },
    });
    expect(line).toContain('Codex profile "abk-labs"');
    expect(line).toMatch(/Resets in ~/);
    expect(line).toContain("/model");
  });

  test("ctx.providerId xAI + bare quota_exhausted 429 shows rate-limit copy", () => {
    const ctx = createStreamMapContext({ providerId: "xai/thegreataxios" });
    const [event] = mapProductionEvent(
      {
        type: "inference.error",
        data: {
          error: {
            category: "quota_exhausted",
            message: "Too Many Requests",
            statusCode: 429,
            raw: { error: { message: "Too Many Requests" } },
          },
        },
      },
      ctx,
    );
    expect(event?.type).toBe("error");
    if (event?.type !== "error") return;
    expect(event.message.toLowerCase()).toMatch(/rate limit/);
    expect(event.message).not.toContain("Quota exhausted");
  });

  test("ctx.providerId Codex + ChatGPT usage-limit 429 shows rate-limit copy", () => {
    const ctx = createStreamMapContext({ providerId: "codex/abk-labs" });
    const [event] = mapProductionEvent(
      {
        type: "inference.error",
        data: {
          error: {
            category: "quota_exhausted",
            message: "You have hit your ChatGPT usage limit",
            statusCode: 429,
            raw: "You have hit your ChatGPT usage limit",
          },
        },
      },
      ctx,
    );
    expect(event?.type).toBe("error");
    if (event?.type !== "error") return;
    expect(event.message.toLowerCase()).toMatch(/rate limit/);
    expect(event.message).not.toContain("Quota exhausted");
    expect(event.message.toLowerCase()).not.toContain("usage limit reached");
  });

  test("bare quota_exhausted 429 without ctx/provider still shows Quota exhausted", () => {
    expect(
      message({
        category: "quota_exhausted",
        message: "Too Many Requests",
        statusCode: 429,
        raw: { error: { message: "Too Many Requests" } },
      }),
    ).toBe("Quota exhausted — usage limit reached.");
  });

  test("an unclassified failure keeps the provider's own words", () => {
    expect(message({ message: "socket hang up" })).toBe("socket hang up");
    expect(message({ category: "wat", message: "socket hang up" })).toBe("socket hang up");
  });
});
