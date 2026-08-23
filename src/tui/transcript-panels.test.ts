/**
 * Painted-frame contract for the two bodies the transcript does not lay out
 * itself: a markdown table (the renderer owns it) and a revealed expansion
 * panel (styled lines the row owns). Both have to stay inside the shared
 * gutter, and the reasoning line has to keep costing exactly one turn gap.
 */
import { describe, expect, test } from "bun:test";
import { resolveContentWidth, resolveSideMargin } from "./geometry/margins";
import { withTestRenderer, type Harness } from "./harness";
import { appendStreamRow, createAppShell } from "./shell";
import { rowGroupGap, type StreamRow } from "./stream";

/** Markdown blocks highlight asynchronously; settle before capturing a frame. */
async function settle(h: Harness): Promise<string> {
  await new Promise((resolve) => setTimeout(resolve, 300));
  await h.renderOnce();
  await h.renderOnce();
  return h.captureCharFrame();
}

async function paint(
  rows: readonly StreamRow[],
  columns: number,
  inspect: (frame: string) => void,
): Promise<void> {
  await withTestRenderer(
    async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns, rows: 30 },
        wireKeys: false,
      });
      try {
        for (const row of rows) appendStreamRow(shell, row);
        inspect(await settle(h));
      } finally {
        shell.dispose();
      }
    },
    { width: columns, height: 30 },
  );
}

/** Frame rows carrying ink, so blank padding cannot pass an edge assertion. */
function inkRows(frame: string): readonly string[] {
  return frame.split("\n").filter((row) => row.trim().length > 0);
}

const TABLE = [
  "| Option | What it does in practice for the operator |",
  "| --- | --- |",
  "| truncate | cuts the row at the content edge and marks it with a marker |",
  "| scroll | lets that single row scroll sideways under the arrow keys |",
].join("\n");

describe("a markdown table stays inside the content width", () => {
  for (const columns of [100, 80, 64, 52]) {
    test(`at ${columns} columns`, async () => {
      await paint([{ role: "assistant", text: TABLE }], columns, (frame) => {
        const margin = resolveSideMargin(columns);
        const right = margin + resolveContentWidth(columns);
        const painted = inkRows(frame).filter((row) => row.includes("│"));
        expect(painted.length).toBeGreaterThan(0);
        for (const row of painted) {
          expect(row.slice(0, margin).trim()).toBe("");
          expect(row.slice(right).trim()).toBe("");
        }
      });
    });
  }
});

describe("a revealed body reads as a panel under its summary", () => {
  const skillRow: StreamRow = {
    role: "tool",
    meta: "skill",
    skill: "style",
    expanded: true,
    text: "Write clean code and keep every function small enough that a reader can hold the whole of it in their head at one time.",
  };

  test("the panel is railed, inset past the summary, and closed", async () => {
    await paint([skillRow], 72, (frame) => {
      const rows = inkRows(frame);
      const head = rows.find((row) => row.includes('skill "style" loaded'));
      const railed = rows.filter((row) => row.includes("┆"));
      expect(head).toBeDefined();
      expect(railed.length).toBeGreaterThan(0);

      const body = (head as string).indexOf('skill "style"');
      for (const row of railed) {
        // Subordinate: the rail sits past the column the summary starts on.
        expect(row.indexOf("┆")).toBeGreaterThan(body);
      }
      expect(rows.some((row) => row.trim() === "╵")).toBe(true);
    });
  });

  test("the panel never escapes the shared gutter", async () => {
    for (const columns of [80, 60]) {
      await paint([skillRow], columns, (frame) => {
        const margin = resolveSideMargin(columns);
        const right = margin + resolveContentWidth(columns);
        for (const row of inkRows(frame).filter((line) => line.includes("┆"))) {
          expect(row.slice(0, margin).trim()).toBe("");
          expect(row.slice(right).trim()).toBe("");
        }
      });
    }
  });
});

describe("reasoning costs one turn gap, spent below itself", () => {
  const you: StreamRow = { role: "user", text: "hello" };
  const agent: StreamRow = { role: "assistant", text: "hi" };
  const thinking: StreamRow = { role: "system", meta: "thinking", text: "hmm" };

  test("the pair opens exactly the gap the turn would have", () => {
    expect(rowGroupGap(you, thinking) + rowGroupGap(thinking, agent)).toBe(rowGroupGap(you, agent));
  });

  test("the gap sits between the reasoning line and the answer", () => {
    expect(rowGroupGap(you, thinking)).toBe(0);
    expect(rowGroupGap(thinking, agent)).toBeGreaterThan(0);
  });
});
