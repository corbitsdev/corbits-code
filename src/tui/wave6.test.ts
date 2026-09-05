/**
 * Wave 6: command palette, long-log windowing, chrome zones, keyboard copy.
 */
import { describe, expect, test } from "bun:test";
import { IDLE_TRANSCRIPT_FLOOR } from "./geometry/index";
import { focusOwner, scrollLease } from "./focus/index";
import { withTestRenderer } from "./harness";
import { MAX_RETAINED_STREAM_ROWS } from "./long-log";
import { openPermissionsOverlay } from "./overlays";
import {
  acceptOverlaySelection,
  appendStreamRow,
  closeInsetOverlay,
  confirmCopySelection,
  createAppShell,
  enterCopyMode,
  enterSubagentObserve,
  moveOverlaySelection,
  openInsetOverlay,
  openPalette,
  replaceStreamRowAt,
  setChromeZones,
  setEffortCycleHandler,
  setStatusFlash,
  shellFocusPrompt,
  streamRowAt,
  streamRowCount,
  toggleTasksPanel,
} from "./shell";
import { createRecordingClipboard } from "./copy-path";
import { RUNTIME_FLASH_MS } from "./runtime-notices";
import { stringWidth } from "./view/height";
import type { PaletteCommand } from "./command-catalog";

const CATALOG: readonly PaletteCommand[] = [
  { id: "compact", label: "/compact" },
  { id: "help", label: "/help" },
  { id: "model", label: "/model" },
];

