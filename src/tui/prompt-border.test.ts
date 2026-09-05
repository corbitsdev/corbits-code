import { describe, expect, test } from "bun:test";

import {
  BORDER,
  MCP_ATTENTION_LABEL,
  PLUGIN_ATTENTION_LABEL,
  abbreviateHome,
  composeAttentionLabel,
  composeCostContextMeter,
  composeRule,
  composeWorkspaceLabel,
  costContextText,
  isPlainRule,
  meterEquals,
  ruleText,
  ruleWidth,
} from "./prompt-border";

const TOP = [BORDER.topLeft, BORDER.topRight] as const;
const BOTTOM = [BORDER.bottomLeft, BORDER.bottomRight] as const;

describe("border characters", () => {
  test("every rounded glyph is one cell wide", () => {
    for (const char of Object.values(BORDER)) {
      expect([...char]).toHaveLength(1);
      expect(char.codePointAt(0)).toBeGreaterThan(0x2500 - 1);
    }
  });
});

describe("composeRule", () => {
  test("a label sits right-aligned with rule either side of it", () => {
    const parts = composeRule({ width: 40, corners: TOP, label: "grok 4.5" });
    expect(ruleText(parts)).toBe("╭─────────────────────────── grok 4.5 ─╮");
    expect(ruleWidth(parts)).toBe(40);
  });

  test("the rule is exactly the requested width", () => {
    for (const width of [80, 60, 48, 40, 20, 3]) {
      const parts = composeRule({ width, corners: TOP, label: "grok 4.5" });
      expect(ruleWidth(parts)).toBe(width);
    }
  });

  test("no label leaves an unbroken run of frame characters", () => {
    const parts = composeRule({ width: 20, corners: TOP });
    expect(isPlainRule(parts)).toBe(true);
    expect(ruleText(parts)).toBe("╭──────────────────╮");
  });

  test("brand and label share a rule wide enough for both", () => {
    const parts = composeRule({
      width: 60,
      corners: BOTTOM,
      brand: "▃▅██▆ corbits code",
      label: "~/x (main)",
    });
    expect(ruleText(parts)).toBe("╰─ ▃▅██▆ corbits code ──────────────────────── ~/x (main) ─╯");
    expect(ruleWidth(parts)).toBe(60);
    expect(parts.some((p) => p.role === "brand")).toBe(true);
    expect(parts.some((p) => p.role === "label")).toBe(true);
  });

  test("a rule too narrow for both keeps the label and drops the brand", () => {
    const parts = composeRule({
      width: 24,
      corners: BOTTOM,
      brand: "▃▅██▆ corbits code",
      label: "~/x (main)",
    });
    expect(parts.some((p) => p.role === "brand")).toBe(false);
    expect(ruleText(parts)).toContain("~/x (main)");
    expect(ruleWidth(parts)).toBe(24);
  });

  test("a rule too narrow for either degrades to a plain rule", () => {
    const parts = composeRule({
      width: 10,
      corners: BOTTOM,
      brand: "▃▅██▆ corbits code",
      label: "~/very/long/path (main)",
    });
    expect(isPlainRule(parts)).toBe(true);
    expect(ruleText(parts)).toBe("╰────────╯");
  });

  test("brand, meter and label all seat when the rule is wide enough", () => {
    const parts = composeRule({
      width: 60,
      corners: BOTTOM,
      brand: "corbits code",
      meter: "██████████ 68% · $0.42",
      meterCompact: "██████████ 68%",
      label: "~/x",
    });
    expect(ruleText(parts)).toBe("╰─ corbits code ──────────── ██████████ 68% · $0.42 ─ ~/x ─╯");
    expect(ruleWidth(parts)).toBe(60);
    expect(parts.some((p) => p.role === "meter")).toBe(true);
    expect(parts.some((p) => p.role === "label")).toBe(true);
    expect(parts.some((p) => p.role === "brand")).toBe(true);
  });

  test("drop order under narrowing: brand goes first, then cost, then context, then the label survives longest", () => {
    const base = {
      corners: BOTTOM,
      brand: "corbits code",
      meter: "██████████ 68% · $0.42",
      meterCompact: "██████████ 68%",
      label: "~/x",
    };

    // Wide enough for everything.
    const wide = composeRule({ ...base, width: 60 });
    expect(wide.some((p) => p.role === "brand")).toBe(true);
    expect(ruleText(wide)).toContain("$0.42");

    // Too narrow for the brand: it drops first, meter (with cost) and label remain.
    const noBrand = composeRule({ ...base, width: 34 });
    expect(noBrand.some((p) => p.role === "brand")).toBe(false);
    expect(ruleText(noBrand)).toContain("$0.42");
    expect(ruleText(noBrand)).toContain("~/x");

    // Too narrow for the cost suffix too: the compact meter and label remain.
    const noCost = composeRule({ ...base, width: 26 });
    expect(noCost.some((p) => p.role === "brand")).toBe(false);
    expect(ruleText(noCost)).not.toContain("$0.42");
    expect(ruleText(noCost)).toContain("68%");
    expect(ruleText(noCost)).toContain("~/x");

    // Too narrow for the meter at all: only the label remains.
    const labelOnly = composeRule({ ...base, width: 14 });
    expect(labelOnly.some((p) => p.role === "meter")).toBe(false);
    expect(ruleText(labelOnly)).toContain("~/x");

    // Too narrow for anything: plain rule.
    const plain = composeRule({ ...base, width: 5 });
    expect(isPlainRule(plain)).toBe(true);
  });

  test("attention sits immediately left of the label", () => {
    const parts = composeRule({
      width: 40,
      corners: TOP,
      attention: "mcp !",
      label: "xai · grok",
    });
    expect(ruleText(parts)).toBe("╭───────────────── mcp ! ─ xai · grok ─╮");
    expect(ruleWidth(parts)).toBe(40);
    expect(parts.some((p) => p.role === "attention")).toBe(true);
    expect(parts.some((p) => p.role === "label")).toBe(true);
  });

  test("combined mcp and plugin attention seats as one run", () => {
    const attention = composeAttentionLabel({ mcp: true, plugin: true });
    expect(attention).toBe("mcp ! · plugin !");
    const parts = composeRule({
      width: 48,
      corners: TOP,
      attention: attention!,
      label: "xai · grok",
    });
    expect(ruleText(parts)).toContain("mcp ! · plugin !");
    expect(parts.filter((p) => p.role === "attention")).toHaveLength(1);
  });

  test("composeAttentionLabel covers each attention combination", () => {
    expect(composeAttentionLabel({})).toBeUndefined();
    expect(composeAttentionLabel({ mcp: true })).toBe(MCP_ATTENTION_LABEL);
    expect(composeAttentionLabel({ plugin: true })).toBe(PLUGIN_ATTENTION_LABEL);
    expect(composeAttentionLabel({ mcp: true, plugin: true })).toBe("mcp ! · plugin !");
  });

  test("attention alone still seats when there is no model label", () => {
    const parts = composeRule({ width: 20, corners: TOP, attention: "mcp !" });
    expect(ruleText(parts)).toBe("╭────────── mcp ! ─╮");
    expect(parts.some((p) => p.role === "attention")).toBe(true);
  });

  test("a rule too narrow for both keeps the label and drops attention", () => {
    const parts = composeRule({
      width: 22,
      corners: TOP,
      attention: "mcp !",
      label: "xai · grok-4.6",
    });
    expect(parts.some((p) => p.role === "attention")).toBe(false);
    expect(ruleText(parts)).toContain("xai · grok-4.6");
    expect(ruleWidth(parts)).toBe(22);
  });

  test("the rule stays exactly the requested width with a meter present, at every size", () => {
    for (const width of [120, 80, 60, 48, 40, 20, 10, 3]) {
      const parts = composeRule({
        width,
        corners: BOTTOM,
        brand: "corbits code",
        meter: "██████████ 68% · $0.42",
        meterCompact: "██████████ 68%",
        label: "~/abklabs/corbits-code (migration/opentui-tui)",
      });
      expect(ruleWidth(parts)).toBe(width);
    }
  });
});

