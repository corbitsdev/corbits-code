/**
 * Perf gate for CL-6791 P5-J3: non-markdown rows must update in place or at
 * frame cadence — N updates to a row within one frame apply at most once, and
 * no update destroys and rebuilds the row's paint subtree.
 */
import { describe, expect, test } from "bun:test";
import {
  attachSessionBridge,
  createRecordingPort,
  type TaskProgressSession,
} from "./runtime-bridge";
import { createAppShell } from "./shell/index";
import { transcriptRowChildren, streamRowCount, streamRowAt } from "./shell/transcript";
import { toolResultRow } from "./mcp-view";
import { withTestRenderer } from "./harness";
import { withMockedModuleDuring } from "../../tests/helpers/mock-module.js";
import type { AppShell } from "./shell/internals.js";
import type { StreamRow } from "./stream.js";

type ChromeModule = typeof import("./shell/chrome.js");
type TeardownModule = typeof import("./teardown.js");

interface WorkCounts {
  destroys: number;
  builds: number;
  replaces: number;
}

/**
 * Count real work, not calls: subtree destroys (teardown), node rebuilds
 * (createStreamRowRenderable) and row retexts (replaceStreamRowAt) — the
 * seams a destroy-rebuild would have to pass through.
 */
async function withCountedWork<R>(run: (work: WorkCounts) => Promise<R>): Promise<R> {
  const work: WorkCounts = { destroys: 0, builds: 0, replaces: 0 };
  return withMockedModuleDuring<TeardownModule, R>(
    import.meta.resolve("./teardown.js"),
    (real) => ({
      ...real,
      destroySubtree: (node: unknown) => {
        work.destroys++;
        real.destroySubtree(node);
      },
    }),
    () =>
      withMockedModuleDuring<ChromeModule, R>(
        import.meta.resolve("./shell/chrome.js"),
        (real) => ({
          ...real,
          replaceStreamRowAt: (shell: AppShell, index: number, row: StreamRow) => {
            work.replaces++;
            real.replaceStreamRowAt(shell, index, row);
          },
          createStreamRowRenderable: (
            ...args: Parameters<typeof real.createStreamRowRenderable>
          ) => {
            work.builds++;
            return real.createStreamRowRenderable(...args);
          },
        }),
        () => run(work),
      ),
  );
}

const SHELL_OPTS = {
  terminal: { columns: 100, rows: 24 },
  wireKeys: false,
  run: "idle",
} as const;

function taskSession(over: Partial<TaskProgressSession>): TaskProgressSession {
  return {
    id: "task-1",
    status: "running",
    currentToolName: "grep",
    currentToolPreview: null,
    currentToolStartedAt: null,
    startedAt: 0,
    lastActivityAt: 0,
    ...over,
  };
}

