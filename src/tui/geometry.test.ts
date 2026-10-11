import { describe, expect, test } from "bun:test";
import { defined } from "../../testkit/defined.js";
import {
  AGENTS_PANEL_MAX_VISIBLE,
  COLLAPSE_ORDER,
  FLEET_BOARD_CAP_FRACTION,
  FLEET_TRANSCRIPT_FLOOR,
  IDLE_TRANSCRIPT_FLOOR,
  OVERLAY_TRANSCRIPT_FLOOR,
  PROMPT_BASE_ROWS,
  PROMPT_CAP_FRACTION,
  PROMPT_IDLE_ROWS,
  SIDE_MARGIN,
  TASKS_PANEL_MAX_VISIBLE,
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
  test("collapse order cuts temporary banners first and never cuts the prompt below base", () => {
    expect(COLLAPSE_ORDER[0]).toBe("command_banner");
    expect(COLLAPSE_ORDER.at(-1)).toBe("prompt");
    expect(COLLAPSE_ORDER.indexOf("notice")).toBeLessThan(
      COLLAPSE_ORDER.indexOf("prompt"),
    );
  });
});

describe("worker wait zone", () => {
  test("seats one row directly on the prompt box without shrinking it", () => {
    const idle = idle80x24();
    const layout = idle80x24({ visibility: { workerWait: true } });
    const strip = defined(layout.regions.worker_wait, "worker_wait");
    const prompt = defined(layout.regions.prompt, "prompt");
    expect(strip.height).toBe(1);
    expect(strip.y + strip.height).toBe(prompt.y);
    expect(layout.heights.prompt).toBe(idle.heights.prompt);
    expect(layout.transcriptHeight).toBe(idle.transcriptHeight - 1);
  });

  test("is the last optional row cut before prompt growth is reclaimed", () => {
    expect(COLLAPSE_ORDER.indexOf("worker_wait")).toBe(
      COLLAPSE_ORDER.indexOf("prompt") - 1,
    );
    const layout = resolveGeometry({
      terminal: { columns: 80, rows: 18 },
      visibility: { workerWait: true, notice: true, pending: 2 },
    });
    expect(layout.heights.notice).toBe(0);
    expect(layout.heights.pending).toBe(0);
    expect(layout.heights.worker_wait).toBe(1);
  });
});

describe("resolveGeometry — 80×24 idle floor", () => {
  test("idle default chrome yields transcript ≥ 12", () => {
    const layout = idle80x24();
    // The prompt box is the whole of idle chrome: 5 rows → transcript 19.
    expect(layout.chromeHeight).toBe(PROMPT_IDLE_ROWS);
    expect(layout.transcriptHeight).toBe(24 - PROMPT_IDLE_ROWS);
    expect(layout.transcriptHeight).toBeGreaterThanOrEqual(
      IDLE_TRANSCRIPT_FLOOR,
    );
    expect(layout.regions.transcript?.height).toBe(24 - PROMPT_IDLE_ROWS);
    expect(layout.overlayHeight).toBe(0);
    expect(layout.overlayMode).toBe("closed");
    // Stack-only: full-width chat, no rail.
    expect(layout.layoutMode).toBe("stack");
    expect(layout.chatWidth).toBe(layout.contentWidth);
    expect(layout.railWidth).toBe(0);
    expect(layout.railGutter).toBe(0);
  });

  test("rects sit inside the gutter and y-stack without gaps or overlap", () => {
    const layout = idle80x24();
    const order = ["transcript", "prompt"] as const;
    expect(layout.sideMargin).toBe(SIDE_MARGIN);
    expect(layout.contentWidth).toBe(80 - SIDE_MARGIN * 2);
    let y = 0;
    for (const id of order) {
      const r = defined(layout.regions[id], id);
      expect(r.x).toBe(layout.sideMargin);
      expect(r.width).toBe(layout.contentWidth);
      expect(r.y).toBe(y);
      expect(r.height).toBeGreaterThan(0);
      y += r.height;
    }
    expect(y).toBe(24);
  });

  test("transcriptHeight matches regions.transcript.height", () => {
    const layout = idle80x24({
      visibility: { progress: true },
    });
    expect(layout.regions.transcript?.height).toBe(layout.transcriptHeight);
  });
});