describe("composeCostContextMeter", () => {
  test("null when the context window is unknown", () => {
    expect(
      composeCostContextMeter({ contextPercentUsed: null, contextIsEstimate: false }),
    ).toBeNull();
  });

  test("carries the percent and cost", () => {
    const meter = composeCostContextMeter({
      contextPercentUsed: 68,
      costLabel: "$0.42",
      contextIsEstimate: false,
    });
    expect(meter).not.toBeNull();
    expect(meter!.percentLabel).toBe("68%");
    expect(meter!.costLabel).toBe("$0.42");
  });

  test("drops the cost suffix when told to, keeping the percent", () => {
    const meter = composeCostContextMeter({
      contextPercentUsed: 68,
      costLabel: "$0.42",
      contextIsEstimate: false,
    })!;
    expect(costContextText(meter, true)).toContain("$0.42");
    expect(costContextText(meter, false)).not.toContain("$0.42");
    expect(costContextText(meter, false)).toContain("68%");
  });

  test("bands from the percent: 60 quiet, 80 warning, 81 danger", () => {
    const bandAt = (percent: number) =>
      composeCostContextMeter({ contextPercentUsed: percent, contextIsEstimate: false })!.band;
    expect(bandAt(0)).toBe("quiet");
    expect(bandAt(60)).toBe("quiet");
    expect(bandAt(61)).toBe("warning");
    expect(bandAt(80)).toBe("warning");
    expect(bandAt(81)).toBe("danger");
    expect(bandAt(100)).toBe("danger");
  });

  test("flags an estimated percent with a tilde", () => {
    const meter = composeCostContextMeter({ contextPercentUsed: 68, contextIsEstimate: true })!;
    expect(meter.percentLabel).toBe("~68%");
  });
});