describe("Wave 6: command list", () => {
  test("open → navigate → Esc restores prompt", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        });
        try {
          expect(focusOwner(shell.focus)).toBe("prompt");
          openPalette(shell, { catalog: CATALOG });
          expect(shell.overlayKind).toBe("palette");
          expect(shell.overlayList).not.toBeNull();
          expect(shell.paletteCommands.length).toBeGreaterThan(0);
          expect(focusOwner(shell.focus)).toBe("palette");
          expect(scrollLease(shell.focus)).toBe("palette");
          expect(shell.layout.overlayMode).toBe("inset");
          expect(shell.overlayHost.visible).toBe(true);

          await h.renderOnce();
          const frame = h.captureCharFrame();
          // Slash mode has no title rule and no orphan filter row — identify
          // the list by its name-only command labels.
          expect(frame).not.toMatch(/│\s*>\s*│/);
          expect(frame).toContain("/compact");
          // List labels live in overlayItems (frame may clip first row under tight height).
          expect(shell.overlayItems[0]).toBe(CATALOG[0]!.label);

          moveOverlaySelection(shell, 1);
          expect(shell.overlayList!.activeIndex).toBe(1);

          closeInsetOverlay(shell);
          expect(shell.overlayList).toBeNull();
          expect(shell.overlayKind).toBeNull();
          expect(focusOwner(shell.focus)).toBe("prompt");
          expect(shell.layout.overlayMode).toBe("closed");
          expect(shell.layout.transcriptHeight).toBeGreaterThanOrEqual(IDLE_TRANSCRIPT_FLOOR);
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("accept action dispatches through onCommand", async () => {
    await withTestRenderer(
      async (h) => {
        const dispatched: string[] = [];
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          onCommand: (name) => dispatched.push(name),
        });
        try {
          openPalette(shell, { catalog: CATALOG });
          const helpIdx = shell.paletteCommands.findIndex((c) => c.id === "help");
          expect(helpIdx).toBeGreaterThanOrEqual(0);
          for (let i = 0; i < helpIdx; i++) moveOverlaySelection(shell, 1);
          expect(shell.paletteCommands[shell.overlayList!.activeIndex]!.id).toBe("help");

          acceptOverlaySelection(shell);
          expect(dispatched).toEqual(["help"]);
          expect(shell.overlayList).toBeNull();
          expect(focusOwner(shell.focus)).toBe("prompt");
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("list stacks over permissions; Esc restores permissions then prompt", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        });
        try {
          openPermissionsOverlay(shell, {
            items: ["Allow once", "Deny", "Always allow"],
          });
          expect(shell.overlayKind).toBe("permissions");
          expect(focusOwner(shell.focus)).toBe("overlay");

          openPalette(shell, { catalog: CATALOG });
          expect(shell.overlayKind).toBe("palette");
          expect(focusOwner(shell.focus)).toBe("palette");

          closeInsetOverlay(shell);
          expect(shell.overlayKind).toBe("permissions");
          expect(focusOwner(shell.focus)).toBe("overlay");
          expect(shell.overlayItems[0]).toBe("Allow once");

          closeInsetOverlay(shell);
          expect(shell.overlayList).toBeNull();
          expect(focusOwner(shell.focus)).toBe("prompt");
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });
});

describe("Wave 6: long-log windowing", () => {
  test("multi-thousand append stays interactive (full-retained-log paint)", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        });
        try {
          // Below MAX_RETAINED_STREAM_ROWS: no eviction, so painted == n + 1 below holds.
          const n = MAX_RETAINED_STREAM_ROWS - 50;

          const t0 = performance.now();
          for (let i = 0; i < n; i++) {
            const role = i % 3 === 0 ? "user" : i % 3 === 1 ? "assistant" : "tool";
            if (role === "tool") {
              appendStreamRow(shell, {
                role: "tool",
                text: `row-${i}`,
                meta: "bash",
              });
            } else {
              appendStreamRow(shell, {
                role,
                text: `row-${i}`,
              });
            }
          }
          const elapsed = performance.now() - t0;

          expect(shell.streamLog.length).toBe(n);
          expect(shell.lineCount).toBe(n);
          // Paint tree tracks the full retained log 1:1 (CL-5553) — capped at
          // MAX_RETAINED_STREAM_ROWS by CL-5551, not a smaller paint window,
          // so every retained row stays reachable by scrolling.
          const painted = shell.transcript.getChildren().length;
          expect(painted).toBeLessThanOrEqual(MAX_RETAINED_STREAM_ROWS + 1);
          expect(painted).toBe(n + 1); // +1: bottom-anchor spacer
          // Smoke: no multi-second peg on append storm
          expect(elapsed).toBeLessThan(5_000);

          await h.renderOnce();
          const frame = h.captureCharFrame();
          // Tail still visible
          expect(frame).toContain(`row-${n - 1}`);
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("a long, tool-heavy session retains a bounded tail, not the whole history", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        });
        try {
          const n = MAX_RETAINED_STREAM_ROWS + 200;
          for (let i = 0; i < n; i++) {
            appendStreamRow(shell, { role: "tool", text: `row-${i}`, meta: "bash" });
          }

          // Retention caps the backing array itself, not just the paint window.
          expect(shell.streamLog.length).toBe(MAX_RETAINED_STREAM_ROWS);
          // But the append count the bridge relies on for bookkeeping stays
          // absolute — it must never appear to shrink just because rows were
          // evicted underneath it.
          expect(streamRowCount(shell)).toBe(n);
          // The oldest surviving row is the one at the eviction boundary.
          expect(shell.streamLog[0]).toMatchObject({
            text: `row-${n - MAX_RETAINED_STREAM_ROWS}`,
          });
          // Evicted rows read back as gone, not as some other row's data.
          expect(streamRowAt(shell, 0)).toBeUndefined();
          expect(streamRowAt(shell, n - 1)).toMatchObject({ text: `row-${n - 1}` });
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  }, 20_000);

  test("replaceStreamRowAt keeps targeting the right row across an eviction (absolute index survives the trim)", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        });
        try {
          appendStreamRow(shell, { role: "tool", text: "pinned call", meta: "bash" });
          const pinnedIndex = streamRowCount(shell) - 1;

          // Push the pinned row well past the retention cap.
          for (let i = 0; i < MAX_RETAINED_STREAM_ROWS + 100; i++) {
            appendStreamRow(shell, { role: "tool", text: `filler-${i}`, meta: "bash" });
          }
          // The pinned row itself was evicted; a rewrite must be a safe no-op,
          // not a write to whatever row now occupies that array slot.
          const survivorAtSameSlot = streamRowAt(shell, pinnedIndex);
          expect(survivorAtSameSlot).toBeUndefined();

          const recentIndex = streamRowCount(shell) - 1;
          const before = streamRowAt(shell, recentIndex);
          replaceStreamRowAt(shell, recentIndex, { role: "tool", text: "edited", meta: "bash" });
          expect(streamRowAt(shell, recentIndex)).toMatchObject({ text: "edited" });
          expect(before).not.toMatchObject({ text: "edited" });
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  }, 20_000);
});

