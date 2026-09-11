/**
 * One row per tool use: a call and its answer share a row, and a repeated call
 * collapses onto the row it repeats.
 */
import { describe, expect, test } from "bun:test";

import { defined } from "../../tests/helpers/defined.js";
import { toolCallRow } from "./diff";
import { withTestRenderer } from "./harness";
import { attachSessionBridge, createRecordingPort } from "./runtime-bridge";
import { createAppShell } from "./shell/index";
import {
  paintStreamRow,
  ROW_ARROW,
  toolRowLines,
  toolSentenceLines,
  type RowLayout,
  type StreamRow,
} from "./stream";
import { pendingCallIndex, pushToolCall, pushToolResult } from "./tool-rows";
import type { ShellOutputFeed } from "../session/shell-output-feed.js";

const LAYOUT: RowLayout = { width: 72, multiAgent: false };

function liveFeed(snapshot: () => string): ShellOutputFeed {
  return {
    append: () => undefined,
    clear: () => undefined,
    snapshot,
  };
}

const painted = (row: StreamRow): string => paintStreamRow(row, LAYOUT).content;

const collapsed = (row: StreamRow): string =>
  toolSentenceLines(row)
    .flat()
    .map((segment) => segment.text)
    .join("");

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
    expect(painted(defined(rows[0]))).not.toContain("└");
  });

  test("keep the call as the subject, never the payload", () => {
    const rows: StreamRow[] = [];
    pushToolCall(rows, {
      name: "fetch",
      arguments: JSON.stringify({ url: "https://www.apple.com" }),
    });
    pushToolResult(rows, {
      name: "fetch",
      content:
        "# Apple\n[Apple](/) - [Store](/us/shop/goto/store)\nmore page\nand more",
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
    pushToolCall(rows, {
      name: "grep",
      arguments: JSON.stringify({ pattern: "legacy_token" }),
    });
    pushToolResult(rows, { name: "grep", content: "no matches" });
    expect(rows[0]?.stat).toBe("no matches");
    expect(rows[0]?.detail).toBeUndefined();
  });

  test("mark the row failed and put the error on the collapsed line", () => {
    const rows: StreamRow[] = [];
    pushToolCall(rows, {
      name: "fetch",
      arguments: JSON.stringify({ url: "https://x.dev" }),
    });
    pushToolResult(rows, {
      name: "fetch",
      content: "connection refused",
      isError: true,
    });
    expect(rows.length).toBe(1);
    expect(rows[0]?.failed).toBe(true);
    expect(painted(defined(rows[0]))).toContain("×");
    expect(collapsed(defined(rows[0]))).toContain("connection refused");
  });

  test("a failed read_file of a missing tool-output URI shows the error on the collapsed line", () => {
    const rows: StreamRow[] = [];
    pushToolCall(rows, {
      name: "read_file",
      arguments: JSON.stringify({ path: "tool-output:///missing-blob" }),
    });
    pushToolResult(rows, {
      name: "read_file",
      content: 'Blob not found for key: "missing-blob"',
      isError: true,
    });
    expect(rows[0]?.failed).toBe(true);
    expect(painted(defined(rows[0]))).toContain("×");
    expect(collapsed(defined(rows[0]))).toContain("Blob not found");
    expect(collapsed(defined(rows[0]))).toContain(
      "tool-output:///missing-blob",
    );
  });

  test("a failed read_file of a missing filesystem path shows the error on the collapsed line", () => {
    const rows: StreamRow[] = [];
    pushToolCall(rows, {
      name: "read_file",
      arguments: JSON.stringify({ path: "/no/such/file.ts" }),
    });
    pushToolResult(rows, {
      name: "read_file",
      content: "file not found: /no/such/file.ts",
      isError: true,
    });
    expect(rows[0]?.failed).toBe(true);
    expect(painted(defined(rows[0]))).toContain("×");
    expect(collapsed(defined(rows[0]))).toContain("file not found");
    expect(collapsed(defined(rows[0]))).toContain("/no/such/file.ts");
  });

  test("a successful read_file keeps the path as the subject and the success mark", () => {
    const rows: StreamRow[] = [];
    pushToolCall(rows, {
      name: "read_file",
      arguments: JSON.stringify({ path: "src/a.ts" }),
    });
    pushToolResult(rows, {
      name: "read_file",
      content: "export const a = 1;\n",
    });
    expect(rows[0]?.failed).toBeUndefined();
    expect(painted(defined(rows[0]))).toContain("✓");
    expect(painted(defined(rows[0]))).not.toContain("×");
    expect(collapsed(defined(rows[0]))).toContain("src/a.ts");
    expect(collapsed(defined(rows[0]))).not.toContain("file not found");
    expect(collapsed(defined(rows[0]))).not.toContain("Blob not found");
  });

  test("a resolved sub-agent dispatch drops its live elapsed-time trailer for the real answer", () => {
    const rows: StreamRow[] = [];
    pushToolCall(rows, {
      name: "spawn_agent",
      arguments: JSON.stringify({ description: "Review mouse/paste" }),
    });
    rows[0] = { ...defined(rows[0]), agentWorking: true, stat: "0:42 · bash" };

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

  test("folds a different call by the same tool onto one lane with a count", () => {
    const rows: StreamRow[] = [];
    pushToolCall(rows, {
      name: "read_file",
      arguments: JSON.stringify({ path: "a.ts" }),
      callId: "c1",
    });
    pushToolResult(rows, {
      name: "read_file",
      content: "a",
      callId: "c1",
    });
    pushToolCall(rows, {
      name: "read_file",
      arguments: JSON.stringify({ path: "b.ts" }),
      callId: "c2",
    });
    expect(rows.length).toBe(1);
    expect(rows[0]?.coalesced).toBe(true);
    expect(rows[0]?.callCount).toBe(2);
    expect(rows[0]?.summary).toBe("b.ts");
    expect(rows[0]?.memberIds).toEqual(["c1", "c2"]);
    pushToolResult(rows, {
      name: "read_file",
      content: "b",
      callId: "c2",
    });
    expect(rows.length).toBe(1);
    expect(rows[0]?.pending).toBeUndefined();
    expect(rows[0]?.outstanding).toBe(0);
  });

  test("a lane keeps every member id while the count climbs", () => {
    const rows: StreamRow[] = [];
    for (let i = 1; i <= 33; i++) {
      pushToolCall(rows, {
        name: "grep",
        arguments: JSON.stringify({ pattern: `p${i}` }),
        callId: `c${i}`,
      });
    }
    expect(rows.length).toBe(1);
    expect(rows[0]?.callCount).toBe(33);
    expect(rows[0]?.memberIds?.length).toBe(33);
    expect(rows[0]?.memberIds?.[0]).toBe("c1");
    expect(pendingCallIndex(rows, "grep", "c33")).toBe(0);
    expect(pendingCallIndex(rows, "grep", "c1")).toBe(0);
  });

  test("hydrate of 33 consecutive same-tool calls still settles the oldest result", () => {
    const rows: StreamRow[] = [];
    for (let i = 1; i <= 33; i++) {
      pushToolCall(rows, {
        name: "grep",
        arguments: JSON.stringify({ pattern: `p${i}` }),
        callId: `c${i}`,
      });
    }
    expect(rows.length).toBe(1);
    expect(pendingCallIndex(rows, "grep", "c1")).toBe(0);
    pushToolResult(rows, { name: "grep", content: "oldest", callId: "c1" });
    expect(rows.length).toBe(1);
    expect(rows[0]?.pending).toBe(true);
    expect(rows[0]?.outstanding).toBe(32);
    for (let i = 2; i <= 33; i++) {
      pushToolResult(rows, {
        name: "grep",
        content: `r${i}`,
        callId: `c${i}`,
      });
    }
    expect(rows.length).toBe(1);
    expect(rows[0]?.pending).toBeUndefined();
    expect(rows[0]?.outstanding).toBe(0);
  });

  test("a different tool breaks the lane", () => {
    const rows: StreamRow[] = [];
    pushToolCall(rows, {
      name: "grep",
      arguments: JSON.stringify({ pattern: "x" }),
    });
    pushToolCall(rows, {
      name: "read_file",
      arguments: JSON.stringify({ path: "a.ts" }),
    });
    expect(rows.length).toBe(2);
  });

  test("spawn_agent never folds, even back to back", () => {
    const rows: StreamRow[] = [];
    pushToolCall(rows, {
      name: "spawn_agent",
      arguments: JSON.stringify({ description: "one" }),
    });
    pushToolCall(rows, {
      name: "spawn_agent",
      arguments: JSON.stringify({ description: "two" }),
    });
    expect(rows.length).toBe(2);
  });

  test("a resumed parallel batch pairs results through memberIds", () => {
    const rows: StreamRow[] = [];
    pushToolCall(rows, {
      name: "grep",
      arguments: JSON.stringify({ pattern: "a" }),
      callId: "A",
    });
    pushToolCall(rows, {
      name: "grep",
      arguments: JSON.stringify({ pattern: "b" }),
      callId: "B",
    });
    expect(rows.length).toBe(1);
    // The lane's own callId moved to the newest call; the older member is
    // still resolvable for its result.
    expect(pendingCallIndex(rows, "grep", "A")).toBe(0);
    pushToolResult(rows, { name: "grep", content: "a", callId: "A" });
    expect(rows.length).toBe(1);
    expect(rows[0]?.outstanding).toBe(1);
    expect(rows[0]?.pending).toBe(true);
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
      arguments: JSON.stringify({
        agent: "intern",
        description: "Fix CL-5559 heading shake",
      }),
      callId: "c1",
    });
    pushToolCall(rows, {
      name: "spawn_agent",
      arguments: JSON.stringify({
        agent: "intern",
        description: "Fix CL-5560 approval UI",
      }),
      callId: "c2",
    });
    pushToolCall(rows, {
      name: "spawn_agent",
      arguments: JSON.stringify({
        agent: "intern",
        description: "Fix CL-5561 scroll/history",
      }),
      callId: "c3",
    });
    expect(rows.length).toBe(3);

    // Results land out of dispatch order, as real sub-agent completion does.
    pushToolResult(rows, {
      name: "spawn_agent",
      content: "done c2",
      callId: "c2",
    });
    pushToolResult(rows, {
      name: "spawn_agent",
      content: "done c1",
      callId: "c1",
    });
    pushToolResult(rows, {
      name: "spawn_agent",
      content: "done c3",
      callId: "c3",
    });

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
      {
        role: "tool",
        text: "",
        meta: "spawn_agent",
        pending: true,
        callId: "a1",
      },
      {
        role: "tool",
        text: "",
        meta: "spawn_agent",
        pending: true,
        callId: "b1",
      },
    ];
    expect(pendingCallIndex(rows, "spawn_agent", "zzz-does-not-exist")).toBe(
      -1,
    );

    pushToolResult(rows, {
      name: "spawn_agent",
      content: "orphan",
      callId: "zzz-does-not-exist",
    });
    // Answers nothing on the log — appended as its own row rather than
    // resolving (and thereby corrupting) an unrelated in-flight call.
    expect(rows.length).toBe(3);
    expect(rows[0]?.pending).toBe(true);
    expect(rows[1]?.pending).toBe(true);
  });

  // A failed call must show its error on the collapsed line, not only behind
  // the expand arrow.
  test("a failed call shows its error text on the collapsed line", () => {
    const rows: StreamRow[] = [];
    pushToolCall(rows, {
      name: "spawn_agent",
      arguments: JSON.stringify({
        agent: "intern",
        description: "Fix CL-5559 heading shake",
      }),
      callId: "c1",
    });
    pushToolResult(rows, {
      name: "spawn_agent",
      content: 'Error: sub-agent "Fix CL-5559 heading shake" failed: boom',
      isError: true,
      callId: "c1",
    });
    expect(rows[0]?.failed).toBe(true);
    expect(painted(defined(rows[0]))).toContain("×");
    expect(collapsed(defined(rows[0]))).toContain("boom");
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
    const text = defined(lines[0])
      .map((segment) => segment.text)
      .join("");
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
          // Every call is dispatched before any answer lands (a parallel batch).
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
          await h.renderOnce();
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

  test("paints a live shell tail from a polled feed, unwired renders bare", async () => {
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
                name: "run_shell",
                callId: "sh1",
                arguments: { command: "make test" },
              },
            },
          ]);
          // Unwired feed: sync is a no-op, the pending row stays bare.
          bridge.syncShellOutputs(undefined);
          expect(shell.streamLog[0]?.previewLines).toBeUndefined();

          let text = "";
          bridge.syncShellOutputs(() => liveFeed(() => text));
          expect(shell.streamLog[0]?.previewLines).toBeUndefined();

          text = "compiling src/a.ts\ncompiling src/b.ts\ndone\n";
          bridge.syncShellOutputs(() => liveFeed(() => text));
          // Tail repaints are frame-coalesced: the update lands on flush.
          await h.renderOnce();
          const row = shell.streamLog[0];
          expect(row?.pending).toBe(true);
          expect(row?.previewLines).toEqual([
            "compiling src/a.ts",
            "compiling src/b.ts",
            "done",
          ]);
          await h.renderOnce();
          const frame = h.captureCharFrame();
          expect(frame).toContain("compiling src/b.ts");

          // A later settle replaces the live tail with the settle preview.
          bridge.play([
            {
              type: "tool.done",
              data: {
                result: {
                  callId: "sh1",
                  content: "ok\nline2\nline3\nline4\nline5",
                },
              },
            },
          ]);
          expect(shell.streamLog[0]?.pending).toBeUndefined();
          expect(shell.streamLog[0]?.previewLines).toEqual([
            "line3",
            "line4",
            "line5",
            "⋯ +2 lines",
          ]);
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("parallel run_shell live tails do not cross-attribute", async () => {
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
                name: "run_shell",
                callId: "sh1",
                arguments: { command: "echo alpha" },
              },
            },
            {
              type: "inference.tool_call.end",
              data: {
                name: "grep",
                callId: "g1",
                arguments: { pattern: "x" },
              },
            },
            {
              type: "inference.tool_call.end",
              data: {
                name: "run_shell",
                callId: "sh2",
                arguments: { command: "echo beta" },
              },
            },
          ]);
          expect(shell.streamLog.length).toBe(3);
          bridge.syncShellOutputs((callId) => {
            if (callId === "sh1") return liveFeed(() => "alpha-only\n");
            if (callId === "sh2") return liveFeed(() => "beta-only\n");
            return undefined;
          });
          await h.renderOnce();
          const first = shell.streamLog[0];
          const second = shell.streamLog[2];
          expect(first?.toolName).toBe("run_shell");
          expect(second?.toolName).toBe("run_shell");
          expect(first?.previewLines).toEqual(["alpha-only"]);
          expect(second?.previewLines).toEqual(["beta-only"]);
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("a silent sibling does not clear a coalesced pending shell tail", async () => {
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
                name: "run_shell",
                callId: "sh1",
                arguments: { command: "echo alpha" },
              },
            },
            {
              type: "inference.tool_call.end",
              data: {
                name: "run_shell",
                callId: "sh2",
                arguments: { command: "sleep 5; echo done" },
              },
            },
          ]);
          await h.renderOnce();
          expect(shell.streamLog.length).toBe(1);
          expect(shell.streamLog[0]?.coalesced).toBe(true);
          expect(shell.streamLog[0]?.pending).toBe(true);

          bridge.syncShellOutputs((callId) => {
            if (callId === "sh1") return liveFeed(() => "alpha-only\n");
            if (callId === "sh2") return liveFeed(() => "");
            return undefined;
          });
          await h.renderOnce();
          expect(shell.streamLog[0]?.previewLines).toEqual(["alpha-only"]);
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("rollbackAttempt drops shellSnapshots for truncated run_shell calls", async () => {
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
            { type: "inference.start", data: {} },
            {
              type: "inference.tool_call.end",
              data: {
                name: "run_shell",
                callId: "sh1",
                arguments: { command: "sleep 5" },
              },
            },
          ]);
          bridge.syncShellOutputs((callId) =>
            callId === "sh1" ? liveFeed(() => "live-tail\n") : undefined,
          );
          await h.renderOnce();
          expect(shell.streamLog[0]?.previewLines).toEqual(["live-tail"]);

          bridge.play([{ type: "inference.retry", data: { attempt: 1 } }]);
          expect(
            shell.streamLog.some(
              (row) => row.toolName === "run_shell" && row.callId === "sh1",
            ),
          ).toBe(false);

          bridge.play([
            { type: "inference.start", data: {} },
            {
              type: "inference.tool_call.end",
              data: {
                name: "run_shell",
                callId: "sh1",
                arguments: { command: "sleep 5" },
              },
            },
          ]);
          bridge.syncShellOutputs((callId) =>
            callId === "sh1" ? liveFeed(() => "live-tail\n") : undefined,
          );
          await h.renderOnce();
          expect(shell.streamLog[0]?.previewLines).toEqual(["live-tail"]);
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("a result id matching nothing on the log never folds onto the last row", async () => {
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
                name: "read_file",
                callId: "c1",
                arguments: { path: "a.ts" },
              },
            },
          ]);
          // Attach-mid-turn / duplicate-event shape: an answer arrives whose
          // id belongs to nothing this bridge saw.
          bridge.play([
            {
              type: "tool.done",
              data: { result: { callId: "zzz-unknown", content: "orphan" } },
            },
          ]);
          expect(shell.streamLog.length).toBe(2);
          expect(shell.streamLog[0]?.pending).toBe(true);
          expect(shell.streamLog[1]?.text).toBe("orphan");

          // The real answer still resolves its own row in place.
          bridge.play([
            {
              type: "tool.done",
              data: { result: { callId: "c1", content: "body" } },
            },
          ]);
          expect(shell.streamLog.length).toBe(2);
          expect(shell.streamLog[0]?.pending).toBeUndefined();
          expect(shell.streamLog[0]?.text).toBe("body");
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });
});

