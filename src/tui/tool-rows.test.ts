/**
 * One row per tool use: a call and its answer share a row, and a repeated call
 * collapses onto the row it repeats.
 */
import { describe, expect, test } from "bun:test";

import { toolCallRow } from "./diff";
import { withTestRenderer } from "./harness";
import { attachSessionBridge, createRecordingPort } from "./runtime-bridge";
import { createAppShell } from "./shell";
import {
  isCollapsibleRow,
  paintStreamRow,
  toolSentenceLines,
  type RowLayout,
  type StreamRow,
} from "./stream";
import { pendingCallIndex, pushToolCall, pushToolResult } from "./tool-rows";

const LAYOUT: RowLayout = { width: 72, multiAgent: false };

const painted = (row: StreamRow): string => paintStreamRow(row, LAYOUT).content;

const LINEAR_ISSUES = JSON.stringify({
  issues: [
    { id: "1", title: "First" },
    { id: "2", title: "Second" },
  ],
});

describe("a call and its answer", () => {
  test("are one row, the answer supplying the subject", () => {
    const rows: StreamRow[] = [];
    pushToolCall(rows, {
      name: "mcp__linear__list_issues",
      arguments: JSON.stringify({ team: "core" }),
    });
    expect(rows.length).toBe(1);
    expect(rows[0]?.pending).toBe(true);

    pushToolResult(rows, {
      name: "mcp__linear__list_issues",
      content: LINEAR_ISSUES,
    });
    expect(rows.length).toBe(1);
    expect(rows[0]?.pending).toBeUndefined();
    // The subject stays the call; the answer adds only a certain count.
    expect(rows[0]?.verb).toBe("Linear: List Issues");
    expect(rows[0]?.stat).toBe("2 results");
    expect(painted(rows[0]!)).not.toContain("└");
  });

  test("keep the call as the subject, never the payload", () => {
    const rows: StreamRow[] = [];
    pushToolCall(rows, {
      name: "fetch",
      arguments: JSON.stringify({ url: "https://www.apple.com" }),
    });
    pushToolResult(rows, {
      name: "fetch",
      content: "# Apple\n[Apple](/) - [Store](/us/shop/goto/store)\nmore page\nand more",
    });
    expect(rows.length).toBe(1);
    expect(rows[0]?.summary).toContain("https://www.apple.com");
    expect(rows[0]?.summary).not.toContain("Apple](");
    expect(rows[0]?.stat).toBe("4 lines");
    // The page itself is one keypress away rather than on the summary line.
    expect(rows[0]?.detail).toBeDefined();
  });

  test("take a short factual answer as an addendum", () => {
    const rows: StreamRow[] = [];
    pushToolCall(rows, { name: "grep", arguments: JSON.stringify({ pattern: "legacy_token" }) });
    pushToolResult(rows, { name: "grep", content: "no matches" });
    expect(rows[0]?.stat).toBe("no matches");
    expect(rows[0]?.detail).toBeUndefined();
  });

  test("mark the row failed, keeping the failure out of the collapsed line", () => {
    const rows: StreamRow[] = [];
    pushToolCall(rows, { name: "fetch", arguments: JSON.stringify({ url: "https://x.dev" }) });
    pushToolResult(rows, { name: "fetch", content: "connection refused", isError: true });
    expect(rows.length).toBe(1);
    expect(rows[0]?.failed).toBe(true);
    expect(painted(rows[0]!)).toContain("×");
    expect(rows[0]?.detail?.length).toBeGreaterThan(0);
  });

  test("a resolved sub-agent dispatch drops its live elapsed-time trailer for the real answer", () => {
    const rows: StreamRow[] = [];
    pushToolCall(rows, {
      name: "spawn_agent",
      arguments: JSON.stringify({ description: "Review mouse/paste" }),
    });
    rows[0] = { ...rows[0]!, agentWorking: true, stat: "0:42 · bash" };

    pushToolResult(rows, { name: "spawn_agent", content: "8 lines" });
    expect(rows[0]?.pending).toBeUndefined();
    expect(rows[0]?.stat).toBe("8 lines");
  });

  test("an answer with no call on the log still gets a row", () => {
    const rows: StreamRow[] = [];
    pushToolResult(rows, { name: "shell", content: "orphan" });
    expect(rows.length).toBe(1);
    expect(rows[0]?.text).toBe("orphan");
  });
});