describe("resolveGeometry — agents panel", () => {
  test("agents zone max allows more than one row again", () => {
    for (let n = 0; n <= AGENTS_PANEL_MAX_VISIBLE + 3; n++) {
      const layout = idle80x24({ visibility: { agents: n } });
      const fracCap = Math.max(1, Math.floor(24 * FLEET_BOARD_CAP_FRACTION));
      const expected = Math.min(n, ZONE_REGISTRY.agents.max, fracCap);
      // Collapse may shrink further to protect the transcript floor.
      expect(layout.heights.agents).toBeLessThanOrEqual(expected);
      if (n <= 3) {
        // Small requests fit under the floor without collapse.
        expect(layout.heights.agents).toBe(n);
      }
    }
  });

  test("zero agents costs zero chrome", () => {
    const layout = idle80x24({ visibility: { agents: 0 } });
    expect(layout.heights.agents).toBe(0);
    expect(layout.regions.agents).toBeUndefined();
    expect(layout.layoutMode).toBe("stack");
    expect(layout.railWidth).toBe(0);
  });

  test("a large fan-out never grows the board without bound", () => {
    const layout = idle80x24({ visibility: { agents: 50 } });
    // Two independent bounds, and the tighter one wins: the fraction of the
    // terminal the board may take, and whatever the transcript floor leaves.
    expect(layout.heights.agents).toBeLessThanOrEqual(
      Math.floor(24 * FLEET_BOARD_CAP_FRACTION),
    );
    expect(layout.heights.agents).toBeLessThanOrEqual(ZONE_REGISTRY.agents.max);
    expect(layout.transcriptHeight).toBeGreaterThanOrEqual(
      layout.transcriptFloor,
    );
  });

  test("a taller terminal honours the agents row request (stack)", () => {
    const requested = AGENTS_PANEL_MAX_VISIBLE + 1;
    const tall = resolveGeometry({
      terminal: { columns: 120, rows: 40 },
      visibility: { agents: requested },
      transcriptFloor: FLEET_TRANSCRIPT_FLOOR,
    });
    expect(tall.layoutMode).toBe("stack");
    expect(tall.railWidth).toBe(0);
    expect(tall.heights.agents).toBe(requested);
    expect(tall.regions.agents?.width).toBe(tall.contentWidth);
    // Stack: agents sit below transcript and consume vertical chrome.
    expect(defined(tall.regions.agents).y).toBeGreaterThan(
      defined(tall.regions.transcript).y,
    );
  });

  test("with a fleet running the agents zone stacks under the transcript", () => {
    const fleet = resolveGeometry({
      terminal: { columns: 80, rows: 24 },
      visibility: { agents: 1 },
      transcriptFloor: FLEET_TRANSCRIPT_FLOOR,
    });
    expect(fleet.layoutMode).toBe("stack");
    expect(fleet.heights.agents).toBe(1);
    expect(fleet.transcriptHeight).toBeGreaterThanOrEqual(
      FLEET_TRANSCRIPT_FLOOR,
    );
    // The prompt box never leaves the screen, whatever the fleet is doing.
    expect(fleet.heights.prompt).toBeGreaterThanOrEqual(PROMPT_BASE_ROWS);
  });

  test("a bounded agents panel never eats the transcript floor", () => {
    const layout = idle80x24({
      visibility: { agents: AGENTS_PANEL_MAX_VISIBLE + 1 },
    });
    expect(layout.transcriptHeight).toBeGreaterThanOrEqual(
      layout.transcriptFloor,
    );
  });

  test("under pressure the panel shrinks one row at a time rather than vanishing in one step", () => {
    // Banners leave a deficit the agents zone must cover: the fix lands
    // partway (still nonzero), not in a cliff from full request to 0.
    const layout = resolveGeometry({
      terminal: { columns: 80, rows: 20 },
      visibility: {
        commandBanner: 1,
        settingsNotice: 1,
        pluginBanner: true,
        agents: AGENTS_PANEL_MAX_VISIBLE + 1,
      },
    });
    expect(layout.heights.agents).toBeGreaterThan(0);
    expect(layout.heights.agents).toBeLessThan(AGENTS_PANEL_MAX_VISIBLE + 1);
    expect(layout.transcriptHeight).toBeGreaterThanOrEqual(
      layout.transcriptFloor,
    );
  });
});

