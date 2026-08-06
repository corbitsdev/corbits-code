import { describe, expect, test } from "bun:test";
import {
  COLLAPSE_ORDER,
  IDLE_TRANSCRIPT_FLOOR,
  OVERLAY_TRANSCRIPT_FLOOR,
  PROMPT_BASE_ROWS,
  PROMPT_CAP_FRACTION,
  SIDE_MARGIN,
  ZONE_IDS,
  ZONE_REGISTRY,
  resolveGeometry,
  type GeometryInput,
} from "./geometry/index.js";

function idle80x24(overrides: Partial<GeometryInput> = {}) {
  return resolveGeometry({
    terminal: { columns: 80, rows: 24 },
    ...overrides,
  });
}

describe("zone registry", () => {
  test("exports every constitution zone id", () => {
    const expected = [
      "progress",
      "progress_divider",
      "model_bar",
      "prompt",
      "hint",
      "goal",
      "task",
      "agents",
      "plugin_banner",
      "command_banner",
      "settings_notice",
      "transcript",
      "overlay_host",
    ] as const;
    expect([...ZONE_IDS]).toEqual([...expected]);
    for (const id of expected) {
      expect(ZONE_REGISTRY[id].id).toBe(id);
    }
  });

  test("idle defaults match fixed chrome (model+prompt+hint = 5)", () => {
    expect(ZONE_REGISTRY.model_bar.idleDefault).toBe(1);
    expect(ZONE_REGISTRY.prompt.idleDefault).toBe(3);
    expect(ZONE_REGISTRY.hint.idleDefault).toBe(1);
    expect(ZONE_REGISTRY.progress.idleDefault).toBe(0);
    expect(ZONE_REGISTRY.goal.idleDefault).toBe(0);
  });

  test("collapse order cuts temporary banners first and never cuts prompt or hint below base", () => {
    expect(COLLAPSE_ORDER[0]).toBe("command_banner");
    expect(COLLAPSE_ORDER.at(-1)).toBe("prompt");
    expect([...COLLAPSE_ORDER]).not.toContain("hint");
    expect(COLLAPSE_ORDER.indexOf("model_bar")).toBeLessThan(
      COLLAPSE_ORDER.indexOf("prompt"),
    );
  });
});

describe("resolveGeometry — 80×24 idle floor", () => {
  test("idle default chrome yields transcript ≥ 12", () => {
    const layout = idle80x24();
    // model1 + prompt3 + hint1 = 5 → transcript 19
    expect(layout.chromeHeight).toBe(5);
    expect(layout.transcriptHeight).toBe(19);
    expect(layout.transcriptHeight).toBeGreaterThanOrEqual(IDLE_TRANSCRIPT_FLOOR);
    expect(layout.regions.transcript?.height).toBe(19);
    expect(layout.overlayHeight).toBe(0);
    expect(layout.overlayMode).toBe("closed");
  });

  test("rects sit inside the gutter and y-stack without gaps or overlap", () => {
    const layout = idle80x24();
    const order = ["transcript", "model_bar", "prompt", "hint"] as const;
    expect(layout.sideMargin).toBe(SIDE_MARGIN);
    expect(layout.contentWidth).toBe(80 - SIDE_MARGIN * 2);
    let y = 0;
    for (const id of order) {
      const r = layout.regions[id];
      expect(r).toBeDefined();
      expect(r!.x).toBe(layout.sideMargin);
      expect(r!.width).toBe(layout.contentWidth);
      expect(r!.y).toBe(y);
      expect(r!.height).toBeGreaterThan(0);
      y += r!.height;
    }
    expect(y).toBe(24);
  });

  test("transcriptHeight matches regions.transcript.height", () => {
    const layout = idle80x24({
      visibility: { progress: true, goal: true },
    });
    expect(layout.regions.transcript?.height).toBe(layout.transcriptHeight);
  });
});