describe("a run of identical calls", () => {
  test("is one row, with every answer behind its arrow", () => {
    const rows: StreamRow[] = [];
    for (let i = 0; i < 8; i++) {
      pushToolCall(rows, {
        name: "mcp__linear__list_issues",
        arguments: JSON.stringify({ team: "core" }),
      });
      pushToolResult(rows, {
        name: "mcp__linear__list_issues",
        content: LINEAR_ISSUES,
      });
    }
    expect(rows.length).toBe(1);
    expect(rows[0]?.coalesced).toBe(true);
    expect(rows[0]?.detail?.length).toBe(8);
    // The row says what the call was, never a total it cannot substantiate.
    expect(rows[0]?.verb).toBe("Linear: List Issues");
    expect(rows[0]?.stat).toBeUndefined();
  });

  test("does not swallow a different call by the same tool", () => {
    const rows: StreamRow[] = [];
    pushToolCall(rows, { name: "read_file", arguments: JSON.stringify({ path: "a.ts" }) });
    pushToolResult(rows, { name: "read_file", content: "a" });
    pushToolCall(rows, { name: "read_file", arguments: JSON.stringify({ path: "b.ts" }) });
    pushToolResult(rows, { name: "read_file", content: "b" });
    expect(rows.length).toBe(2);
  });
});

describe("parallel calls to the same tool", () => {
  // CL-5562: three `spawn_agent` calls dispatched in one turn all carry
  // meta === "spawn_agent" — name alone cannot tell them apart, so a result must
  // find its own row by call id or it resolves whichever pending "spawn_agent" row
  // happens to be newest, leaving the others stranded pending forever and
  // turning any later same-name result into an orphaned extra row.
  test("each result resolves its own call by id, not the newest pending call of that name", () => {
    const rows: StreamRow[] = [];
    pushToolCall(rows, {
      name: "spawn_agent",
      arguments: JSON.stringify({ agent: "intern", description: "Fix CL-5559 heading shake" }),
      callId: "c1",
    });
    pushToolCall(rows, {
      name: "spawn_agent",
      arguments: JSON.stringify({ agent: "intern", description: "Fix CL-5560 approval UI" }),
      callId: "c2",
    });
    pushToolCall(rows, {
      name: "spawn_agent",
      arguments: JSON.stringify({ agent: "intern", description: "Fix CL-5561 scroll/history" }),
      callId: "c3",
    });
    expect(rows.length).toBe(3);

    // Results land out of dispatch order, as real sub-agent completion does.
    pushToolResult(rows, { name: "spawn_agent", content: "done c2", callId: "c2" });
    pushToolResult(rows, { name: "spawn_agent", content: "done c1", callId: "c1" });
    pushToolResult(rows, { name: "spawn_agent", content: "done c3", callId: "c3" });

    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.pending !== true)).toBe(true);
    expect(rows.every((r) => r.failed !== true)).toBe(true);
    expect(rows[0]?.summary).toBe("Fix CL-5559 heading shake");
    expect(rows[0]?.text).toBe("done c1");
    expect(rows[1]?.summary).toBe("Fix CL-5560 approval UI");
    expect(rows[1]?.text).toBe("done c2");
    expect(rows[2]?.summary).toBe("Fix CL-5561 scroll/history");
    expect(rows[2]?.text).toBe("done c3");
  });

  // A miss must not fall back to "the newest pending row of that name" — that
  // fallback is exactly the LIFO misattribution this test file exists to rule
  // out, and every live caller (the bridge's own call map, subagent session
  // entries, resumed history with ids) always carries a real id, so a miss
  // here means the id genuinely does not belong to anything on the log.
  test("an id that matches nothing on the log answers nothing, not the newest pending call", () => {
    const rows: StreamRow[] = [
      { role: "tool", text: "", meta: "spawn_agent", pending: true, callId: "a1" },
      { role: "tool", text: "", meta: "spawn_agent", pending: true, callId: "b1" },
    ];
    expect(pendingCallIndex(rows, "spawn_agent", "zzz-does-not-exist")).toBe(-1);

    pushToolResult(rows, { name: "spawn_agent", content: "orphan", callId: "zzz-does-not-exist" });
    // Answers nothing on the log — appended as its own row rather than
    // resolving (and thereby corrupting) an unrelated in-flight call.
    expect(rows.length).toBe(3);
    expect(rows[0]?.pending).toBe(true);
    expect(rows[1]?.pending).toBe(true);
  });

  // Acceptance criterion: a failed sub-agent surfaces its error inline
  // (expandable), not a bare mark with nothing behind it. `mergeToolRows` /
  // `toolResultRow` already carry the failed result's own text into `detail`
  // — untouched by this fix, but only reachable per-call once results resolve
  // to the right row instead of a neighbour's.
  test("a failed call keeps its error text behind the expand arrow", () => {
    const rows: StreamRow[] = [];
    pushToolCall(rows, {
      name: "spawn_agent",
      arguments: JSON.stringify({ agent: "intern", description: "Fix CL-5559 heading shake" }),
      callId: "c1",
    });
    pushToolResult(rows, {
      name: "spawn_agent",
      content: 'Error: sub-agent "Fix CL-5559 heading shake" failed: boom',
      isError: true,
      callId: "c1",
    });
    expect(rows[0]?.failed).toBe(true);
    expect(isCollapsibleRow(rows[0]!)).toBe(true);
    expect(rows[0]?.detail?.[0]?.[0]?.text).toContain("boom");
  });
});