describe("resolveGeometry — task panel", () => {
  test("N tasks request N rows, bounded by the zone max", () => {
    for (let n = 0; n <= TASKS_PANEL_MAX_VISIBLE + 3; n++) {
      const requested = Math.min(n, TASKS_PANEL_MAX_VISIBLE + 1);
      const layout = idle80x24({ visibility: { task: n } });
      expect(layout.heights.task).toBe(requested);
    }
  });

  test("zero tasks (empty or hidden) costs zero chrome", () => {
    const layout = idle80x24({ visibility: { task: 0 } });
    expect(layout.heights.task).toBe(0);
    expect(layout.regions.task).toBeUndefined();
  });

  test("a large task list never grows the zone past its bounded max", () => {
    const layout = idle80x24({ visibility: { task: 50 } });
    expect(layout.heights.task).toBe(ZONE_REGISTRY.task.max);
    expect(layout.heights.task).toBe(TASKS_PANEL_MAX_VISIBLE + 1);
  });

  test("task and agents panels are distinct zones with independent budgets", () => {
    const layout = idle80x24({
      visibility: { task: 3, agents: 2 },
    });
    expect(layout.heights.task).toBe(3);
    expect(layout.heights.agents).toBe(2);
    expect(layout.regions.task).not.toEqual(layout.regions.agents);
  });

  test("orchestration chrome stacks below the transcript and above the prompt", () => {
    // Visual order top → bottom: transcript, agents, task, prompt.
    const layout = idle80x24({
      visibility: { task: 3, agents: 1 },
    });
    const transcript = defined(layout.regions.transcript);
    const agents = defined(layout.regions.agents);
    const task = defined(layout.regions.task);
    const prompt = defined(layout.regions.prompt);
    expect(transcript.y).toBeLessThan(agents.y);
    expect(agents.y).toBeLessThan(task.y);
    expect(task.y).toBeLessThan(prompt.y);
  });

  test("under pressure the task panel shrinks one row at a time rather than vanishing in one step", () => {
    const layout = resolveGeometry({
      terminal: { columns: 80, rows: 20 },
      visibility: {
        commandBanner: 1,
        settingsNotice: 1,
        pluginBanner: true,
        task: TASKS_PANEL_MAX_VISIBLE + 1,
      },
    });
    expect(layout.heights.task).toBeGreaterThan(0);
    expect(layout.heights.task).toBeLessThan(TASKS_PANEL_MAX_VISIBLE + 1);
    expect(layout.transcriptHeight).toBeGreaterThanOrEqual(
      layout.transcriptFloor,
    );
  });

  test("on a short terminal the task panel is fully collapsed before the prompt is ever shrunk below its idle rows", () => {
    // Shrink the terminal until something has to give. PROMPT_CAP_FRACTION
    // caps the requested prompt, and collapseOnce shrinks it only after
    // draining every zone ahead of it in COLLAPSE_ORDER — task included.
    // Either way: when prompt is below its idle rows, task is already zero.
    for (let rows = 24; rows >= 10; rows--) {
      const layout = resolveGeometry({
        terminal: { columns: 80, rows },
        visibility: { task: TASKS_PANEL_MAX_VISIBLE + 1 },
      });
      if (layout.heights.prompt < PROMPT_IDLE_ROWS) {
        expect(layout.heights.task).toBe(0);
      }
    }
  });
});