describe("Wave 6: chrome zones", () => {
  test("task / agents measured via geometry (not guessed)", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        });
        try {
          expect(shell.layout.heights.task).toBe(0);
          expect(shell.layout.heights.agents).toBe(0);
          expect(shell.taskBox.visible).toBe(false);

          setChromeZones(shell, {
            task: [{ label: "chrome zones", status: "doing" }],
            agents: [{ label: "explore: map callers", tail: "", stalled: false }],
          });

          // CL-5847: the panel is hidden by default — toggle to show before
          // asserting it paints.
          toggleTasksPanel(shell);

          expect(shell.layout.heights.task).toBe(1);
          expect(shell.layout.heights.agents).toBe(1);
          expect(shell.taskBox.visible).toBe(true);
          expect(shell.agentsBox.visible).toBe(true);
          // Transcript still holds constitution floor when possible
          expect(shell.layout.transcriptHeight).toBeGreaterThanOrEqual(1);

          await h.renderOnce();
          const frame = h.captureCharFrame();
          expect(frame).toContain("chrome zones");
          expect(frame).toContain("explore: map callers");

          setChromeZones(shell, { task: null, agents: null });
          expect(shell.layout.heights.task).toBe(0);
          expect(shell.taskBox.visible).toBe(false);
          expect(shell.layout.transcriptHeight).toBeGreaterThanOrEqual(IDLE_TRANSCRIPT_FLOOR);
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("agents panel rows are only rebuilt when the panel's lines actually change", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        });
        try {
          // Seed both zones so later retitles keep the row budget stable.
          // A budget change re-clamps the board and must repaint; this test is
          // about content-identity rebuilds, not clamp-on-resize.
          setChromeZones(shell, {
            task: [{ label: "seed", status: "todo" }],
            agents: [{ label: "explore: map callers", tail: "", stalled: false }],
          });
          const firstBefore = shell.agentsBox.getChildren()[0];
          expect(shell.agentsBox.getChildren()).toHaveLength(1);
          expect(firstBefore).toBeDefined();

          // Task retitle only (same row count) must not rebuild agents rows.
          // Use reference identity — deep-equal on OpenTUI trees hangs on cycles.
          setChromeZones(shell, { task: [{ label: "unrelated", status: "todo" }] });
          expect(shell.agentsBox.getChildren()[0]).toBe(firstBefore);

          // Exact same agent lines again must not rebuild either.
          setChromeZones(shell, {
            agents: [{ label: "explore: map callers", tail: "", stalled: false }],
          });
          expect(shell.agentsBox.getChildren()[0]).toBe(firstBefore);

          // Changed lines must rebuild.
          setChromeZones(shell, {
            agents: [{ label: "explore: map callers", tail: " · 0:01", stalled: false }],
          });
          expect(shell.agentsBox.getChildren()[0]).not.toBe(firstBefore);
          expect(shell.agentsBox.getChildren()).toHaveLength(1);
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("a long agent description is ellipsized to the zone width, never wrapped or clipped", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        });
        try {
          const longDescription =
            "investigate why the reactor loop keeps re-emitting duplicate tool_call.start events under concurrent subagent dispatch";
          setChromeZones(shell, {
            agents: [
              { label: `explore: ${longDescription}`, tail: " · 0:42 · grep", stalled: false },
            ],
          });

          await h.renderOnce();
          const frame = h.captureCharFrame();
          const agentLine = frame.split("\n").find((line) => line.includes("· 0:42 · grep"));
          expect(agentLine).toBeDefined();
          // The frame line includes the shell's left side margin ahead of
          // the zone's own content width.
          expect(agentLine?.trimEnd().length).toBeLessThanOrEqual(
            shell.layout.sideMargin + shell.layout.contentWidth,
          );
          // The tail (what an operator glances at the panel to see) survives
          // whole; only the free-form label is ellipsized.
          expect(agentLine).toContain("…");
          expect(agentLine).not.toContain(longDescription);
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("a wide-character (CJK/emoji) description fits the laid-out width in columns, not UTF-16 units", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        });
        try {
          // Each CJK character is one UTF-16 code unit but two terminal
          // columns; .length would undercount this description's true width
          // by roughly half, letting the row overflow the zone and wrap —
          // exactly the bug width-clamping exists to prevent.
          const wideDescription =
            "调查代理循环中重复出现的工具调用事件问题 across every dispatched worker";
          setChromeZones(shell, {
            agents: [
              { label: `explore: ${wideDescription}`, tail: " · 0:42 · grep", stalled: false },
            ],
          });

          await h.renderOnce();
          const frame = h.captureCharFrame();
          const agentLine = frame.split("\n").find((line) => line.includes("· 0:42 · grep"));
          expect(agentLine).toBeDefined();
          expect(stringWidth(agentLine!.trimEnd())).toBeLessThanOrEqual(
            shell.layout.sideMargin + shell.layout.contentWidth,
          );
          expect(agentLine).toContain("…");
          expect(agentLine).toContain("· 0:42 · grep");

          // No wrap: the zone stays a single row for a single agent.
          expect(shell.layout.heights.agents).toBe(1);
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });
});