describe("a long subject", () => {
  test("is cut to one line rather than wrapped", () => {
    const row = toolCallRow({
      name: "web_search",
      arguments: JSON.stringify({
        query:
          "current overview of Apple Inc and what apple.com represents as the company storefront today",
      }),
    });
    const lines = toolSentenceLines(row, 40);
    expect(lines.length).toBe(1);
    const text = lines[0]!.map((segment) => segment.text).join("");
    expect(text.length).toBeLessThanOrEqual(40);
    expect(text).toContain("…");
  });
});

describe("a live turn", () => {
  test("resolves the call row in place instead of appending an answer", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        });
        const bridge = attachSessionBridge(shell, createRecordingPort());
        try {
          bridge.play([
            {
              type: "inference.tool_call.end",
              data: {
                name: "mcp__linear__list_issues",
                callId: "c1",
                arguments: { team: "core" },
              },
            },
          ]);
          expect(shell.streamLog.length).toBe(1);
          expect(shell.streamLog[0]?.pending).toBe(true);

          bridge.play([
            {
              type: "tool.done",
              data: { result: { callId: "c1", content: LINEAR_ISSUES } },
            },
          ]);
          expect(shell.streamLog.length).toBe(1);
          expect(shell.streamLog[0]?.stat).toBe("2 results");

          await h.renderOnce();
          const frame = h.captureCharFrame();
          expect(frame).toContain("Linear: List Issues 2 results");
          expect(frame).not.toContain("└");
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("folds every answer of a batched run into the one row it opened", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        });
        const bridge = attachSessionBridge(shell, createRecordingPort());
        try {
          const ids = ["c1", "c2", "c3", "c4"];
          // Every call is dispatched before any answer lands, which is what an
          // ordinary parallel batch looks like on the wire.
          bridge.play(
            ids.map((callId) => ({
              type: "inference.tool_call.end",
              data: {
                name: "mcp__linear__list_issues",
                callId,
                arguments: { team: "core" },
              },
            })),
          );
          expect(shell.streamLog.length).toBe(1);
          expect(shell.streamLog[0]?.coalesced).toBe(true);
          expect(shell.streamLog[0]?.pending).toBe(true);

          bridge.play(
            ids.map((callId) => ({
              type: "tool.done",
              data: { result: { callId, content: LINEAR_ISSUES } },
            })),
          );
          expect(shell.streamLog.length).toBe(1);
          expect(shell.streamLog[0]?.detail?.length).toBe(4);
          // The run is answered only once its last outstanding call is.
          expect(shell.streamLog[0]?.pending).toBeUndefined();
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });
});
