import { describe, expect, test } from "bun:test";

import { OVERLAY_MAX_FRACTION, PROMPT_BASE_ROWS } from "./geometry/index.js";
import { withTestRenderer } from "./harness.js";
import {
  composeDecisionBody,
  decisionChoiceRows,
  decisionChoiceRowCount,
  decisionContextBudget,
  describeZoneLines,
  DECISION_ACTIVE_MARK,
  DECISION_CHOICE_ROWS,
  DECISION_DITHER,
  overlayChoiceText,
  overlayKindWord,
  wrapOverlayText,
  wrapWords,
} from "./overlay-body.js";
import { createAppShell, openListOverlay } from "./shell.js";
import { UI } from "./theme.js";
import { stringWidth } from "./view/height.js";

const WIDTHS = [72, 60, 48, 40, 24] as const;

const SENTENCE =
  "The agent wants to run a destructive command on the working tree and this cannot be undone";

const LONG_PATH = "/Users/someone/abklabs/corbits-code/src/tui/geometry/margins.ts";

const LONG_URL = "https://registry.internal.example.com/artifactory/api/npm/npm-virtual/package";

describe("wrapWords", () => {
  for (const width of WIDTHS) {
    test(`never exceeds ${width} columns and never splits a word`, () => {
      const lines = wrapWords(SENTENCE, width);
      for (const line of lines) expect(line.length).toBeLessThanOrEqual(width);
      // Rejoining must reproduce the input exactly: any mid-word break would
      // introduce a character the source never had at that position.
      expect(lines.join(" ").split(/\s+/).join(" ")).toBe(SENTENCE);
    });
  }

  test("wraps at the space, not the column", () => {
    expect(wrapWords("alpha beta gamma", 12)).toEqual(["alpha beta", "gamma"]);
  });

  test("a lone over-long path breaks at a separator", () => {
    const lines = wrapWords(LONG_PATH, 30);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(30);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines.slice(0, -1)) expect(line.endsWith("/")).toBe(true);
    expect(lines.join("")).toBe(LONG_PATH);
  });

  test("a lone over-long URL breaks at a separator", () => {
    const lines = wrapWords(LONG_URL, 32);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(32);
    expect(lines.join("")).toBe(LONG_URL);
    expect(lines.length).toBeGreaterThan(1);
  });

  test("a separator-free token falls back to a deliberate hard break", () => {
    const token = "x".repeat(25);
    const lines = wrapWords(token, 10);
    expect(lines).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
  });

  test("continuation rows keep the source indent", () => {
    const lines = wrapWords("    alpha beta gamma delta", 14);
    expect(lines[0]).toBe("    alpha beta");
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines.slice(1)) expect(line.startsWith("    ")).toBe(true);
  });

  test("blank input yields a single blank row", () => {
    expect(wrapWords("   ", 40)).toEqual([""]);
  });
});

describe("wrapOverlayText", () => {
  test("preserves blank lines and caps", () => {
    expect(wrapOverlayText("a\n\nb", 40, 8)).toEqual(["a", "", "b"]);
    expect(wrapOverlayText("a b c d e f", 4, 2)).toHaveLength(2);
  });
});

describe("composeDecisionBody", () => {
  const body = [
    "run_shell",
    "Run shell command",
    "1) npm install",
    "2) rm -rf build",
    "e expand 1 collapsed payload",
  ].join("\n");

  test("the subject leads with the dither ramp and owns the action color", () => {
    const rows = composeDecisionBody(body, 60, 8);
    expect(rows[0]?.text).toBe(`${DECISION_DITHER} run_shell`);
    expect(rows[0]?.fg).toBe(UI.action);
    // No second row wears the action color: orange is spent once.
    expect(rows.filter((r) => r.fg === UI.action)).toHaveLength(1);
  });

  test("air separates the subject from its context and the choices", () => {
    const rows = composeDecisionBody(body, 60, 8);
    expect(rows[1]?.text).toBe("");
    expect(rows[rows.length - 1]?.text).toBe("");
  });

  test("a wrapped chain segment is indented so it cannot read as a new segment", () => {
    const chained = `run_shell\nRun shell command\n1) npm install ${LONG_PATH}`;
    const rows = composeDecisionBody(chained, 40, 8);
    const texts = rows.map((r) => r.text);
    const first = texts.findIndex((t) => t.startsWith("1)"));
    expect(first).toBeGreaterThan(0);
    expect(texts[first + 1]?.startsWith("  ")).toBe(true);
  });

  test("truncation is announced and keeps the last line", () => {
    const long = [
      "run_shell",
      ...Array.from({ length: 12 }, (_, i) => `${i + 1}) rm -rf build-${i}`),
      "e expand 2 collapsed payloads",
    ].join("\n");
    const rows = composeDecisionBody(long, 60, 8);
    const texts = rows.map((r) => r.text);
    expect(texts.some((t) => t.includes("more lines · full text in transcript"))).toBe(true);
    expect(texts).toContain("e expand 2 collapsed payloads");
    // header + air + 8 context rows + air
    expect(rows.length).toBe(11);
  });

  for (const width of WIDTHS) {
    test(`no row overflows ${width} columns`, () => {
      for (const row of composeDecisionBody(body, width, 8)) {
        expect(row.text.length).toBeLessThanOrEqual(width);
      }
    });
  }
});