// CL-5731: the task list and the agents panel are distinct concepts — a
// task is a unit of work with a status, an agent is an executor — and must
// render as distinct panels, never merged.
describe("CL-5731: task list panel", () => {
  test("each task entry renders with its own status, distinct from the agents panel", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        });
        try {
          setChromeZones(shell, {
            task: [
              { label: "wire task panel", status: "doing" },
              { label: "add toggle", status: "todo" },
              { label: "write docs", status: "done" },
            ],
            agents: [{ label: "explore: map callers", tail: "", stalled: false }],
          });

          // CL-5847: hidden by default — opt in to see the checklist.
          toggleTasksPanel(shell);

          expect(shell.layout.heights.task).toBe(3);
          expect(shell.taskBox.getChildren()).toHaveLength(3);
          // A distinct zone/box from the agents panel — not folded into it.
          expect(shell.taskBox).not.toBe(shell.agentsBox);
          expect(shell.agentsBox.getChildren()).toHaveLength(1);

          await h.renderOnce();
          const frame = h.captureCharFrame();
          expect(frame).toContain("wire task panel");
          expect(frame).toContain("add toggle");
          expect(frame).toContain("write docs");
          expect(frame).toContain("explore: map callers");
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("takes zero vertical space when the task list is empty", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        });
        try {
          setChromeZones(shell, { task: [] });
          expect(shell.layout.heights.task).toBe(0);
          expect(shell.taskBox.visible).toBe(false);
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("stays hidden by default when the task list carries rows, until toggled (CL-5847)", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        });
        try {
          // A fresh shell with seeded tasks paints no task panel — the data
          // is buffered underneath, waiting on Alt+T to opt in.
          setChromeZones(shell, {
            task: [{ label: "seeded but hidden", status: "todo" }],
          });
          expect(shell.layout.heights.task).toBe(0);
          expect(shell.taskBox.visible).toBe(false);
          await h.renderOnce();
          expect(h.captureCharFrame()).not.toContain("seeded but hidden");

          // Toggling is the only way the panel surfaces.
          toggleTasksPanel(shell);
          expect(shell.taskBox.visible).toBe(true);
          expect(shell.layout.heights.task).toBe(1);
          await h.renderOnce();
          expect(h.captureCharFrame()).toContain("seeded but hidden");
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("updates live as the task list changes, without touching the agents panel", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        });
        try {
          setChromeZones(shell, {
            task: [{ label: "first task", status: "todo" }],
            agents: [{ label: "explore: map callers", tail: "", stalled: false }],
          });
          const agentsHeightBefore = shell.layout.heights.agents;

          setChromeZones(shell, {
            task: [{ label: "first task", status: "done" }],
          });

          // CL-5847: hidden by default — opt in to see the live update.
          toggleTasksPanel(shell);

          await h.renderOnce();
          const frame = h.captureCharFrame();
          expect(frame).toContain("[x] first task");
          // The agents board content survives the task panel rebuild: the
          // row is still painted (do not deep-compare renderable nodes —
          // OpenTUI renderables carry circular refs that hang toEqual).
          expect(shell.agentsBox.getChildren()).toHaveLength(1);
          expect(shell.layout.heights.agents).toBe(agentsHeightBefore);
          expect(frame).toContain("explore: map callers");
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("default-hidden panel surfaces live task data on toggle without a stale snapshot", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        });
        try {
          // CL-5847: the panel is hidden by default, even after chrome
          // carries task rows. The data still lands in tasksRaw underneath.
          setChromeZones(shell, {
            task: [{ label: "wire toggle", status: "doing" }],
          });
          expect(shell.taskBox.visible).toBe(false);
          expect(shell.layout.heights.task).toBe(0);

          // First toggle shows the panel.
          toggleTasksPanel(shell);
          expect(shell.taskBox.visible).toBe(true);

          // Second toggle hides it again.
          toggleTasksPanel(shell);
          expect(shell.taskBox.visible).toBe(false);
          expect(shell.layout.heights.task).toBe(0);

          // A live push while hidden must not resurrect the panel...
          setChromeZones(shell, {
            task: [{ label: "wire toggle", status: "done" }],
          });
          expect(shell.taskBox.visible).toBe(false);

          // ...but un-hiding shows the current data, not a stale snapshot
          // from before the hide.
          toggleTasksPanel(shell);
          expect(shell.taskBox.visible).toBe(true);
          await h.renderOnce();
          expect(h.captureCharFrame()).toContain("[x] wire toggle");
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("toggling the panel says so in a flash, not in the transcript", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        });
        try {
          setChromeZones(shell, { task: [{ label: "wire toggle", status: "doing" }] });
          const before = streamRowCount(shell);

          toggleTasksPanel(shell);
          // Which panels are showing is a property of the current screen, not
          // an event in the conversation, so it costs no scrollback.
          expect(streamRowCount(shell)).toBe(before);
          expect(shell.statusFlash).toContain("shown");

          toggleTasksPanel(shell);
          expect(streamRowCount(shell)).toBe(before);
          expect(shell.statusFlash).toContain("hidden");
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("the default-hidden choice persists across further chrome pushes for the life of the shell", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        });
        try {
          // CL-5847: hidden by default — no toggle needed to keep it that way.
          setChromeZones(shell, { task: [{ label: "a", status: "todo" }] });
          expect(shell.taskBox.visible).toBe(false);

          // Several unrelated live pushes later, the default-hidden choice
          // still holds.
          setChromeZones(shell, { task: [{ label: "a", status: "doing" }] });
          setChromeZones(shell, { agents: [{ label: "x: y", tail: "", stalled: false }] });
          setChromeZones(shell, { task: [{ label: "a", status: "done" }] });
          expect(shell.taskBox.visible).toBe(false);
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });
});