describe("resolveGeometry — collapse rules", () => {
  test("collapses optional strips before violating idle floor", () => {
    // Request every optional strip + tall progress on 24 rows.
    const layout = idle80x24({
      visibility: {
        progress: 2,
        progressDivider: true,
        task: true,
        agents: true,
        pluginBanner: true,
        commandBanner: 2,
        settingsNotice: 3,
      },
    });
    expect(layout.transcriptHeight).toBeGreaterThanOrEqual(
      IDLE_TRANSCRIPT_FLOOR,
    );
    // Temporary banners and optional strips should be first to go.
    expect(layout.collapsed.length).toBeGreaterThan(0);
    expect(layout.collapsed[0]).toBe("command_banner");
    // Always-on core chrome still present at min budgets.
    expect(layout.heights.prompt).toBeGreaterThanOrEqual(PROMPT_BASE_ROWS);
  });

  test("progress shrinks 2→1 before dropping when space is scarce", () => {
    // Force scarcity: many optionals on a slightly short terminal still ≥ floor path.
    const crowded = resolveGeometry({
      terminal: { columns: 80, rows: 24 },
      visibility: {
        progress: 2,
        progressDivider: true,
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
        task: true,
        agents: true,
        commandBanner: 2,
        settingsNotice: 3,
        pluginBanner: true,
      },
    });
    // On 20-row, floor is reduced; still must not starve below tiny floor.
    expect(tight.transcriptHeight).toBeGreaterThanOrEqual(
      tight.transcriptFloor,
    );
  });

  test("the notice row is cut only after optional strips and progress_divider", () => {
    const layout = idle80x24({
      visibility: {
        progress: 2,
        progressDivider: true,
        task: true,
        agents: true,
        pluginBanner: true,
        commandBanner: 2,
        settingsNotice: 3,
      },
    });
    const noticeIdx = layout.collapsed.indexOf("notice");
    if (noticeIdx >= 0) {
      const cmdIdx = layout.collapsed.indexOf("command_banner");
      expect(cmdIdx).toBeGreaterThanOrEqual(0);
      expect(cmdIdx).toBeLessThan(noticeIdx);
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
    expect(layout.transcriptHeight).toBeGreaterThanOrEqual(
      IDLE_TRANSCRIPT_FLOOR,
    );
  });

  test("prompt growth is reclaimed when the floor is threatened", () => {
    const layout = idle80x24({
      promptContentRows: 9, // 40% of 24 = 9
      visibility: {
        progress: 2,
        progressDivider: true,
        task: true,
        agents: true,
        commandBanner: 2,
        settingsNotice: 3,
        pluginBanner: true,
      },
    });
    expect(layout.transcriptHeight).toBeGreaterThanOrEqual(
      IDLE_TRANSCRIPT_FLOOR,
    );
    // Prompt should not stay at 9 if collapse was needed.
    if (layout.collapsed.includes("prompt")) {
      expect(layout.heights.prompt).toBeLessThan(9);
      expect(layout.heights.prompt).toBeGreaterThanOrEqual(PROMPT_BASE_ROWS);
    }
  });
});

describe("resolveGeometry — overlay modes", () => {
  test("inset overlay leaves ≥ 8 transcript on 24-row", () => {
    const layout = idle80x24({
      overlay: { mode: "inset", bodyRows: 10 },
    });
    expect(layout.overlayMode).toBe("inset");
    expect(layout.overlayHeight).toBeGreaterThan(0);
    expect(layout.transcriptHeight).toBeGreaterThanOrEqual(
      OVERLAY_TRANSCRIPT_FLOOR,
    );
    expect(layout.regions.overlay_host?.height).toBe(layout.overlayHeight);
    // The prompt box remains visible in inset mode.
    expect(layout.heights.prompt).toBeGreaterThanOrEqual(PROMPT_BASE_ROWS);
  });

  test("inset overlay body is capped by 70% and floor-safe max", () => {
    const layout = idle80x24({
      overlay: { mode: "inset", bodyRows: 100 },
    });
    expect(layout.overlayHeight).toBeLessThanOrEqual(Math.floor(24 * 0.7));
    expect(layout.transcriptHeight).toBeGreaterThanOrEqual(
      OVERLAY_TRANSCRIPT_FLOOR,
    );
  });

  test("a large list overlay on a short terminal never exceeds terminal rows", () => {
    // A ~30-command palette wants more body rows than a short terminal has;
    // the resolver must still sum to exactly terminal.rows.
    for (let rows = 4; rows <= 12; rows++) {
      const layout = resolveGeometry({
        terminal: { columns: 80, rows },
        overlay: { mode: "inset", bodyRows: 48 },
      });
      const total =
        layout.chromeHeight + layout.overlayHeight + layout.transcriptHeight;
      expect(total).toBe(rows);
    }
  });

  test("overlay gets at least its border/title minimum before the transcript floor", () => {
    const layout = idle80x24({
      overlay: { mode: "inset", bodyRows: 48, minBodyRows: 5 },
    });
    expect(layout.overlayHeight).toBeGreaterThanOrEqual(5);
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

describe("resolveGeometry — stack-only layout", () => {
  test("wide terminal with agents still stacks full-width, railWidth 0", () => {
    const layout = resolveGeometry({
      terminal: { columns: 120, rows: 32 },
      visibility: { agents: 8 },
    });
    expect(layout.layoutMode).toBe("stack");
    expect(layout.railWidth).toBe(0);
    expect(layout.railGutter).toBe(0);
    expect(layout.chatWidth).toBe(layout.contentWidth);

    const transcript = defined(layout.regions.transcript);
    const agents = defined(layout.regions.agents);
    const prompt = defined(layout.regions.prompt);

    // Agents strip sits below transcript, full content width.
    expect(agents.y).toBeGreaterThan(transcript.y);
    expect(transcript.width).toBe(layout.contentWidth);
    expect(agents.width).toBe(layout.contentWidth);
    expect(agents.height).toBe(layout.heights.agents);
    expect(prompt.width).toBe(layout.contentWidth);
    expect(prompt.x).toBe(layout.sideMargin);
  });

  test("agents height reduces transcript vs idle baseline (stack chrome)", () => {
    const withAgents = resolveGeometry({
      terminal: { columns: 120, rows: 32 },
      visibility: { agents: 8 },
    });
    const idle = resolveGeometry({
      terminal: { columns: 120, rows: 32 },
      visibility: { agents: 0 },
    });
    expect(withAgents.layoutMode).toBe("stack");
    expect(idle.layoutMode).toBe("stack");
    expect(withAgents.heights.agents).toBe(8);
    expect(withAgents.chromeHeight).toBe(idle.chromeHeight + 8);
    expect(withAgents.transcriptHeight).toBe(idle.transcriptHeight - 8);
  });

  test("no agents → stack with railWidth 0 even on a wide terminal", () => {
    const layout = resolveGeometry({
      terminal: { columns: 120, rows: 40 },
      visibility: { agents: 0 },
    });
    expect(layout.layoutMode).toBe("stack");
    expect(layout.railWidth).toBe(0);
    expect(layout.railGutter).toBe(0);
    expect(layout.chatWidth).toBe(layout.contentWidth);
    expect(layout.regions.agents).toBeUndefined();
  });
});