describe("lane paint", () => {
  test("a pending lane narrates the newest call with a dim count chip", () => {
    const rows: StreamRow[] = [];
    pushToolCall(rows, {
      name: "grep",
      arguments: JSON.stringify({ pattern: "a" }),
    });
    pushToolCall(rows, {
      name: "grep",
      arguments: JSON.stringify({ pattern: "b" }),
    });
    expect(collapsed(defined(rows[0]))).toContain("Grep b");
    expect(collapsed(defined(rows[0]))).toContain("· ×2");
  });

  test("a settled lane reads past tense times calls over the latest subject", () => {
    const rows: StreamRow[] = [];
    pushToolCall(rows, {
      name: "grep",
      arguments: JSON.stringify({ pattern: "a" }),
    });
    pushToolCall(rows, {
      name: "grep",
      arguments: JSON.stringify({ pattern: '"corbits"' }),
    });
    pushToolResult(rows, { name: "grep", content: "no matches" });
    expect(rows[0]?.outstanding).toBe(1);
    pushToolResult(rows, { name: "grep", content: "2 lines" });
    expect(collapsed(defined(rows[0]))).toContain('Grepped ×2 · "corbits"');
  });

  test("a single-call row renders without lane wording", () => {
    const rows: StreamRow[] = [];
    pushToolCall(rows, {
      name: "grep",
      arguments: JSON.stringify({ pattern: "legacy_token" }),
    });
    pushToolResult(rows, { name: "grep", content: "no matches" });
    const paintedLine = collapsed(defined(rows[0]));
    expect(paintedLine).toContain("Grep legacy_token");
    expect(paintedLine).not.toContain("×");
    expect(paintedLine).not.toContain("Grepped");
  });

  test("a settled shell row paints its preview lines and hides them expanded", () => {
    const rows: StreamRow[] = [];
    pushToolCall(rows, {
      name: "run_shell",
      arguments: JSON.stringify({ command: "make test" }),
    });
    pushToolResult(rows, {
      name: "run_shell",
      content: "line1\nline2\nline3\nline4\nline5",
    });
    const row = defined(rows[0]);
    const collapsedLines = toolRowLines(row).map((line) =>
      line.map((segment) => segment.text).join(""),
    );
    expect(collapsedLines.length).toBe(5);
    expect(collapsedLines[1]).toContain("line3");
    expect(collapsedLines[4]).toContain("⋯ +2 lines");
    expect(collapsedLines[4]).toContain(ROW_ARROW.collapsed);
    const expandedLines = toolRowLines({ ...row, expanded: true });
    expect(expandedLines.length).toBe(1 + 5);
    expect(
      expandedLines
        .slice(1)
        .some((line) =>
          line.some((segment) => segment.text.includes("+2 lines")),
        ),
    ).toBe(false);
  });

  test("a non-zero shell exit carries an exit stat, a zero exit none", () => {
    const rows: StreamRow[] = [];
    pushToolCall(rows, {
      name: "run_shell",
      arguments: JSON.stringify({ command: "false" }),
    });
    pushToolResult(rows, { name: "run_shell", content: "exit code 1\nboom" });
    expect(rows[0]?.stat).toBe("exit 1");
    // The exit envelope line is the stat; the preview repeats only the output.
    expect(rows[0]?.previewLines).toEqual(["boom"]);

    const ok: StreamRow[] = [];
    pushToolCall(ok, {
      name: "run_shell",
      arguments: JSON.stringify({ command: "true" }),
    });
    pushToolResult(ok, { name: "run_shell", content: "all good" });
    expect(ok[0]?.stat).toBeUndefined();
  });

  test("a coalesced shell lane keeps each call's answer behind the arrow", () => {
    const rows: StreamRow[] = [];
    pushToolCall(rows, {
      name: "run_shell",
      arguments: JSON.stringify({ command: "echo a" }),
      callId: "s1",
    });
    pushToolCall(rows, {
      name: "run_shell",
      arguments: JSON.stringify({ command: "echo b" }),
      callId: "s2",
    });
    pushToolResult(rows, { name: "run_shell", content: "a", callId: "s1" });
    pushToolResult(rows, { name: "run_shell", content: "b", callId: "s2" });
    const answers = (rows[0]?.detail ?? []).map((line) =>
      line.map((segment) => segment.text).join(""),
    );
    expect(answers).not.toEqual(["answered", "answered"]);
    expect(answers).toContain("a");
    expect(rows[0]?.resultText).toBe("b");
    expect(rows[0]?.previewLines).toEqual(["b"]);
  });

  test("a later zero-exit coalesced shell does not keep a leftover exit stat", () => {
    const rows: StreamRow[] = [];
    pushToolCall(rows, {
      name: "run_shell",
      arguments: JSON.stringify({ command: "false" }),
      callId: "s1",
    });
    pushToolCall(rows, {
      name: "run_shell",
      arguments: JSON.stringify({ command: "true" }),
      callId: "s2",
    });
    pushToolResult(rows, {
      name: "run_shell",
      content: "exit code 1\nboom",
      callId: "s1",
    });
    pushToolResult(rows, {
      name: "run_shell",
      content: "all good",
      callId: "s2",
    });
    expect(rows[0]?.pending).toBeUndefined();
    expect(collapsed(defined(rows[0]))).toContain("true");
    expect(rows[0]?.stat).not.toBe("exit 1");
  });
});
