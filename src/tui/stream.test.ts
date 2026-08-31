import { describe, expect, test } from "bun:test";
import { stringWidth } from "./view/height";
import {
  agentVoicesIn,
  blockLabel,
  isCollapsibleRow,
  isMultiAgent,
  paintStreamRow,
  rowGroupGap,
  streamRowGutter,
  toolRowLines,
  toolSentenceLines,
  type RowLayout,
  type StreamRow,
} from "./stream";
import { toolCallRow } from "./diff";
import { toolResultRow } from "./mcp-view";
import { mergeToolRows } from "./tool-rows";
import { UI } from "./theme";

const SOLO: RowLayout = { width: 56, multiAgent: false };
const CREW: RowLayout = { width: 56, multiAgent: true };

const lines = (row: StreamRow, layout: RowLayout = SOLO): string[] =>
  paintStreamRow(row, layout).content.split("\n");

/** Body lines of a user bubble (strip the empty pad rows above and below). */
const userBody = (row: StreamRow, layout: RowLayout = SOLO): string[] => {
  const painted = lines(row, layout);
  expect(painted.length).toBeGreaterThanOrEqual(3);
  return painted.slice(1, -1);
};

describe("stream paint", () => {
  test("one voice needs no labels: the operator is found by the bar", () => {
    const you = userBody({ role: "user", text: "hi" })[0] as string;
    const agent = lines({ role: "assistant", text: "hello" })[0] as string;

    expect(you).not.toContain("you");
    expect(agent).not.toContain("agent");
    expect(agent.startsWith("hello")).toBe(true);
    expect(you.startsWith("▍")).toBe(true);
    expect(you.trimEnd().endsWith("hi")).toBe(true);
  });

  test("the operator's bubble starts on the transcript's first column", () => {
    for (const width of [40, 56, 100]) {
      const painted = lines(
        { role: "user", text: "find the legacy token before the release" },
        { width, multiAgent: false },
      );
      for (const line of painted) {
        expect(line.indexOf("▍")).toBe(0);
        expect(stringWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  test("steer / follow-up prefixes distinguish pending vs delivered", () => {
    expect(userBody({ role: "user", text: "a", meta: "steer" })[0]).toContain(
      "[will steer next] a",
    );
    expect(userBody({ role: "user", text: "b", meta: "queue" })[0]).toContain("[will follow up] b");
    expect(userBody({ role: "user", text: "c", meta: "steering" })[0]).toContain("[steering] c");
    expect(userBody({ role: "user", text: "d", meta: "following-up" })[0]).toContain(
      "[following up] d",
    );
    expect(userBody({ role: "user", text: "e", meta: "following-up" })[0]).not.toContain(
      "steering",
    );
  });

  test("a long operator message wraps as one left-aligned block", () => {
    const text =
      "please find every call site of the legacy token helper and tell me which of them still run in production";
    for (const width of [40, 56, 80, 120]) {
      const painted = lines({ role: "user", text }, { width, multiAgent: false });
      expect(painted.length).toBeGreaterThan(1);
      // One rectangle: every line's bar sits on the same column.
      const bars = new Set(painted.map((line) => line.indexOf("▍")));
      expect(bars.size).toBe(1);
      for (const line of painted) expect(stringWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  test("the operator's bubble has a blank bar row above and below the text", () => {
    const bar = "\u258d";
    const painted = lines({ role: "user", text: "hi" });
    // Shape: bare bar, body, bare bar — breathing room when scrolling (CL-5603).
    expect(painted).toEqual([bar, `${bar} hi`, bar]);
    // Assistant and tool rows stay tight; the pad is user-only.
    expect(lines({ role: "assistant", text: "hello" })).toEqual(["hello"]);
    expect(lines({ role: "tool", text: "ok", meta: "bash" })[0]).not.toBe(bar);
    // A wrapped body still sits between exactly one pad row on each side.
    const long = lines(
      {
        role: "user",
        text: "please find every call site of the legacy token helper and report which still run",
      },
      { width: 40, multiAgent: false },
    );
    expect(long[0]).toBe(bar);
    expect(long[long.length - 1]).toBe(bar);
    expect(long.length).toBeGreaterThan(3);
    for (const line of long.slice(1, -1)) {
      expect(line.startsWith(`${bar} `)).toBe(true);
      expect(line.length).toBeGreaterThan(2);
    }
  });

  test("both human voices keep the cream; nothing paints a gray", () => {
    const rows: readonly StreamRow[] = [
      { role: "user", text: "x" },
      { role: "assistant", text: "x" },
      { role: "tool", text: "x", meta: "bash" },
      { role: "system", text: "x" },
    ];
    const [you, agent] = rows.map((row) => paintStreamRow(row, SOLO).fg);
    expect(you).toBe(UI.text);
    expect(agent).toBe(UI.text);
    for (const row of rows) {
      const fg = paintStreamRow(row, SOLO).fg;
      const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(fg.slice(i, i + 2), 16)) as [
        number,
        number,
        number,
      ];
      expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeGreaterThan(8);
    }
  });

  test("tool rows share a result column regardless of tool name", () => {
    const short = lines({ role: "tool", text: "ok", meta: "ls" })[0] as string;
    const long = lines({ role: "tool", text: "ok", meta: "read_file" })[0] as string;
    expect(short.indexOf("ok")).toBe(long.indexOf("ok"));
  });

  test("a tool row leads with one success marker, not a per-type glyph", () => {
    const names = ["read_file", "write_file", "grep", "bash", "web_fetch", "task"];
    const rows = names.map((name) => lines({ role: "tool", text: "x", meta: name })[0] as string);
    // Every row leads with the same mark regardless of tool name.
    expect(new Set(rows.map((row) => row[0])).size).toBe(1);
    expect(rows[0]?.startsWith("✓")).toBe(true);
  });

  test("an answered call is one row, with no continuation beneath it", () => {
    const merged = mergeToolRows(
      toolCallRow({ name: "grep", arguments: '{"pattern":"legacy"}' }),
      toolResultRow({ name: "grep", content: "42 matches" }),
    );
    const painted = lines(merged);
    expect(painted.length).toBe(1);
    expect(painted[0]).not.toContain("└");
    expect(painted[0]).toContain("✓");
  });

  test("a call in flight is marked as undecided, not as a success", () => {
    const call = lines(toolCallRow({ name: "grep", arguments: '{"pattern":"x"}' }))[0] as string;
    expect(call).toContain("·");
    expect(call).not.toContain("✓");
  });

  test("a failed tool call is marked and steps out of the live tool voice", () => {
    const ok = paintStreamRow({ role: "tool", text: "ok", meta: "bash" }, SOLO);
    const bad = paintStreamRow({ role: "tool", text: "boom", meta: "bash", failed: true }, SOLO);
    expect(bad.content).toContain("×");
    expect(ok.content).not.toContain("×");
    expect(bad.fg).not.toBe(ok.fg);
    // Orange stays reserved for the thing awaiting a decision.
    expect(bad.fg).not.toBe(UI.action);
  });

  test("reasoning is a faint, inset block with no marker of its own", () => {
    const painted = paintStreamRow(
      {
        role: "system",
        text: "scanning the repo\nthen the call sites",
        meta: "thinking",
      },
      SOLO,
    );
    expect(painted.fg).toBe(UI.textFaint);
    const rows = painted.content.split("\n");
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.startsWith("  ")).toBe(true);
      expect(row).not.toContain("┆");
    }
    expect(paintStreamRow({ role: "assistant", text: "done" }, SOLO).fg).toBe(UI.text);
  });

  test("a long reasoning body wraps inside its own block", () => {
    const rows = lines({
      role: "system",
      meta: "thinking",
      text: "the token helper is referenced from four packages and two of them are vendored",
    });
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(row.startsWith("  ")).toBe(true);
      expect(row).not.toContain("┆");
      expect(stringWidth(row)).toBeLessThanOrEqual(SOLO.width);
    }
  });

  test("a second agent's row paints no icon or name inline", () => {
    // Writer identity is a block-level header (see `blockLabel`), not baked
    // into the row body, so a lone row never carries "●" itself.
    const solo = lines({ role: "assistant", text: "on it" })[0] as string;
    const crew = lines({ role: "assistant", text: "on it", agent: "critic" }, CREW)[0] as string;
    expect(solo).not.toContain("●");
    expect(crew).not.toContain("●");
    expect(crew.startsWith("on it")).toBe(true);
    // The operator stays a left-aligned bubble either way.
    expect(lines({ role: "user", text: "go" }, CREW)).toEqual(lines({ role: "user", text: "go" }));
  });

  test("reasoning keeps one body column across its lines", () => {
    const rows = lines(
      { role: "system", meta: "thinking", text: "checking\nthen deciding", agent: "critic" },
      CREW,
    );
    const columns = new Set(rows.map((row) => row.length - row.trimStart().length));
    expect(columns).toEqual(new Set([2]));
  });

  test("a loaded skill collapses to a summary until it is expanded", () => {
    const row: StreamRow = {
      role: "tool",
      text: 'Skill "style" — follow these instructions\n\nline\nline',
      meta: "use_skill",
      skill: "style",
    };
    const WIDE: RowLayout = { width: 96, multiAgent: false };
    const collapsed = lines(row, WIDE);
    expect(collapsed.length).toBe(1);
    expect(collapsed[0]).toContain('skill "style" loaded');
    expect(collapsed[0]).toContain("4 lines");
    expect(collapsed[0]).toContain("Alt+E expand");

    // Summary, the four revealed lines railed beneath it, and the closing tick.
    const expanded = lines({ ...row, expanded: true }, WIDE);
    expect(expanded.length).toBe(6);
    expect(expanded[0]).toContain("Alt+E collapse");
    expect(expanded.join("\n")).toContain("line");
    for (const line of expanded.slice(1, -1)) expect(line).toContain("┆");
    expect(expanded[expanded.length - 1]?.trim()).toBe("╵");
  });
});

describe("tool row sentence treatment", () => {
  const flatten = (row: StreamRow): string =>
    toolSentenceLines(row)
      .flat()
      .map((seg) => seg.text)
      .join("");

  test("reads as verb + coloured subject, not tool name + raw args", () => {
    const row: StreamRow = { role: "tool", text: "{}", verb: "Read", summary: "package.json" };
    const line = toolSentenceLines(row)[0]!;
    expect(flatten(row)).toContain("Read");
    expect(flatten(row)).toContain("package.json");
    const subjectSeg = line.find((seg) => seg.text.includes("package.json"));
    expect(subjectSeg?.fg).toBe(UI.inFlightBright);
    expect(subjectSeg?.fg).not.toBe(UI.text);
  });

  test("the arrow only appears on a row with expandable content", () => {
    const plain: StreamRow = { role: "tool", text: "ok", verb: "Shell", summary: "pwd" };
    const withDetail: StreamRow = {
      role: "tool",
      text: "{}",
      verb: "Read",
      summary: "a.ts",
      detail: [[{ text: "line", fg: UI.text }]],
    };
    expect(isCollapsibleRow(plain)).toBe(false);
    expect(flatten(plain)).not.toMatch(/[▸▾]/);
    expect(isCollapsibleRow(withDetail)).toBe(true);
    expect(flatten(withDetail)).toContain("▸");
    expect(flatten({ ...withDetail, expanded: true })).toContain("▾");
  });

  test("a chained shell command keeps its && structure across lines", () => {
    const row: StreamRow = {
      role: "tool",
      text: "{}",
      verb: "Shell",
      summary: "git status && git log --oneline -5 && pwd && date",
    };
    const rendered = toolSentenceLines(row).map((line) => line.map((seg) => seg.text).join(""));
    expect(rendered.length).toBe(4);
    expect(rendered[0]).toContain("git status");
    expect(rendered[0]).toContain("&& \\");
    expect(rendered[1]?.startsWith("    ")).toBe(true);
    expect(rendered[3]).not.toContain("&&");
  });

  test("an expanded diff row shows +/- lines indented beneath the head", () => {
    const row: StreamRow = {
      role: "tool",
      text: "{}",
      verb: "Write",
      summary: "notes.txt",
      stat: "+1/-0",
      diff: {
        lines: [[{ text: "+ hello", fg: UI.done }]],
        added: 1,
        removed: 0,
      },
      expanded: true,
    };
    const collapsedLines = toolRowLines({ ...row, expanded: false });
    expect(collapsedLines.length).toBe(1);
    const expandedLines = toolRowLines(row);
    expect(expandedLines.length).toBe(2);
    const tail = expandedLines[1]!;
    expect(tail[0]?.text).toBe("  ");
    expect(tail.map((s) => s.text).join("")).toContain("+ hello");
  });
});

describe("writer identity", () => {
  test("distinct writers are counted from the transcript, not configured", () => {
    const solo: readonly StreamRow[] = [
      { role: "user", text: "go" },
      { role: "assistant", text: "ok" },
      { role: "tool", text: "ls", meta: "bash" },
    ];
    expect(isMultiAgent(solo)).toBe(false);
    expect(agentVoicesIn(solo).size).toBe(1);
    expect(isMultiAgent([...solo, { role: "assistant", text: "hi", agent: "critic" }])).toBe(true);
  });
});

describe("vertical rhythm", () => {
  const you = { role: "user", text: "go" } as const;
  const agent = { role: "assistant", text: "ok" } as const;
  const grep = { role: "tool", text: "x", meta: "grep" } as const;
  const grepResult = { role: "tool", text: "42 matches", meta: "grep" } as const;
  const bash = { role: "tool", text: "ls", meta: "bash" } as const;
  const thinking = {
    role: "system",
    text: "hmm",
    meta: "thinking",
  } as const;

  test("the first row opens no gap", () => {
    expect(rowGroupGap(undefined, you)).toBe(0);
  });

  test("a turn boundary opens a gap", () => {
    expect(rowGroupGap(you, agent)).toBe(1);
    expect(rowGroupGap(agent, grep)).toBe(1);
  });

  test("a result stays glued to its call, the next call does not", () => {
    expect(rowGroupGap(grep, grepResult)).toBe(0);
    expect(rowGroupGap(grepResult, bash)).toBe(1);
  });

  test("thinking takes the turn's gap instead of opening one of its own", () => {
    // Same rows either way, so the coalesced line cannot shift the answer.
    expect(rowGroupGap(you, thinking) + rowGroupGap(thinking, agent)).toBe(rowGroupGap(you, agent));
    expect(rowGroupGap(agent, thinking)).toBe(0);
  });
});

describe("row gutter", () => {
  test("a lone agent's markdown body starts on the first column", () => {
    expect(streamRowGutter({ role: "assistant", text: "hi" }, SOLO).content).toBe("");
  });

  test("writer identity never lands in the per-row gutter, multi-agent or not", () => {
    expect(streamRowGutter({ role: "assistant", text: "hi", agent: "critic" }, CREW).content).toBe(
      "",
    );
  });
});

describe("block labels", () => {
  const you = { role: "user", text: "go" } as const;
  const corbits = { role: "assistant", text: "on it" } as const;
  const critic = { role: "assistant", text: "reviewing", agent: "critic" } as const;

  test("single-agent transcripts never label a row", () => {
    expect(blockLabel(undefined, corbits, SOLO)).toBeNull();
    expect(blockLabel(you, corbits, SOLO)).toBeNull();
  });

  test("the operator's own turn is never labelled", () => {
    expect(blockLabel(corbits, you, CREW)).toBeNull();
  });

  test("a block's first row is labelled with its writer", () => {
    expect(blockLabel(undefined, corbits, CREW)).toBe("● agent");
    expect(blockLabel(you, critic, CREW)).toBe("● critic");
  });

  test("a run from the same writer labels only its first row", () => {
    const secondFromCorbits = { role: "assistant", text: "still going" } as const;
    expect(blockLabel(corbits, secondFromCorbits, CREW)).toBeNull();
  });

  test("a change of writer relabels even without a role change", () => {
    expect(blockLabel(corbits, critic, CREW)).toBe("● critic");
  });
});

describe("sub-agent dispatch row marks", () => {
  const dispatch = toolCallRow({
    name: "spawn_agent",
    arguments: JSON.stringify({ description: "Review permission gate" }),
  });

  test("a bare pending call reads as the plain dot", () => {
    expect(streamRowGutter(dispatch, SOLO).content).toContain("·");
  });

  test("an actively working dispatch reads distinctly from the plain dot", () => {
    const working = { ...dispatch, agentWorking: true };
    const gutter = streamRowGutter(working, SOLO).content;
    expect(gutter).toContain("◐");
    expect(gutter).not.toContain("·");
  });

  test("a stalled dispatch reads distinctly from both working and plain pending", () => {
    const stalled = { ...dispatch, agentWorking: false };
    const gutter = streamRowGutter(stalled, SOLO).content;
    expect(gutter).toContain("!");
    expect(gutter).not.toContain("◐");
    expect(gutter).not.toContain("·");
  });

  test("elapsed time and current tool paint as the row's dim trailer", () => {
    const working = { ...dispatch, agentWorking: true, stat: "0:42 · grep" };
    const line = toolSentenceLines(working, 60)
      .flat()
      .map((s) => s.text)
      .join("");
    expect(line).toContain("0:42 · grep");
  });

  test("a resolved dispatch drops back to the plain done mark", () => {
    const result = toolResultRow({ name: "spawn_agent", content: "8 lines", isError: false });
    const merged = mergeToolRows({ ...dispatch, agentWorking: true }, result);
    expect(streamRowGutter(merged, SOLO).content).toContain("✓");
  });
});
