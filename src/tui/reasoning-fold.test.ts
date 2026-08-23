/**
 * A turn's reasoning is one row.
 *
 * The model stops to think between tool calls, and each of those stops used to
 * open a row of its own — fragments of half-sentences breaking up a run of tool
 * rows that reads as one piece of work. They fold into the row the turn already
 * opened instead, which keeps every word reachable behind the expand key.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { attachSessionBridge, createRecordingPort } from "./runtime-bridge.js";
import { createHarness, type Harness } from "./harness.js";
import { createAppShell, toggleCollapsedRow } from "./shell.js";
import { isThinkingRow, rowGroupGap, type StreamRow } from "./stream.js";

type Bridge = ReturnType<typeof attachSessionBridge>;
type Shell = ReturnType<typeof createAppShell>;

// One renderer, one shell, one bridge for the file. Scenarios are separated by
// the thing under test — a turn boundary — rather than by a fresh surface each
// time, which would hold native handles the suite as a whole is short of.
let harness: Harness;
let shell: Shell;
let bridge: Bridge;
let mark = 0;

beforeAll(async () => {
  harness = await createHarness({ width: 80, height: 24 });
  shell = createAppShell(harness.renderer, {
    terminal: { columns: 80, rows: 24 },
    wireKeys: false,
    run: "idle",
  });
  bridge = attachSessionBridge(shell, createRecordingPort());
});

afterAll(() => {
  bridge.dispose();
  shell.dispose();
  harness.destroy();
});

/** Open a turn, and forget every row before it. */
function prompt(text: string): void {
  mark = shell.streamLog.length;
  bridge.handle({ type: "message.received", data: { message: { content: text } } });
}

/** Rows this turn appended. */
function rows(): readonly StreamRow[] {
  return shell.streamLog.slice(mark);
}

function thinking(): readonly StreamRow[] {
  return rows().filter(isThinkingRow);
}

const think = (token: string) => ({
  type: "inference.thinking.delta",
  data: { token },
});

const call = (name: string, callId: string) => ({
  type: "inference.tool_call.end",
  data: { name, callId, arguments: "{}" },
});

const done = (callId: string) => ({
  type: "tool.done",
  data: { result: { callId, content: "ok", isError: false } },
});

describe("a turn's reasoning", () => {
  test("stays one row however many times the model thinks", () => {
    prompt("go");
    bridge.handle(think("first I need the repo"));
    bridge.handle(call("run_shell", "c1"));
    bridge.handle(done("c1"));
    bridge.handle(think("now let me fetch the page"));
    bridge.handle(call("web_fetch", "c2"));
    bridge.handle(done("c2"));
    bridge.handle(think("that is enough to answer"));

    expect(thinking()).toHaveLength(1);
    expect(thinking()[0]?.text).toContain("first I need the repo");
    expect(thinking()[0]?.text).toContain("that is enough to answer");
  });

  test("leads the turn, so tool rows run uninterrupted beneath it", () => {
    prompt("go");
    bridge.handle(think("planning"));
    bridge.handle(call("run_shell", "c1"));
    bridge.handle(done("c1"));
    bridge.handle(think("more planning"));
    bridge.handle(call("web_fetch", "c2"));
    bridge.handle(done("c2"));

    const kinds = rows().map((row) => (isThinkingRow(row) ? "think" : row.role));
    expect(kinds).toEqual(["user", "think", "tool", "tool"]);
  });

  test("keeps every mid-turn fragment reachable on expand", () => {
    prompt("go");
    bridge.handle(think("opening thought"));
    bridge.handle(call("run_shell", "c1"));
    bridge.handle(done("c1"));
    bridge.handle(think("buried mid-turn thought"));
    bridge.handle({ type: "inference.text.delta", data: { token: "answer" } });

    expect(toggleCollapsedRow(shell)).toBe(true);
    const row = thinking()[0];
    expect(row?.expanded).toBe(true);
    expect(row?.text).toContain("buried mid-turn thought");
  });

  test("belongs to its own turn: the next prompt opens a new row", () => {
    prompt("one");
    bridge.handle(think("thinking about one"));
    bridge.handle({ type: "inference.text.delta", data: { token: "a" } });
    bridge.handle({ type: "message.received", data: { message: { content: "two" } } });
    bridge.handle(think("thinking about two"));

    expect(thinking()).toHaveLength(2);
    expect(thinking()[1]?.text).toBe("thinking about two");
  });

  test("costs the turn no extra gap whether it is there or not", () => {
    const you: StreamRow = { role: "user", text: "go" };
    const thought: StreamRow = { role: "system", text: "…", meta: "thinking" };
    const agent: StreamRow = { role: "assistant", text: "done" };
    expect(rowGroupGap(you, thought) + rowGroupGap(thought, agent)).toBe(rowGroupGap(you, agent));
  });
});
