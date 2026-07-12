// Smoke test for the CL-3441 repaint-surface harness: confirms the counting
// stream captures real Ink output and that incremental rendering does not
// write more bytes than standard rendering for a growing-text scenario. This
// is a spike measurement harness, not a regression gate — see bench/tui-repaint.ts
// for the numbers this produces and docs/ARCHITECTURE.md for TUI context.

import { describe, expect, test } from "bun:test";

import { runIdleSpinnerScenario, runStreamingTextScenario } from "./tui-repaint.js";

describe("tui repaint-surface harness", () => {
  test("idle spinner scenario records bytes and writes across ticks", async () => {
    const result = await runIdleSpinnerScenario(10, false);
    expect(result.samples.length).toBe(9);
    expect(result.totalBytes).toBeGreaterThan(0);
  });

  test("incremental rendering does not exceed standard rendering for growing text", async () => {
    const standard = await runStreamingTextScenario(20, false);
    const incremental = await runStreamingTextScenario(20, true);
    expect(incremental.totalBytes).toBeLessThanOrEqual(standard.totalBytes);
  });
});
