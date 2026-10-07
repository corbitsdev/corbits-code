/**
 * Consecutive duplicate system echoes collapse instead of painting twice,
 * and a deferred session header flushes first when the landing clears.
 *
 * The duplicate-collapse and FIFO flush-order contracts hold with synthetic
 * strings here: the wording of other modules' notices (model picker, wiring)
 * is their own copy to pin, not this suite's.
 */
import { describe, expect, test } from "bun:test";
import { composeSessionHeader } from "./components/session-header.js";
import { withTestRenderer } from "./harness";
import { appendStreamRow } from "./shell/chrome";
import { createAppShell } from "./shell/index";
import { isLanding } from "./shell/internals";
import { surfaceSystemNotice } from "./shell/prompt";
import { streamRowCount } from "./shell/transcript";

const OPTIONS = {
  terminal: { columns: 80, rows: 24 },
  wireKeys: false,
};

const DUPLICATE_TEXT = "synthetic duplicate notice.";
const OTHER_TEXT = "synthetic second startup notice.";

describe("startup transcript", () => {
  test("consecutive duplicate system rows paint once", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, OPTIONS);
      try {
        appendStreamRow(shell, {
          role: "system",
          text: DUPLICATE_TEXT,
          meta: "synthetic source",
        });
        appendStreamRow(shell, {
          role: "system",
          text: DUPLICATE_TEXT,
          meta: "synthetic source",
        });
        expect(streamRowCount(shell)).toBe(1);
        expect(shell.streamLog.map((row) => row.text)).toEqual([
          DUPLICATE_TEXT,
        ]);
      } finally {
        shell.dispose();
      }
    });
  });

  test("separated repeats and other roles still paint", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, OPTIONS);
      try {
        appendStreamRow(shell, { role: "system", text: DUPLICATE_TEXT });
        appendStreamRow(shell, { role: "user", text: "hi" });
        appendStreamRow(shell, { role: "system", text: DUPLICATE_TEXT });
        appendStreamRow(shell, { role: "system", text: DUPLICATE_TEXT });
        appendStreamRow(shell, { role: "tool", text: DUPLICATE_TEXT });
        expect(shell.streamLog.map((row) => row.text)).toEqual([
          DUPLICATE_TEXT,
          "hi",
          DUPLICATE_TEXT,
          DUPLICATE_TEXT,
        ]);
      } finally {
        shell.dispose();
      }
    });
  });

  test("same-text rows from different writers both paint", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, OPTIONS);
      try {
        appendStreamRow(shell, {
          role: "system",
          text: DUPLICATE_TEXT,
          agent: "synthetic-agent-a",
        });
        appendStreamRow(shell, {
          role: "system",
          text: DUPLICATE_TEXT,
          agent: "synthetic-agent-b",
        });
        expect(shell.streamLog.map((row) => row.text)).toEqual([
          DUPLICATE_TEXT,
          DUPLICATE_TEXT,
        ]);
        expect(shell.agentVoices.size).toBe(2);
      } finally {
        shell.dispose();
      }
    });
  });

  test("same-text rows with different meta both paint", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, OPTIONS);
      try {
        appendStreamRow(shell, {
          role: "system",
          text: DUPLICATE_TEXT,
          meta: "synthetic source a",
        });
        appendStreamRow(shell, {
          role: "system",
          text: DUPLICATE_TEXT,
          meta: "synthetic source b",
        });
        expect(shell.streamLog.map((row) => row.text)).toEqual([
          DUPLICATE_TEXT,
          DUPLICATE_TEXT,
        ]);
      } finally {
        shell.dispose();
      }
    });
  });

  test("a deferred session header flushes first when the landing clears", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, { ...OPTIONS, run: "idle" });
      try {
        const header = composeSessionHeader({
          essentials: "synthetic profile · synthetic model",
        });
        expect(isLanding(shell)).toBe(true);
        surfaceSystemNotice(shell, header);
        surfaceSystemNotice(shell, OTHER_TEXT);
        expect(streamRowCount(shell)).toBe(0);
        appendStreamRow(shell, { role: "user", text: "first prompt" });
        expect(shell.streamLog.map((row) => row.text)).toEqual([
          header,
          OTHER_TEXT,
          "first prompt",
        ]);
      } finally {
        shell.dispose();
      }
    });
  });
});