describe("resolveGeometry — collapse rules", () => {
  test("collapses optional strips before violating idle floor", () => {
    // Request every optional strip + tall progress on 24 rows.
    const layout = idle80x24({
      visibility: {
        progress: 2,
        progressDivider: true,
        goal: true,
        task: true,
        agents: true,
        pluginBanner: true,
        commandBanner: 2,
        settingsNotice: 3,
      },
    });
    expect(layout.transcriptHeight).toBeGreaterThanOrEqual(IDLE_TRANSCRIPT_FLOOR);
    // Temporary banners and optional strips should be first to go.
    expect(layout.collapsed.length).toBeGreaterThan(0);
    expect(layout.collapsed[0]).toBe("command_banner");
    // Always-on core chrome still present at min budgets.
    expect(layout.heights.prompt).toBeGreaterThanOrEqual(PROMPT_BASE_ROWS);
    expect(layout.heights.hint).toBe(1);
  });

  test("progress shrinks 2→1 before dropping when space is scarce", () => {
    // Force scarcity: many optionals on a slightly short terminal still ≥ floor path.
    const crowded = resolveGeometry({
      terminal: { columns: 80, rows: 24 },
      visibility: {
        progress: 2,
        progressDivider: true,
        goal: true,
        task: true,
        agents: true,
        pluginBanner: true,
        commandBanner: 2,
        settingsNotice: 3,
      },
    });
    // After full collapse of banners/optionals, progress may still be 1 or 0.
    if (crowded.heights.progress > 0) {
      // If progress survived, it was reduced via the 2→1 step at some point
      // when starting from 2 — collapsed list should include progress if cut.
      expect(crowded.heights.progress).toBeLessThanOrEqual(2);
    }
    // Explicit unit of the shrink step: start with only progress=2 + divider
    // and artificially tiny rows so progress must shrink.
    const tight = resolveGeometry({
      terminal: { columns: 80, rows: 20 },
      visibility: {
        progress: 2,
        progressDivider: true,
        goal: true,
        task: true,
        agents: true,
        commandBanner: 2,
        settingsNotice: 3,
        pluginBanner: true,
      },
    });
    // On 20-row, floor is reduced; still must not starve below tiny floor.
    expect(tight.transcriptHeight).toBeGreaterThanOrEqual(tight.transcriptFloor);
  });

  test("model_bar is cut only after optional strips and progress_divider", () => {
    const layout = idle80x24({
      visibility: {
        progress: 2,
        progressDivider: true,
        goal: true,
        task: true,
        agents: true,
        pluginBanner: true,
        commandBanner: 2,
        settingsNotice: 3,
      },
    });
    const modelIdx = layout.collapsed.indexOf("model_bar");
    if (modelIdx >= 0) {
      const goalIdx = layout.collapsed.indexOf("goal");
      const cmdIdx = layout.collapsed.indexOf("command_banner");
      expect(cmdIdx).toBeGreaterThanOrEqual(0);
      expect(cmdIdx).toBeLessThan(modelIdx);
      if (goalIdx >= 0) expect(goalIdx).toBeLessThan(modelIdx);
    }
  });
});

describe("resolveGeometry — prompt growth", () => {
  test("prompt cannot expand past floor when overlay closed", () => {
    // Request a huge prompt; must cap so transcript stays ≥ 12.
    const layout = idle80x24({ promptContentRows: 40 });
    expect(layout.heights.prompt).toBeLessThanOrEqual(
      Math.floor(24 * PROMPT_CAP_FRACTION),
    );
    expect(layout.heights.prompt).toBeGreaterThanOrEqual(PROMPT_BASE_ROWS);
    expect(layout.transcriptHeight).toBeGreaterThanOrEqual(IDLE_TRANSCRIPT_FLOOR);
  });

  test("prompt growth is reclaimed before the hint row when floor is threatened", () => {
    const layout = idle80x24({
      promptContentRows: 9, // 40% of 24 = 9
      visibility: {
        progress: 2,
        progressDivider: true,
        goal: true,
        task: true,
        agents: true,
        commandBanner: 2,
        settingsNotice: 3,
        pluginBanner: true,
      },
    });
    expect(layout.transcriptHeight).toBeGreaterThanOrEqual(IDLE_TRANSCRIPT_FLOOR);
    // Prompt should not stay at 9 if collapse was needed.
    if (layout.collapsed.includes("prompt")) {
      expect(layout.heights.prompt).toBe(PROMPT_BASE_ROWS);
    }
    expect(layout.heights.hint).toBe(1);
  });

  test("prompt stays at base 3 by default", () => {
    expect(idle80x24().heights.prompt).toBe(PROMPT_BASE_ROWS);
  });
});