describe("decisionChoiceRows", () => {
  const LABEL = "Always allow run_shell in /Users/someone/abklabs/corbits-code (session grant)";
  const SHORT = "Reject";

  test("every choice occupies the same row count, wrapped or not", () => {
    for (const width of [40, 48, 60, 80] as const) {
      const rows = decisionChoiceRowCount([SHORT, LABEL], width);
      expect(rows).toBeGreaterThanOrEqual(DECISION_CHOICE_ROWS);
      expect(decisionChoiceRows(SHORT, true, width, rows)).toHaveLength(rows);
      expect(decisionChoiceRows(LABEL, false, width, rows)).toHaveLength(rows);
    }
  });

  test("the active choice is marked, and short labels pad to two rows", () => {
    const rows = decisionChoiceRows("Reject", true, 60);
    expect(rows[0]?.text).toBe(`${DECISION_ACTIVE_MARK} Reject`);
    expect(rows[0]?.fg).toBe(UI.text);
    expect(rows).toHaveLength(DECISION_CHOICE_ROWS);
    expect(rows[1]?.text).toBe("");
    expect(rows[1]?.fg).toBe(UI.textDim);
  });

  test("an inactive choice is dim and unmarked", () => {
    const rows = decisionChoiceRows("Reject", false, 60);
    expect(rows[0]?.text).toBe("  Reject");
    expect(rows[0]?.fg).toBe(UI.textDim);
  });

  test("a long label wraps on word boundaries and never ellipsizes", () => {
    for (const width of [40, 48, 60, 80] as const) {
      const rows = decisionChoiceRows(LABEL, false, width);
      const joined = rows
        .map((r) => r.text)
        .join(" ")
        .replace(/\s+/g, " ");
      expect(joined).not.toContain("...");
      expect(joined).not.toContain("…");
      expect(joined).toContain("session grant");
      expect(rows.length).toBeGreaterThan(1);
      for (const row of rows) {
        expect(stringWidth(row.text)).toBeLessThanOrEqual(width);
      }
    }
  });

  for (const width of WIDTHS) {
    test(`a long label stays inside ${width} columns`, () => {
      const rows = decisionChoiceRows(LABEL, false, width);
      for (const row of rows) expect(stringWidth(row.text)).toBeLessThanOrEqual(width);
      expect(rows[0]?.text.endsWith("-")).toBe(false);
    });
  }
});

describe("decision overlay paints at narrow widths", () => {
  for (const width of [40, 48, 60, 80]) {
    test(`permission overlay rows stay inside the box at ${width} columns`, async () => {
      const frame = await withTestRenderer(
        async (h) => {
          const shell = createAppShell(h.renderer);
          openListOverlay(shell, {
            kind: "permissions",
            title: "permission",
            items: [
              "Always allow run_shell in this workspace (session grant)",
              "Reject",
              "Accept once",
            ],
            body: `run_shell\nRun shell command\n1) npm install ${LONG_URL}\ne expand 1 collapsed payload`,
          });
          await h.renderOnce();
          return h.captureCharFrame();
        },
        { width, height: 30 },
      );

      const lines = frame.split("\n");
      const top = lines.findIndex((l) => l.trimStart().startsWith("┌"));
      expect(top).toBeGreaterThanOrEqual(0);
      // Border rules stay unbroken: overflowing rows would punch through them.
      for (const line of lines) {
        const trimmed = line.trimStart().trimEnd();
        if (!trimmed.startsWith("┌") && !trimmed.startsWith("└")) continue;
        expect(/^[┌└├┬┐┘─┤┴]+$/.test(trimmed)).toBe(true);
      }
      // Every row the host paints starts with a leading space; a row butting
      // straight against the border is the signature of a wrapped title or a
      // body line that outgrew the box.
      const bottom = lines.findIndex((l, i) => i > top && l.trimStart().startsWith("└"));
      for (const line of lines.slice(top + 1, bottom)) {
        expect(/│\S/.test(line)).toBe(false);
      }
      expect(frame).toContain(`${DECISION_DITHER} run_shell`);
      const interior = lines
        .slice(top + 1, bottom)
        .join(" ")
        .replace(/[│┌┐└┘─]/g, " ")
        .replace(/\s+/g, " ");
      expect(interior).toContain("session grant");
      expect(interior).toContain("Always allow");
      const choiceLines = lines.filter(
        (l) =>
          l.includes("Always allow") ||
          l.includes("session") ||
          l.includes("grant") ||
          l.includes("Accept once") ||
          l.includes("Reject"),
      );
      expect(choiceLines.length).toBeGreaterThan(0);
      for (const line of choiceLines) {
        expect(line).not.toContain("...");
        expect(line).not.toContain("…");
      }
    });
  }
});

