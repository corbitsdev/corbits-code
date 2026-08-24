/**
 * Level 2c — live subagent observe: host-pushed rows + parent restore.
 * Pure child-event → StreamRow mappers live in observe-map (no renderer).
 */
import { describe, expect, test } from "bun:test";
import { focusOwner } from "./focus/index.js";
import { withTestRenderer } from "./harness.js";
import {
  mapChildStreamEvent,
  mapChildStreamSequence,
  rowFromBridgeEvent,
  rowsFromBridgeEventsCoalesced,
} from "./observe-map.js";
import type { ObserveSession } from "./residuals.js";
import type { StreamRow } from "./stream.js";
import { createStreamMapContext } from "./stream-event-map.js";
import {
  appendObserveStreamRow,
  appendStreamRow,
  createAppShell,
  enterSubagentObserve,
  getPaletteOnObserveRequest,
  leaveSubagentObserve,
  setPaletteOnObserveRequest,
} from "./shell.js";

function liveChildSession(
  lines: readonly StreamRow[],
  opts?: { readonly agentId?: string; readonly description?: string },
): ObserveSession {
  return {
    sessionId: "live-child-1",
    agentId: opts?.agentId ?? "explorer",
    description: opts?.description ?? "live map callers",
    lines,
  };
}

describe("live subagent observe", () => {
  test("enter accepts host live rows + agent label", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          run: "idle",
        });
        try {
          appendStreamRow(shell, { role: "user", text: "parent before" });

          const liveLines: StreamRow[] = [
            { role: "system", text: "— live child —" },
            { role: "assistant", text: "scanning repo…" },
            { role: "tool", text: "grep openListOverlay", meta: "tool" },
          ];
          enterSubagentObserve(
            shell,
            liveChildSession(liveLines, {
              agentId: "explorer",
              description: "map callers",
            }),
          );

          expect(shell.observe?.sessionId).toBe("live-child-1");
          expect(shell.observe?.agentId).toBe("explorer");
          expect(shell.observe?.description).toBe("map callers");
          expect(focusOwner(shell.focus)).toBe("observe");
          expect(shell.parentStreamLog).not.toBeNull();
          expect(shell.streamLog.some((r) => r.text === "scanning repo…")).toBe(true);
          expect(shell.streamLog.some((r) => r.text.includes("Viewing explore"))).toBe(true);
          // Parent row is not visible while observing.
          expect(shell.streamLog.some((r) => r.text === "parent before")).toBe(false);
          expect(shell.layout.heights.agents).toBeGreaterThan(0);
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("host can append child stream events while observing", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          run: "idle",
        });
        try {
          enterSubagentObserve(shell, liveChildSession([{ role: "system", text: "seed" }]));

          const ok = appendObserveStreamRow(shell, {
            role: "assistant",
            text: "live delta from host",
          });
          expect(ok).toBe(true);
          expect(shell.streamLog.some((r) => r.text === "live delta from host")).toBe(true);
          expect(shell.observe?.lines.some((r) => r.text === "live delta from host")).toBe(true);

          // Parent appends during observe stay on the snapshot, not the child view.
          appendStreamRow(shell, {
            role: "assistant",
            text: "parent mid-observe",
          });
          expect(shell.streamLog.some((r) => r.text === "parent mid-observe")).toBe(false);
          expect(shell.parentStreamLog?.some((r) => r.text === "parent mid-observe")).toBe(true);
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("leave restores parent transcript snapshot and focus lease", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          run: "idle",
        });
        try {
          appendStreamRow(shell, { role: "user", text: "parent user line" });
          appendStreamRow(shell, {
            role: "assistant",
            text: "parent assistant line",
          });
          const parentLen = shell.streamLog.length;

          enterSubagentObserve(
            shell,
            liveChildSession([
              { role: "system", text: "child only" },
              { role: "assistant", text: "child work" },
            ]),
          );
          appendObserveStreamRow(shell, {
            role: "tool",
            text: "child tool hit",
            meta: "tool.done",
          });
          appendStreamRow(shell, {
            role: "system",
            text: "parent while away",
          });

          leaveSubagentObserve(shell);

          expect(shell.observe).toBeNull();
          expect(shell.parentStreamLog).toBeNull();
          expect(focusOwner(shell.focus)).not.toBe("observe");
          // Parent gained exactly the row appended while away plus the
          // "left observe" system row — never a doubled copy of either.
          expect(shell.streamLog.length).toBe(parentLen + 2);
          expect(shell.streamLog.filter((r) => r.text === "parent user line").length).toBe(1);
          expect(shell.streamLog.filter((r) => r.text === "parent while away").length).toBe(1);
          expect(shell.streamLog.filter((r) => r.text.includes("left observe")).length).toBe(1);
          // Child rows must not leak into the restored parent transcript.
          expect(shell.streamLog.some((r) => r.text === "child only")).toBe(false);
          expect(shell.streamLog.some((r) => r.text === "child tool hit")).toBe(false);
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("leave does not duplicate rows across repeated enter/observe/leave cycles", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          run: "idle",
        });
        try {
          appendStreamRow(shell, { role: "user", text: "start" });

          for (let cycle = 0; cycle < 3; cycle++) {
            enterSubagentObserve(
              shell,
              liveChildSession([{ role: "assistant", text: `cycle ${cycle}` }]),
            );
            appendObserveStreamRow(shell, {
              role: "tool",
              text: `child tool ${cycle}`,
              meta: "tool.done",
            });
            leaveSubagentObserve(shell);
          }

          // One "start" row and one "left observe" row per cycle; no
          // child row and no doubled parent row from any cycle.
          expect(shell.streamLog.filter((r) => r.text === "start").length).toBe(1);
          expect(shell.streamLog.filter((r) => r.text.includes("left observe")).length).toBe(3);
          for (let cycle = 0; cycle < 3; cycle++) {
            expect(shell.streamLog.some((r) => r.text === `child tool ${cycle}`)).toBe(false);
          }
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("appendObserveStreamRow is no-op when not observing", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          run: "idle",
        });
        try {
          const before = shell.streamLog.length;
          const ok = appendObserveStreamRow(shell, {
            role: "assistant",
            text: "should not land",
          });
          expect(ok).toBe(false);
          expect(shell.streamLog.length).toBe(before);
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("Esc key leaves observe and restores parent", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          run: "idle",
        });
        try {
          appendStreamRow(shell, { role: "user", text: "stay" });
          enterSubagentObserve(shell, liveChildSession([{ role: "system", text: "child" }]));
          expect(shell.observe).not.toBeNull();

          // ESC needs disambiguation delay on the mock stdin path.
          h.pressKey("Escape");
          await new Promise((r) => setTimeout(r, 60));
          await h.renderOnce();

          expect(shell.observe).toBeNull();
          expect(shell.streamLog.some((r) => r.text === "stay")).toBe(true);
          expect(focusOwner(shell.focus)).not.toBe("observe");
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("host paints mapped child reactor events into observe view", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          run: "idle",
        });
        try {
          const seed = mapChildStreamSequence([
            {
              type: "message.received",
              data: { message: { content: "child task" } },
            },
            {
              type: "connector.reply",
              data: { content: "child answer" },
            },
          ]);
          enterSubagentObserve(shell, liveChildSession(seed));

          const ctx = createStreamMapContext();
          for (const row of mapChildStreamEvent(
            {
              type: "tool.done",
              data: {
                result: {
                  name: "grep",
                  content: "6 hits",
                  isError: false,
                },
              },
            },
            ctx,
          )) {
            appendObserveStreamRow(shell, row);
          }

          expect(shell.streamLog.some((r) => r.text === "child task")).toBe(true);
          expect(shell.streamLog.some((r) => r.text === "child answer")).toBe(true);
          expect(shell.streamLog.some((r) => r.role === "tool" && r.text === "6 hits")).toBe(true);
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });
});

