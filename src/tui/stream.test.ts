import { describe, expect, test } from "bun:test";
import { defined } from "../testkit/defined.js";
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
  transcriptSyntaxStyle,
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
    // A marker column leads the body: the text itself never starts at 0.
    expect(you.indexOf("hi")).toBeGreaterThan(0);
    expect(you.trimEnd().endsWith("hi")).toBe(true);
  });

  test("the operator's bubble starts on the transcript's first column", () => {
    for (const width of [40, 56, 100]) {
      const painted = lines(
        { role: "user", text: "find the legacy token before the release" },
        { width, multiAgent: false },
      );
      const marker = painted[0]?.[0];
      expect(marker).toBeDefined();
      for (const line of painted) {
        expect(line[0]).toBe(marker);
        expect(stringWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  test("queued-item meta paints as a plain operator row — no delivery prefixes", () => {
    // Pending state lives in the column above the prompt; a row that reaches
    // the transcript has already delivered and reads as an ordinary message.
    for (const meta of ["steer", "queue", "steering", "following-up"]) {
      expect(userBody({ role: "user", text: "a", meta })[0]).toContain(" a");
      expect(userBody({ role: "user", text: "a", meta })[0]).not.toContain("[");
    }
  });

  test("delivery settlement prefixes keep the original row text", () => {
    expect(
      userBody({
        role: "user",
        text: "exact body",
        meta: "not-delivered",
        deliveryStatus: "not-delivered",
      })[0],
    ).toContain("[not delivered] exact body");
    expect(
      userBody({
        role: "user",
        text: "exact body",
        meta: "delivery-uncertain",
        deliveryStatus: "uncertain",
      })[0],
    ).toContain("[delivery uncertain] exact body");
  });

  test("a long operator message wraps as one left-aligned block", () => {
    const text =
      "please find every call site of the legacy token helper and tell me which of them still run in production";
    for (const width of [40, 56, 80, 120]) {
      const painted = lines(
        { role: "user", text },
        { width, multiAgent: false },
      );
      expect(painted.length).toBeGreaterThan(1);
      // One rectangle: every line's bar sits on the same column.
      const leads = new Set(painted.map((line) => line[0]));
      expect(leads.size).toBe(1);
      for (const line of painted)
        expect(stringWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  test("the operator's bubble has a blank bar row above and below the text", () => {
    const painted = lines({ role: "user", text: "hi" });
    // Shape: bare bar, body, bare bar — breathing room when scrolling (CL-5603).
    expect(painted.length).toBe(3);
    const pad = defined(painted[0]);
    expect(pad.trim()).not.toBe("");
    expect(painted[1]?.startsWith(pad)).toBe(true);
    expect(painted[1]?.slice(pad.length)).toContain("hi");
    expect(painted[2]).toBe(pad);
    // Assistant and tool rows stay tight; the pad is user-only.
    expect(lines({ role: "assistant", text: "hello" })).toEqual(["hello"]);
    expect(lines({ role: "tool", text: "ok", meta: "bash" })[0]).not.toBe(pad);
    // A wrapped body still sits between exactly one pad row on each side.
    const long = lines(
      {
        role: "user",
        text: "please find every call site of the legacy token helper and report which still run",
      },
      { width: 40, multiAgent: false },
    );
    expect(long[0]).toBe(pad);
    expect(long[long.length - 1]).toBe(pad);
    expect(long.length).toBeGreaterThan(3);
    for (const line of long.slice(1, -1)) {
      expect(line.startsWith(`${pad} `)).toBe(true);
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
      const [r, g, b] = [1, 3, 5].map((i) =>
        Number.parseInt(fg.slice(i, i + 2), 16),
      ) as [number, number, number];
      expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeGreaterThan(8);
    }
  });

  test("tool rows share a result column regardless of tool name", () => {
    const short = lines({ role: "tool", text: "ok", meta: "ls" })[0] as string;
    const long = lines({
      role: "tool",
      text: "ok",
      meta: "read_file",
    })[0] as string;
    expect(short.indexOf("ok")).toBe(long.indexOf("ok"));
  });

  test("a tool row leads with one success marker, not a per-type glyph", () => {
    const names = [
      "read_file",
      "write_file",
      "grep",
      "bash",
      "web_fetch",
      "task",
    ];
    const rows = names.map(
      (name) => lines({ role: "tool", text: "x", meta: name })[0] as string,
    );
    // Every row leads with the same mark regardless of tool name.
    expect(new Set(rows.map((row) => row[0])).size).toBe(1);
    expect(rows[0]).toMatch(/^[^a-zA-Z0-9\s]/);
  });

  test("an answered call is one row, with no continuation beneath it", () => {
    const merged = mergeToolRows(
      toolCallRow({ name: "grep", arguments: '{"pattern":"legacy"}' }),
      toolResultRow({ name: "grep", content: "42 matches" }),
    );
    const painted = lines(merged);
    expect(painted.length).toBe(1);
    expect(painted[0]).not.toContain("└");
    // Same answered mark a plain tool result leads with.
    const answered = lines({ role: "tool", text: "ok", meta: "grep" })[0];
    expect(painted[0]?.[0]).toBe(answered?.[0]);
  });

  test("a call in flight is marked as undecided, not as a success", () => {
    const call = lines(
      toolCallRow({ name: "grep", arguments: '{"pattern":"x"}' }),
    )[0] as string;
    const answered = lines({ role: "tool", text: "x", meta: "grep" })[0];
    // A marker is present, just never the answered one.
    expect(call[0]).toMatch(/[^a-zA-Z0-9\s]/);
    expect(call[0]).not.toBe(answered?.[0]);
  });

  test("a failed tool call is marked and steps out of the live tool voice", () => {
    const ok = paintStreamRow({ role: "tool", text: "ok", meta: "bash" }, SOLO);
    const bad = paintStreamRow(
      { role: "tool", text: "boom", meta: "bash", failed: true },
      SOLO,
    );
    // The failure mark replaces the success mark on the same column.
    expect(bad.content[0]).not.toBe(ok.content[0]);
    expect(bad.content[0]).toMatch(/[^a-zA-Z0-9\s]/);
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
      // No box-drawing marker of its own.
      expect(row).not.toMatch(/[\u2500-\u257F]/);
    }
    expect(paintStreamRow({ role: "assistant", text: "done" }, SOLO).fg).toBe(
      UI.text,
    );
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
      expect(row).not.toMatch(/[\u2500-\u257F]/);
      expect(stringWidth(row)).toBeLessThanOrEqual(SOLO.width);
    }
  });

  test("a second agent's row paints no icon or name inline", () => {
    // Writer identity is a block-level header (see `blockLabel`), not baked
    // into the row body, so a lone row never carries "●" itself.
    const solo = lines({ role: "assistant", text: "on it" })[0] as string;
    const crew = lines(
      { role: "assistant", text: "on it", agent: "critic" },
      CREW,
    )[0] as string;
    // No geometric-shape icon baked into the row body.
    expect(solo).not.toMatch(/[\u25A0-\u25FF]/);
    expect(crew).not.toMatch(/[\u25A0-\u25FF]/);
    expect(crew.startsWith("on it")).toBe(true);
    // The operator stays a left-aligned bubble either way.
    expect(lines({ role: "user", text: "go" }, CREW)).toEqual(
      lines({ role: "user", text: "go" }),
    );
  });

  test("reasoning keeps one body column across its lines", () => {
    const rows = lines(
      {
        role: "system",
        meta: "thinking",
        text: "checking\nthen deciding",
        agent: "critic",
      },
      CREW,
    );
    const columns = new Set(
      rows.map((row) => row.length - row.trimStart().length),
    );
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
    const rail = defined(expanded[1]).match(/[\u2500-\u257F]/)?.[0];
    expect(rail).toBeDefined();
    for (const line of expanded.slice(1, -1)) {
      expect(line).toContain(rail as string);
    }
    // The closing tick is a lone box-drawing glyph.
    expect(defined(expanded[expanded.length - 1]).trim()).toMatch(
      /^[\u2500-\u257F]$/,
    );
  });
});

describe("tool row sentence treatment", () => {
  const flatten = (row: StreamRow): string =>
    toolSentenceLines(row)
      .flat()
      .map((seg) => seg.text)
      .join("");

  test("reads as verb + coloured subject, not tool name + raw args", () => {
    const row: StreamRow = {
      role: "tool",
      text: "{}",
      verb: "Read",
      summary: "package.json",
    };
    const line = defined(toolSentenceLines(row)[0]);
    expect(flatten(row)).toContain("Read");
    expect(flatten(row)).toContain("package.json");
    const subjectSeg = line.find((seg) => seg.text.includes("package.json"));
    expect(subjectSeg?.fg).toBe(UI.inFlightBright);
    expect(subjectSeg?.fg).not.toBe(UI.text);
  });

  test("the arrow only appears on a row with expandable content", () => {
    const plain: StreamRow = {
      role: "tool",
      text: "ok",
      verb: "Shell",
      summary: "pwd",
    };
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
    const rendered = toolSentenceLines(row).map((line) =>
      line.map((seg) => seg.text).join(""),
    );
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
    const tail = defined(expandedLines[1]);
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
    expect(
      isMultiAgent([
        ...solo,
        { role: "assistant", text: "hi", agent: "critic" },
      ]),
    ).toBe(true);
  });
});

describe("vertical rhythm", () => {
  const you = { role: "user", text: "go" } as const;
  const agent = { role: "assistant", text: "ok" } as const;
  const grep = { role: "tool", text: "x", meta: "grep" } as const;
  const grepResult = {
    role: "tool",
    text: "42 matches",
    meta: "grep",
  } as const;
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
    expect(rowGroupGap(you, thinking) + rowGroupGap(thinking, agent)).toBe(
      rowGroupGap(you, agent),
    );
    expect(rowGroupGap(agent, thinking)).toBe(0);
  });
});

describe("row gutter", () => {
  test("a lone agent's markdown body starts on the first column", () => {
    expect(
      streamRowGutter({ role: "assistant", text: "hi" }, SOLO).content,
    ).toBe("");
  });

  test("writer identity never lands in the per-row gutter, multi-agent or not", () => {
    expect(
      streamRowGutter({ role: "assistant", text: "hi", agent: "critic" }, CREW)
        .content,
    ).toBe("");
  });
});

describe("block labels", () => {
  const you = { role: "user", text: "go" } as const;
  const corbits = { role: "assistant", text: "on it" } as const;
  const critic = {
    role: "assistant",
    text: "reviewing",
    agent: "critic",
  } as const;

  test("single-agent transcripts never label a row", () => {
    expect(blockLabel(undefined, corbits, SOLO)).toBeNull();
    expect(blockLabel(you, corbits, SOLO)).toBeNull();
  });

  test("the operator's own turn is never labelled", () => {
    expect(blockLabel(corbits, you, CREW)).toBeNull();
  });

  test("a block's first row is labelled with its writer", () => {
    const agentLabel = defined(blockLabel(undefined, corbits, CREW));
    const criticLabel = defined(blockLabel(you, critic, CREW));
    // One shared icon marker, then the writer's name.
    expect(agentLabel[0]).toBe(criticLabel[0]);
    expect(agentLabel[0]).toMatch(/[^a-zA-Z0-9\s]/);
    expect(agentLabel.endsWith("agent")).toBe(true);
    expect(criticLabel.endsWith("critic")).toBe(true);
  });

  test("a run from the same writer labels only its first row", () => {
    const secondFromCorbits = {
      role: "assistant",
      text: "still going",
    } as const;
    expect(blockLabel(corbits, secondFromCorbits, CREW)).toBeNull();
  });

  test("a change of writer relabels even without a role change", () => {
    const label = defined(blockLabel(corbits, critic, CREW));
    expect(label.endsWith("critic")).toBe(true);
    expect(label).not.toBe("critic");
  });
});

describe("sub-agent dispatch row marks", () => {
  const dispatch = toolCallRow({
    name: "spawn_agent",
    arguments: JSON.stringify({ description: "Review permission gate" }),
  });

  test("a bare pending call reads as a single pending mark", () => {
    const gutter = streamRowGutter(dispatch, SOLO).content;
    expect(gutter[0]).toMatch(/[^a-zA-Z0-9\s]/);
  });

  test("an actively working dispatch reads distinctly from the plain pending mark", () => {
    const working = { ...dispatch, agentWorking: true };
    const pendingMark = streamRowGutter(dispatch, SOLO).content[0];
    const workingMark = streamRowGutter(working, SOLO).content[0];
    expect(workingMark).toMatch(/[^a-zA-Z0-9\s]/);
    expect(workingMark).not.toBe(pendingMark);
  });

  test("a stalled dispatch reads distinctly from both working and plain pending", () => {
    const stalled = { ...dispatch, agentWorking: false };
    const working = { ...dispatch, agentWorking: true };
    const pendingMark = streamRowGutter(dispatch, SOLO).content[0];
    const workingMark = streamRowGutter(working, SOLO).content[0];
    const stalledMark = streamRowGutter(stalled, SOLO).content[0];
    expect(stalledMark).toMatch(/[^a-zA-Z0-9\s]/);
    expect(stalledMark).not.toBe(workingMark);
    expect(stalledMark).not.toBe(pendingMark);
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
    const result = toolResultRow({
      name: "spawn_agent",
      content: "8 lines",
      isError: false,
    });
    const merged = mergeToolRows({ ...dispatch, agentWorking: true }, result);
    // Back to the same answered mark a plain tool result leads with.
    const doneMark = streamRowGutter(
      { role: "tool", text: "ok", meta: "bash" },
      SOLO,
    ).content[0];
    expect(streamRowGutter(merged, SOLO).content[0]).toBe(doneMark);
  });
});

// TUI markdown links are click-only: there is no hover tracking, so no hover
// state may add an affordance the idle render does not have. Pin
// underline-absence on the link scopes so a future hover style cannot sneak
// one in (CL-7927).
describe("transcriptSyntaxStyle markdown links", () => {
  test("link cells carry no underline", () => {
    const styles = transcriptSyntaxStyle().getAllStyles();
    expect(styles.get("markup.link")?.underline).not.toBe(true);
    expect(styles.get("markup.link.url")?.underline).not.toBe(true);
  });
});