describe("describeZoneLines", () => {
  test("fills the two-line budget with what, then impact", () => {
    const { lines, fgs } = describeZoneLines(
      { what: "compaction trims the transcript.", impact: "summarize costs a model call." },
      60,
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("compaction trims the transcript.");
    expect(lines[1]).toContain("summarize costs a model call.");
    expect(fgs[0]).toBe(UI.textDim);
    expect(fgs[1]).toBe(UI.textFaint);
  });

  test("consequence tone paints the impact line in UI.warning", () => {
    const { fgs } = describeZoneLines(
      { what: "sub-agent cap.", impact: "raising it spends more tokens.", tone: "consequence" },
      60,
    );
    expect(fgs[1]).toBe(UI.warning);
  });

  test("a what that wraps to both lines drops impact, same as narrow width would", () => {
    const { lines } = describeZoneLines(
      {
        what: "a description long enough that wrapping it at this width already spends both of the zone's two lines",
        impact: "never shown",
      },
      24,
    );
    expect(lines.join(" ")).not.toContain("never shown");
  });

  test("degrades at 48 columns by dropping impact, keeping what", () => {
    const desc = {
      what: "short",
      impact: "dropped at narrow widths",
    };
    const wide = describeZoneLines(desc, 48);
    expect(wide.lines.some((l) => l.includes("short"))).toBe(true);

    const narrow = describeZoneLines(desc, 20);
    expect(narrow.lines.some((l) => l.includes("short"))).toBe(true);
    expect(narrow.lines.some((l) => l.includes("dropped"))).toBe(false);
  });

  test("drops the whole zone's content below the minimum legible width", () => {
    const { lines } = describeZoneLines({ what: "anything" }, 8);
    expect(lines.every((l) => l.length === 0)).toBe(true);
  });

  test("null description renders two blank lines", () => {
    const { lines } = describeZoneLines(null, 60);
    expect(lines).toEqual(["", ""]);
  });
});

describe("decisionContextBudget", () => {
  const typicalChrome = {
    overlayRowsPerItem: 2,
    overlayTitleRows: 1,
    overlayHostBorderRows: 2,
    overlayMaxFraction: OVERLAY_MAX_FRACTION,
    promptBaseRows: PROMPT_BASE_ROWS,
  } as const;

  test("a tall terminal returns the full context budget", () => {
    expect(
      decisionContextBudget({
        ...typicalChrome,
        terminalHeight: 40,
      }),
    ).toBe(8);
  });

  test("a 10-row terminal drops context so at least one choice row remains", () => {
    const budget = decisionContextBudget({
      ...typicalChrome,
      terminalHeight: 10,
    });
    expect(budget).toBe(0);
  });
});

describe("overlayChoiceText", () => {
  test("quotes a plain list item as-is", () => {
    expect(overlayChoiceText("  Accept once  ", undefined, undefined)).toBe("Chose Accept once.");
  });

  test("echoes a settings field from id and value, not the painted label", () => {
    expect(overlayChoiceText("‹on› off", "auto-compact", "on")).toBe("Set auto compact to on.");
    expect(overlayChoiceText("label", undefined, "on")).toBe("Set setting to on.");
  });
});

describe("overlayKindWord", () => {
  test("reads internal overlay kinds as words", () => {
    expect(overlayKindWord("operator")).toBe("operator");
    expect(overlayKindWord("model_picker")).toBe("model picker");
  });
});