describe("observe request handler injection point", () => {
  // No UI surface calls this anymore (the palette action that did is gone
  // with Ctrl+O); the host-injection API itself stays available for a future
  // trigger, so it is proven directly here rather than through a key chord.
  test("host can resolve and use its own live session", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          run: "idle",
        });
        try {
          setPaletteOnObserveRequest(shell, () =>
            liveChildSession([{ role: "system", text: "host seed" }], {
              agentId: "worker",
              description: "host-supplied task",
            }),
          );

          const session = getPaletteOnObserveRequest(shell)?.();
          expect(session).not.toBeNull();
          if (session) enterSubagentObserve(shell, session);

          expect(shell.observe?.sessionId).toBe("live-child-1");
          expect(shell.observe?.agentId).toBe("worker");
          expect(shell.streamLog.some((r) => r.text === "host seed")).toBe(true);
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("resolves to null when the host has nothing to offer", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          run: "idle",
        });
        try {
          setPaletteOnObserveRequest(shell, () => null);
          expect(getPaletteOnObserveRequest(shell)?.()).toBeNull();
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });
});

describe("observe pure mappers", () => {
  test("rowFromBridgeEvent covers paint roles", () => {
    expect(rowFromBridgeEvent({ type: "user", text: "u" })).toEqual({
      role: "user",
      text: "u",
    });
    expect(rowFromBridgeEvent({ type: "assistant", text: "a" })).toEqual({
      role: "assistant",
      text: "a",
    });
    expect(rowFromBridgeEvent({ type: "tool_call", name: "bash", detail: "ls" })).toEqual({
      role: "tool",
      text: "ls",
      meta: "bash",
      verb: "Bash",
      summary: "ls",
      pending: true,
      callKey: "bash Bash ls",
    });
    expect(
      rowFromBridgeEvent({
        type: "tool_result",
        name: "bash",
        detail: "out",
        isError: true,
      }),
    ).toEqual({ role: "tool", text: "out", meta: "bash", failed: true });
    expect(rowFromBridgeEvent({ type: "system", text: "s" })).toEqual({
      role: "system",
      text: "s",
    });
    expect(rowFromBridgeEvent({ type: "error", message: "e" })).toEqual({
      role: "system",
      text: "e",
      meta: "error",
    });
    expect(rowFromBridgeEvent({ type: "run", state: "busy" })).toBeNull();
    expect(rowFromBridgeEvent({ type: "tool.boundary" })).toBeNull();
    expect(rowFromBridgeEvent({ type: "assistant.delta", text: "x" })).toBeNull();
  });

  test("mapChildStreamEvent maps production reactor types", () => {
    expect(
      mapChildStreamEvent({
        type: "message.received",
        data: { message: { content: "go" } },
      }),
    ).toEqual([{ role: "user", text: "go" }]);
    expect(mapChildStreamEvent({ type: "inference.start" })).toEqual([]);
    expect(
      mapChildStreamEvent({
        type: "inference.text.delta",
        data: { token: "Hi" },
      }),
    ).toEqual([]);
  });

  test("rowsFromBridgeEventsCoalesced folds assistant deltas", () => {
    expect(
      rowsFromBridgeEventsCoalesced([
        { type: "assistant.delta", text: "Hel" },
        { type: "assistant.delta", text: "lo" },
        { type: "tool_call", name: "read_file", detail: "a.ts" },
        { type: "assistant.delta", text: "done" },
      ]),
    ).toEqual([
      { role: "assistant", text: "Hello" },
      {
        role: "tool",
        text: "a.ts",
        meta: "read_file",
        verb: "Read",
        summary: "a.ts",
        pending: true,
        callKey: "read_file Read a.ts",
      },
      { role: "assistant", text: "done" },
    ]);
  });

  test("mapChildStreamSequence tracks tool names across events", () => {
    const rows = mapChildStreamSequence([
      {
        type: "inference.tool_call.start",
        data: { name: "grep", callId: "c1" },
      },
      {
        type: "inference.tool_call.end",
        data: {
          name: "grep",
          callId: "c1",
          arguments: { q: "observe" },
        },
      },
      {
        type: "tool.done",
        data: {
          result: { callId: "c1", content: "hits", isError: false },
        },
      },
    ]);
    // The call and its answer are one row: the payload replaces the argument
    // JSON on the row it opened, and no second row is appended.
    expect(rows).toMatchObject([
      {
        role: "tool",
        text: "hits",
        meta: "grep",
        verb: "Grep",
        summary: "observe",
      },
    ]);
    expect(rows.length).toBe(1);
  });
});