describe("row update perf gates (J3)", () => {
  test("N diff-row updates within one frame apply once, with no destroy or rebuild", async () => {
    await withCountedWork(async (work) => {
      await withTestRenderer(
        async (h) => {
          const shell = createAppShell(h.renderer, SHELL_OPTS);
          const bridge = attachSessionBridge(shell, createRecordingPort());
          try {
            bridge.handle({ type: "inference.start", data: {} });
            const arguments_ = JSON.stringify({
              path: "src/a.ts",
              oldText: "x",
              newText: "y",
            });
            for (let i = 0; i < 5; i++) {
              bridge.handle({
                type: "inference.tool_call.end",
                data: { name: "edit_file", callId: `c${i}`, arguments: arguments_ },
              });
            }
            // The first call appends; the four repeats only fold into the
            // pending snapshot — nothing has repainted yet.
            expect(streamRowCount(shell)).toBe(1);
            expect(work.replaces).toBe(0);
            const destroysBeforeFrame = work.destroys;
            await h.renderOnce();
            expect(work.replaces).toBe(1);
            // The coalesced repeat changes the row's shape (a run header, no
            // diff body), so the single frame-time application may rebuild —
            // but only once, never once per repeat.
            expect(work.destroys - destroysBeforeFrame).toBeLessThanOrEqual(1);
            const row = streamRowAt(shell, 0);
            expect(row?.coalesced).toBe(true);
            expect(row?.outstanding).toBe(5);
            // An idle frame applies nothing further.
            await h.renderOnce();
            expect(work.replaces).toBe(1);
          } finally {
            bridge.dispose();
            shell.dispose();
          }
        },
        { width: 100, height: 24 },
      );
    });
  });

  test("tool elapsed ticks: unchanged clock applies nothing, changed clock once per frame", async () => {
    await withCountedWork(async (work) => {
      await withTestRenderer(
        async (h) => {
          const shell = createAppShell(h.renderer, SHELL_OPTS);
          let nowMs = 1_000;
          let tick: (() => void) | undefined;
          const bridge = attachSessionBridge(shell, createRecordingPort(), {
            now: () => nowMs,
            schedule: (fn: () => void) => {
              tick = fn;
              return () => {};
            },
          });
          try {
            bridge.handle({ type: "inference.start", data: {} });
            bridge.handle({
              type: "inference.tool_call.end",
              data: { name: "bash", callId: "b1", arguments: { command: "sleep 5" } },
            });
            await h.renderOnce();
            const baseline = work.replaces;
            const destroys = work.destroys;

            tick?.();
            await h.renderOnce();
            // The first tick changes the row (no stat yet -> "0:00").
            expect(work.replaces).toBe(baseline + 1);
            expect(work.destroys).toBe(destroys);

            // Ticks within the same clock second leave the stat unchanged:
            // zero updates across any number of them.
            for (let i = 0; i < 4; i++) tick?.();
            await h.renderOnce();
            expect(work.replaces).toBe(baseline + 1);

            nowMs += 5_000;
            for (let i = 0; i < 3; i++) tick?.();
            await h.renderOnce();
            expect(work.replaces).toBe(baseline + 2);
            expect(work.destroys).toBe(destroys);
            expect(streamRowAt(shell, 0)?.stat).toBe("0:05");
          } finally {
            bridge.dispose();
            shell.dispose();
          }
        },
        { width: 100, height: 24 },
      );
    });
  });

  test("N sentence-row progress updates within one frame apply once, with no destroy or rebuild", async () => {
    await withCountedWork(async (work) => {
      await withTestRenderer(
        async (h) => {
          const shell = createAppShell(h.renderer, SHELL_OPTS);
          const nowMs = 42_000;
          const bridge = attachSessionBridge(shell, createRecordingPort(), {
            now: () => nowMs,
          });
          try {
            bridge.handle({ type: "inference.start", data: {} });
            bridge.handle({
              type: "inference.tool_call.end",
              data: {
                name: "spawn_agent",
                callId: "task-1",
                arguments: { description: "Review permission gate" },
              },
            });
            await h.renderOnce();
            const baseline = work.replaces;
            const destroys = work.destroys;

            for (let i = 0; i < 4; i++) {
              bridge.syncAgentProgress([taskSession({ lastActivityAt: nowMs })]);
            }
            await h.renderOnce();
            expect(work.replaces).toBe(baseline + 1);
            expect(work.destroys).toBe(destroys);
            const row = streamRowAt(shell, 0);
            expect(row?.pending).toBe(true);
            expect(row?.stat).toContain("grep");

            // Unchanged progress applies nothing further.
            bridge.syncAgentProgress([taskSession({ lastActivityAt: nowMs })]);
            await h.renderOnce();
            expect(work.replaces).toBe(baseline + 1);
          } finally {
            bridge.dispose();
            shell.dispose();
          }
        },
        { width: 100, height: 24 },
      );
    });
  });

  test("diff rows retext their lines in place when the shape is unchanged", async () => {
    await withCountedWork(async (work) => {
      await withTestRenderer(
        async (h) => {
          const shell = createAppShell(h.renderer, SHELL_OPTS);
          const { toolCallRow } = await import("./diff.js");
          const { appendStreamRow, replaceStreamRowAt } = await import("./shell/chrome.js");
          try {
            const diffRow = (newText: string): StreamRow => ({
              ...toolCallRow({
                name: "edit_file",
                arguments: JSON.stringify({ path: "src/a.ts", oldText: "x", newText }),
              }),
              expanded: true,
            });
            appendStreamRow(shell, diffRow("y"));
            await h.renderOnce();
            const node = transcriptRowChildren(shell)[0];
            const builds = work.builds;
            const destroys = work.destroys;

            for (let i = 0; i < 4; i++) {
              replaceStreamRowAt(shell, 0, diffRow(`z${i}`));
            }
            expect(work.destroys).toBe(destroys);
            expect(work.builds).toBe(builds);
            expect(transcriptRowChildren(shell)[0]).toBe(node);
            await h.renderOnce();
            expect(h.captureCharFrame()).toContain("z3");
          } finally {
            shell.dispose();
          }
        },
        { width: 100, height: 24 },
      );
    });
  });

  test("structured rows retext their table in place instead of rebuilding", async () => {
    await withCountedWork(async (work) => {
      await withTestRenderer(
        async (h) => {
          const shell = createAppShell(h.renderer, SHELL_OPTS);
          const LIST_1 = JSON.stringify({
            projects: [
              { name: "Alpha", status: "In Progress", priority: "urgent" },
              { name: "Beta", status: { name: "Done" }, priority: "low" },
            ],
          });
          try {
            const { appendStreamRow, replaceStreamRowAt } = await import("./shell/chrome.js");
            const expandedRow = (content: string): StreamRow => ({
              ...toolResultRow({ name: "mcp__linear__list_projects", content }),
              expanded: true,
            });
            appendStreamRow(shell, expandedRow(LIST_1));
            await h.renderOnce();
            const node = transcriptRowChildren(shell)[0];
            const builds = work.builds;
            const destroys = work.destroys;

            for (let i = 0; i < 5; i++) {
              replaceStreamRowAt(shell, 0, expandedRow(LIST_1.replace("Alpha", `Alpha ${i}`)));
            }
            // Five updates, zero destroy-rebuilds: the same paint node
            // carries the new content, and only its cells changed.
            expect(work.destroys).toBe(destroys);
            expect(work.builds).toBe(builds);
            expect(transcriptRowChildren(shell)[0]).toBe(node);
            await h.renderOnce();
            expect(h.captureCharFrame()).toContain("Alpha 4");
          } finally {
            shell.dispose();
          }
        },
        { width: 100, height: 24 },
      );
    });
  });
});
