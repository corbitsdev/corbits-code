/**
 * Perf gate for CL-6791 P5-J1: stream deltas must coalesce to one row retext
 * per renderer frame instead of one full-row reparse per token, and every
 * close/settle seam must apply the accumulated tail exactly.
 */
import { describe, expect, test } from "bun:test";
import { attachSessionBridge, createRecordingPort } from "./runtime-bridge";
import { createAppShell } from "./shell/index";
import { streamRowAt, streamRowCount } from "./shell/transcript";
import { withTestRenderer } from "./harness";
import { withMockedModuleDuring } from "../../tests/helpers/mock-module.js";
import type { AppShell } from "./shell/internals.js";
import type { StreamRow } from "./stream.js";

type ChromeModule = typeof import("./shell/chrome.js");
interface ReplaceCalls {
  count: number;
}

/**
 * Count `replaceStreamRowAt` invocations (the retext seam the bridge drives)
 * by passing the real chrome module through, so counts reflect production
 * behavior while remaining observable.
 */
async function withCountedReplaceStreamRowAt<R>(
  run: (calls: ReplaceCalls) => Promise<R>,
): Promise<R> {
  const calls: ReplaceCalls = { count: 0 };
  return withMockedModuleDuring<ChromeModule, R>(
    import.meta.resolve("./shell/chrome.js"),
    (real) => ({
      ...real,
      replaceStreamRowAt: (shell: AppShell, index: number, row: StreamRow) => {
        calls.count++;
        real.replaceStreamRowAt(shell, index, row);
      },
    }),
    () => run(calls),
  );
}

describe("runtime-bridge stream row coalescing", () => {
  test("assistant deltas within one frame retext once, idle frame retexts none", async () => {
    await withCountedReplaceStreamRowAt(async (calls) => {
      await withTestRenderer(
        async (h) => {
          const shell = createAppShell(h.renderer, {
            terminal: { columns: 80, rows: 24 },
            wireKeys: false,
            run: "idle",
          });
          const clock = { ms: 1000 };
          const bridge = attachSessionBridge(shell, createRecordingPort(), {
            now: () => clock.ms,
            schedule: () => () => {},
          });
          try {
            const tokens = ["The ", "quick ", "brown ", "fox ", "jumps."];
            for (const token of tokens) {
              bridge.handle({ type: "assistant.delta", text: token });
            }
            // Deltas only accumulate: no retext has happened, and the row the
            // first delta appended still carries only that first token.
            expect(calls.count).toBe(0);
            expect(streamRowCount(shell)).toBe(1);
            expect(streamRowAt(shell, 0)?.text).toBe(tokens[0]);

            await h.renderOnce();
            expect(calls.count).toBe(1);
            expect(streamRowAt(shell, 0)?.text).toBe(tokens.join(""));

            // A frame with no new deltas repaints nothing.
            await h.renderOnce();
            expect(calls.count).toBe(1);

            // Turn end closes the row with the full accumulated text.
            bridge.handle({ type: "system", text: "done" });
            const finalRow = streamRowAt(shell, 0);
            expect(finalRow?.text).toBe(tokens.join(""));
            expect(finalRow?.streaming).not.toBe(true);
            expect(calls.count).toBe(2);
          } finally {
            bridge.dispose();
            shell.dispose();
          }
        },
        { width: 80, height: 24 },
      );
    });
  });

  test("thinking deltas coalesce the same way and flush their tail on close", async () => {
    await withCountedReplaceStreamRowAt(async (calls) => {
      await withTestRenderer(
        async (h) => {
          const shell = createAppShell(h.renderer, {
            terminal: { columns: 80, rows: 24 },
            wireKeys: false,
            run: "idle",
          });
          const clock = { ms: 1000 };
          const bridge = attachSessionBridge(shell, createRecordingPort(), {
            now: () => clock.ms,
            schedule: () => () => {},
          });
          try {
            const tokens = ["reason ", "one ", "two ", "three."];
            for (const token of tokens) {
              bridge.handle({ type: "thinking.delta", text: token });
            }
            expect(calls.count).toBe(0);

            // Reveal is time-bounded; a frame with elapsed clock retexts once.
            clock.ms += 500;
            await h.renderOnce();
            expect(calls.count).toBe(1);

            // Idle frame: reveal position already caught up, nothing new.
            await h.renderOnce();
            expect(calls.count).toBe(1);

            bridge.handle({ type: "system", text: "done" });
            const finalRow = streamRowAt(shell, 0);
            expect(finalRow?.text).toBe(tokens.join(""));
            expect(finalRow?.streaming).not.toBe(true);
          } finally {
            bridge.dispose();
            shell.dispose();
          }
        },
        { width: 80, height: 24 },
      );
    });
  });
});