describe("CL-5741: chrome zone rows re-fit on terminal resize", () => {
  test("task and agent rows re-fit on width change without a chrome push, and keep identity on height-only resize", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 100, rows: 24 },
          wireKeys: false,
        });
        try {
          const taskTitle = "refit-task-token unique-task-phrase-that-must-not-survive-a-narrow";
          const agentLabel = "refit-agent-token unique-agent-phrase-that-must-not-survive-a-narrow";
          const agentTail = " · 0:42 · grep";
          const uniqueTaskPhrase = "unique-task-phrase-that-must-not-survive-a-narrow";
          const uniqueAgentPhrase = "unique-agent-phrase-that-must-not-survive-a-narrow";

          setChromeZones(shell, {
            task: [{ label: taskTitle, status: "todo" }],
            agents: [{ label: agentLabel, tail: agentTail, stalled: false }],
          });
          // CL-5847: hidden by default — opt in once during setup.
          toggleTasksPanel(shell);

          await h.renderOnce();
          const wideFrame = h.captureCharFrame();
          expect(wideFrame).toContain("refit-task-token");
          expect(wideFrame).toContain(uniqueTaskPhrase);
          expect(wideFrame).toContain("refit-agent-token");
          expect(wideFrame).toContain(uniqueAgentPhrase);
          const taskBoxChild = shell.taskBox.getChildren()[0];
          const agentsBoxChild = shell.agentsBox.getChildren()[0];
          expect(taskBoxChild).toBeDefined();
          expect(agentsBoxChild).toBeDefined();

          h.resize(40, 24);
          await h.renderOnce();
          const narrowFrame = h.captureCharFrame();
          const lines = narrowFrame.split("\n");
          const taskLine = lines.find(
            (line) => line.includes("[ ]") || line.includes("refit-task-token"),
          );
          const agentLine = lines.find((line) => line.includes("· 0:42 · grep"));
          expect(taskLine).toBeDefined();
          expect(agentLine).toBeDefined();
          const maxPainted = shell.layout.sideMargin + shell.layout.contentWidth;
          expect(stringWidth(taskLine!.trimEnd())).toBeLessThanOrEqual(maxPainted);
          expect(stringWidth(agentLine!.trimEnd())).toBeLessThanOrEqual(maxPainted);
          expect(taskLine).toContain("[ ]");
          expect(agentLine).toContain("· 0:42 · grep");
          expect(narrowFrame).not.toContain(uniqueTaskPhrase);
          expect(narrowFrame).not.toContain(uniqueAgentPhrase);
          expect(taskLine).toContain("…");
          expect(agentLine).toContain("…");

          h.resize(100, 24);
          await h.renderOnce();
          const restored = h.captureCharFrame();
          expect(restored).toContain(uniqueTaskPhrase);
          expect(restored).toContain(uniqueAgentPhrase);

          const taskBoxChildAfterRestore = shell.taskBox.getChildren()[0];
          const agentsBoxChildAfterRestore = shell.agentsBox.getChildren()[0];
          h.resize(100, 32);
          await h.renderOnce();
          expect(shell.taskBox.getChildren()[0]).toBe(taskBoxChildAfterRestore);
          expect(shell.agentsBox.getChildren()[0]).toBe(agentsBoxChildAfterRestore);
        } finally {
          shell.dispose();
        }
      },
      { width: 100, height: 24 },
    );
  }, 20_000);
});