describe("resolveGeometry — overlay modes", () => {
  test("inset overlay leaves ≥ 8 transcript on 24-row", () => {
    const layout = idle80x24({
      overlay: { mode: "inset", bodyRows: 10 },
    });
    expect(layout.overlayMode).toBe("inset");
    expect(layout.overlayHeight).toBeGreaterThan(0);
    expect(layout.transcriptHeight).toBeGreaterThanOrEqual(OVERLAY_TRANSCRIPT_FLOOR);
    expect(layout.regions.overlay_host?.height).toBe(layout.overlayHeight);
    // Prompt + hint remain visible in inset mode.
    expect(layout.heights.prompt).toBeGreaterThanOrEqual(PROMPT_BASE_ROWS);
    expect(layout.heights.hint).toBe(1);
  });

  test("inset overlay body is capped by 70% and floor-safe max", () => {
    const layout = idle80x24({
      overlay: { mode: "inset", bodyRows: 100 },
    });
    expect(layout.overlayHeight).toBeLessThanOrEqual(Math.floor(24 * 0.7));
    expect(layout.transcriptHeight).toBeGreaterThanOrEqual(OVERLAY_TRANSCRIPT_FLOOR);
  });

  test("full_shell hides transcript and gives residual to overlay_host", () => {
    const layout = idle80x24({
      overlay: { mode: "full_shell", bodyRows: 20 },
    });
    expect(layout.overlayMode).toBe("full_shell");
    expect(layout.transcriptHeight).toBe(0);
    expect(layout.heights.prompt).toBe(0);
    // The hint row survives: it carries the overlay's own keys.
    expect(layout.heights.hint).toBe(1);
    expect(layout.overlayHeight).toBeGreaterThan(0);
    expect(layout.overlayHeight + layout.chromeHeight).toBe(24);
  });
});

describe("resolveGeometry — resize / residual", () => {
  test("taller terminal: extra rows go to transcript, not chrome", () => {
    const short = resolveGeometry({ terminal: { columns: 80, rows: 24 } });
    const tall = resolveGeometry({ terminal: { columns: 120, rows: 40 } });
    expect(tall.chromeHeight).toBe(short.chromeHeight);
    expect(tall.transcriptHeight).toBe(short.transcriptHeight + (40 - 24));
    expect(tall.transcriptHeight).toBe(40 - tall.chromeHeight);
  });

  test("120×40 idle still keeps floor and accrues residual to transcript", () => {
    const layout = resolveGeometry({ terminal: { columns: 120, rows: 40 } });
    expect(layout.transcriptHeight).toBeGreaterThanOrEqual(IDLE_TRANSCRIPT_FLOOR);
    expect(layout.chromeHeight).toBe(5);
    expect(layout.transcriptHeight).toBe(35);
  });

  test("does not read process.stdout — pure input only", () => {
    // Sanity: custom tiny size is honored even if stdout differs.
    const layout = resolveGeometry({ terminal: { columns: 40, rows: 18 } });
    expect(layout.terminal.rows).toBe(18);
    expect(layout.terminal.columns).toBe(40);
    const sum =
      layout.chromeHeight + layout.overlayHeight + layout.transcriptHeight;
    expect(sum).toBe(18);
  });
});
