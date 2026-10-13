/**
 * QUEUED INPUT zone geometry: requested height, seating on the prompt box,
 * coexistence with WORKER WAITING / pending, collapse before worker_wait and
 * restore when room returns, and in-bounds no-overlap on a short terminal.
 */
import { describe, expect, test } from "bun:test";
import { defined } from "../../../testkit/defined.js";
import {
  COLLAPSE_ORDER,
  IDLE_TRANSCRIPT_FLOOR,
  PROMPT_BASE_ROWS,
  PROMPT_IDLE_ROWS,
  ZONE_REGISTRY,
  resolveGeometry,
  type GeometryInput,
} from "./index.js";
import { PAINT_ORDER } from "./zones.js";

function idle80x24(overrides: Partial<GeometryInput> = {}) {
  return resolveGeometry({
    terminal: { columns: 80, rows: 24 },
    ...overrides,
  });
}

describe("queued_input zone", () => {
  test("requested visibility seats exactly one row directly on the prompt box", () => {
    const baseline = idle80x24();
    const layout = idle80x24({ visibility: { queuedInput: true } });
    const strip = defined(layout.regions.queued_input, "queued_input");
    const prompt = defined(layout.regions.prompt, "prompt");
    expect(strip.height).toBe(1);
    expect(strip.y + strip.height).toBe(prompt.y);
    // The strip takes its row from the transcript, never the composer.
    expect(layout.heights.prompt).toBe(baseline.heights.prompt);
    expect(layout.transcriptHeight).toBe(baseline.transcriptHeight - 1);
  });

  test("zero visibility costs zero chrome", () => {
    const layout = idle80x24();
    expect(layout.heights.queued_input).toBe(0);
    expect(layout.regions.queued_input).toBeUndefined();
  });

  test("sits between worker_wait and prompt in paint order", () => {
    expect(PAINT_ORDER.indexOf("worker_wait")).toBeLessThan(
      PAINT_ORDER.indexOf("queued_input"),
    );
    expect(PAINT_ORDER.indexOf("queued_input")).toBeLessThan(
      PAINT_ORDER.indexOf("prompt"),
    );
    const layout = idle80x24({
      visibility: { workerWait: true, queuedInput: true },
    });
    const waiting = defined(layout.regions.worker_wait, "worker_wait");
    const queued = defined(layout.regions.queued_input, "queued_input");
    const prompt = defined(layout.regions.prompt, "prompt");
    expect(waiting.height).toBe(1);
    expect(queued.height).toBe(1);
    expect(waiting.y + waiting.height).toBe(queued.y);
    expect(queued.y + queued.height).toBe(prompt.y);
    expect(layout.heights.prompt).toBe(PROMPT_IDLE_ROWS);
  });

  test("coexists with pending items above worker_wait", () => {
    const layout = idle80x24({
      visibility: { pending: 2, workerWait: true, queuedInput: true },
    });
    const pending = defined(layout.regions.pending, "pending");
    const waiting = defined(layout.regions.worker_wait, "worker_wait");
    const queued = defined(layout.regions.queued_input, "queued_input");
    const prompt = defined(layout.regions.prompt, "prompt");
    expect(pending.height).toBe(2);
    expect(waiting.height).toBe(1);
    expect(queued.height).toBe(1);
    expect(pending.y + pending.height).toBe(waiting.y);
    expect(waiting.y + waiting.height).toBe(queued.y);
    expect(queued.y + queued.height).toBe(prompt.y);
    expect(layout.transcriptHeight).toBeGreaterThanOrEqual(
      layout.transcriptFloor,
    );
  });

  test("collapses before worker_wait under height pressure", () => {
    // Pending own-input rows cut after banners but before the queued-input
    // strip; the queued-input strip cuts before the worker-wait strip.
    expect(COLLAPSE_ORDER.indexOf("pending")).toBeLessThan(
      COLLAPSE_ORDER.indexOf("queued_input"),
    );
    expect(COLLAPSE_ORDER.indexOf("queued_input")).toBeLessThan(
      COLLAPSE_ORDER.indexOf("worker_wait"),
    );
    expect(COLLAPSE_ORDER.indexOf("worker_wait")).toBeLessThan(
      COLLAPSE_ORDER.indexOf("prompt"),
    );
    const layout = resolveGeometry({
      terminal: { columns: 80, rows: 18 },
      visibility: {
        notice: true,
        pending: 6,
        agents: 11,
        task: 3,
        workerWait: true,
        queuedInput: true,
      },
    });
    expect(layout.heights.notice).toBe(0);
    expect(layout.heights.pending).toBe(0);
    expect(layout.heights.queued_input).toBe(0);
    // A parked worker stays visible: its row is the last optional cut.
    expect(layout.heights.worker_wait).toBe(1);
    expect(layout.transcriptHeight).toBeGreaterThanOrEqual(
      layout.transcriptFloor,
    );
  });

  test("restores when room returns after a constrained-height collapse", () => {
    const narrow = resolveGeometry({
      terminal: { columns: 80, rows: 18 },
      visibility: {
        notice: true,
        pending: 6,
        agents: 11,
        task: 3,
        workerWait: true,
        queuedInput: true,
      },
    });
    expect(narrow.heights.queued_input).toBe(0);
    // The ledger is untouched by collapse; the same visibility on a taller
    // terminal seats the strip again.
    const restored = resolveGeometry({
      terminal: { columns: 80, rows: 24 },
      visibility: {
        notice: true,
        pending: 6,
        agents: 11,
        task: 3,
        workerWait: true,
        queuedInput: true,
      },
    });
    expect(restored.heights.queued_input).toBe(1);
    expect(defined(restored.regions.queued_input).height).toBe(1);
    expect(restored.transcriptHeight).toBeGreaterThanOrEqual(
      IDLE_TRANSCRIPT_FLOOR,
    );
  });

  test("short terminal stays in bounds with no overlap", () => {
    const layout = resolveGeometry({
      terminal: { columns: 12, rows: 10 },
      visibility: { pending: 1, workerWait: true, queuedInput: true },
    });
    const prompt = defined(layout.regions.prompt, "prompt");
    expect(prompt.y + prompt.height).toBeLessThanOrEqual(10);
    expect(layout.heights.prompt).toBeGreaterThanOrEqual(PROMPT_BASE_ROWS);
    // Whatever collapsed, the visible regions y-stack without overlap.
    const regions = PAINT_ORDER.map((id) => layout.regions[id]).filter(
      (region) => region !== undefined && region.height > 0,
    );
    for (let index = 1; index < regions.length; index += 1) {
      const previous = regions[index - 1];
      const current = regions[index];
      if (previous === undefined || current === undefined) continue;
      expect(previous.y + previous.height).toBe(current.y);
    }
    expect(layout.regions.queued_input).toBeUndefined();
  });

  test("registry bounds match the zone declaration", () => {
    expect(ZONE_REGISTRY.queued_input.min).toBe(0);
    expect(ZONE_REGISTRY.queued_input.max).toBe(1);
    expect(ZONE_REGISTRY.queued_input.alwaysOn).toBe(false);
  });
});