describe("abbreviateHome", () => {
  test("replaces the home prefix and leaves anything else alone", () => {
    expect(abbreviateHome("/home/x/code", "/home/x")).toBe("~/code");
    expect(abbreviateHome("/home/x", "/home/x")).toBe("~");
    expect(abbreviateHome("/srv/code", "/home/x")).toBe("/srv/code");
    expect(abbreviateHome("/home/xyz/code", "/home/x")).toBe("/home/xyz/code");
  });
});

describe("composeWorkspaceLabel", () => {
  const cwd = "/home/x/abklabs/corbits-code";

  test("directory and branch, home abbreviated", () => {
    expect(composeWorkspaceLabel({ cwd, branch: "main", home: "/home/x", maxWidth: 80 })).toBe(
      "~/abklabs/corbits-code (main)",
    );
  });

  test("no branch leaves the directory alone", () => {
    expect(composeWorkspaceLabel({ cwd, branch: null, home: "/home/x", maxWidth: 80 })).toBe(
      "~/abklabs/corbits-code",
    );
  });

  test("the path shortens from the left so the branch always survives", () => {
    const label = composeWorkspaceLabel({
      cwd,
      branch: "migration/opentui-tui",
      home: "/home/x",
      maxWidth: 40,
    });
    expect(label).toEndWith("(migration/opentui-tui)");
    expect(label.startsWith("…")).toBe(true);
    expect(label.length).toBeLessThanOrEqual(40);
  });

  test("a path with no room at all yields to the branch alone", () => {
    expect(
      composeWorkspaceLabel({
        cwd,
        branch: "migration/opentui-tui",
        home: "/home/x",
        maxWidth: 24,
      }),
    ).toBe("(migration/opentui-tui)");
  });

  test("no room for even the branch composes to nothing", () => {
    expect(
      composeWorkspaceLabel({
        cwd,
        branch: "migration/opentui-tui",
        home: "/home/x",
        maxWidth: 8,
      }),
    ).toBe("");
  });

  test("never exceeds the width it was given", () => {
    for (let maxWidth = 0; maxWidth <= 60; maxWidth++) {
      const label = composeWorkspaceLabel({
        cwd,
        branch: "migration/opentui-tui",
        home: "/home/x",
        maxWidth,
      });
      expect(label.length).toBeLessThanOrEqual(maxWidth);
    }
  });
});

describe("meterEquals", () => {
  test("null meters compare by identity", () => {
    expect(meterEquals(null, null)).toBe(true);
    expect(
      meterEquals(
        null,
        composeCostContextMeter({ contextPercentUsed: 10, contextIsEstimate: false }),
      ),
    ).toBe(false);
  });

  test("compares percent and cost labels only", () => {
    const a = composeCostContextMeter({
      contextPercentUsed: 68,
      costLabel: "$0.42",
      contextIsEstimate: false,
    });
    const same = composeCostContextMeter({
      contextPercentUsed: 68,
      costLabel: "$0.42",
      contextIsEstimate: false,
    });
    const differentCost = composeCostContextMeter({
      contextPercentUsed: 68,
      costLabel: "$0.43",
      contextIsEstimate: false,
    });
    const differentPercent = composeCostContextMeter({
      contextPercentUsed: 69,
      costLabel: "$0.42",
      contextIsEstimate: false,
    });
    expect(meterEquals(a, same)).toBe(true);
    expect(meterEquals(a, differentCost)).toBe(false);
    expect(meterEquals(a, differentPercent)).toBe(false);
  });
});