describe("Wave 6: keyboard copy path", () => {
  test("enterCopyMode freezes targets and defaults to last", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        });
        try {
          appendStreamRow(shell, { role: "user", text: "first row" });
          appendStreamRow(shell, { role: "assistant", text: "second row" });
          appendStreamRow(shell, {
            role: "system",
            text: "noise",
            meta: "sys",
          });
          const n = shell.streamLog.length;

          const ok = enterCopyMode(shell);
          expect(ok).toBe(true);
          expect(shell.overlayKind).toBe("copy");
          expect(shell.copyTargets?.length).toBe(2);
          expect(shell.overlayList?.activeIndex).toBe(1);
          expect(shell.streamLog.length).toBe(n);

          // Live stream change must not alter frozen targets.
          appendStreamRow(shell, { role: "user", text: "after open" });
          expect(shell.copyTargets?.map((t) => t.text)).toEqual(["first row", "second row"]);
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("confirm last target without navigation", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        });
        try {
          const clip = createRecordingClipboard();
          (shell as unknown as { clipboard: typeof clip }).clipboard = clip;

          appendStreamRow(shell, { role: "user", text: "copy me please" });
          appendStreamRow(shell, {
            role: "system",
            text: "noise",
            meta: "sys",
          });
          const n = shell.streamLog.length;

          expect(enterCopyMode(shell)).toBe(true);
          expect(confirmCopySelection(shell)).toBe(true);
          expect(clip.writes).toEqual(["copy me please"]);
          expect(shell.streamLog.length).toBe(n);
          expect(shell.streamLog.every((r) => r.meta !== "copy")).toBe(true);
          expect(shell.overlayList).toBeNull();
          expect(shell.statusFlash).toContain("Copied");
          await h.renderOnce();
          expect(h.captureCharFrame()).toContain("Copied");
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("navigate up then confirm copies earlier target", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        });
        try {
          const clip = createRecordingClipboard();
          (shell as unknown as { clipboard: typeof clip }).clipboard = clip;

          appendStreamRow(shell, { role: "user", text: "alpha" });
          appendStreamRow(shell, { role: "assistant", text: "beta" });
          appendStreamRow(shell, { role: "tool", text: "gamma", meta: "bash" });
          const n = shell.streamLog.length;

          expect(enterCopyMode(shell)).toBe(true);
          // Default last (gamma); up → beta; up → alpha
          moveOverlaySelection(shell, -1);
          moveOverlaySelection(shell, -1);
          expect(confirmCopySelection(shell)).toBe(true);
          expect(clip.writes).toEqual(["alpha"]);
          expect(shell.streamLog.length).toBe(n);
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("empty log flashes without stream mutation", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        });
        try {
          const ok = enterCopyMode(shell);
          expect(ok).toBe(false);
          expect(shell.streamLog.length).toBe(0);
          expect(shell.overlayList).toBeNull();
          expect(shell.statusFlash).toBe("nothing to copy");
          await h.renderOnce();
          expect(h.captureCharFrame()).toContain("nothing to copy");
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("Esc cancels without clipboard write", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        });
        try {
          const clip = createRecordingClipboard();
          (shell as unknown as { clipboard: typeof clip }).clipboard = clip;

          appendStreamRow(shell, { role: "user", text: "leave me" });
          const n = shell.streamLog.length;
          expect(enterCopyMode(shell)).toBe(true);
          closeInsetOverlay(shell);
          expect(clip.writes).toEqual([]);
          expect(shell.streamLog.length).toBe(n);
          expect(shell.overlayList).toBeNull();
          expect(shell.copyTargets).toBeNull();
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("does not open copy while another overlay is open", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        });
        try {
          appendStreamRow(shell, { role: "user", text: "x" });
          openInsetOverlay(shell, ["Allow", "Deny"]);
          expect(shell.overlayKind).toBe("demo");
          expect(enterCopyMode(shell)).toBe(false);
          expect(shell.overlayKind).toBe("demo");
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("observe copy does not mutate parent snapshot", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        });
        try {
          const clip = createRecordingClipboard();
          (shell as unknown as { clipboard: typeof clip }).clipboard = clip;

          appendStreamRow(shell, { role: "user", text: "parent only" });
          enterSubagentObserve(shell, {
            sessionId: "s1",
            agentId: "explorer",
            description: "scan",
            lines: [{ role: "assistant", text: "child line" }],
          });
          const parentSnap = shell.parentStreamLog?.slice() ?? [];
          const childLen = shell.streamLog.length;

          expect(enterCopyMode(shell)).toBe(true);
          expect(confirmCopySelection(shell)).toBe(true);
          expect(clip.writes).toEqual(["child line"]);
          expect(shell.streamLog.length).toBe(childLen);
          expect(shell.parentStreamLog).toEqual(parentSnap);
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });
});

describe("reasoning effort flash TTL", () => {
  test("effort confirmation flash expires via flashSchedule", async () => {
    await withTestRenderer(
      async (h) => {
        const lapse: (() => void)[] = [];
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: true,
          run: "idle",
          flashSchedule: (fn, ms) => {
            expect(ms).toBe(RUNTIME_FLASH_MS);
            lapse.push(fn);
            return () => {};
          },
        });
        try {
          // Mirrors runner.ts Shift+Tab handler: confirmation flash with TTL.
          setEffortCycleHandler(shell, () => {
            setStatusFlash(shell, "reasoning effort: medium", {
              ttlMs: RUNTIME_FLASH_MS,
            });
          });
          shellFocusPrompt(shell);
          h.pressKey("Tab", { shift: true });
          expect(shell.statusFlash).toBe("reasoning effort: medium");
          expect(lapse).toHaveLength(1);
          lapse[0]?.();
          expect(shell.statusFlash).toBeNull();
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });
});
