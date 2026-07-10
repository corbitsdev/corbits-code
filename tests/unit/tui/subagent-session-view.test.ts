import { describe, expect, test } from "bun:test";

import { subAgentScrollWindow } from "../../../src/tui/components/subagent-session-view.js";

describe("subAgentScrollWindow", () => {
  test("pins to the newest rows at max offset", () => {
    // 10 lines, viewport 4 (visibleRows 7 minus the 3 header rows).
    const { start, viewport, maxOffset } = subAgentScrollWindow(10, 7, 6);
    expect(viewport).toBe(4);
    expect(maxOffset).toBe(6);
    expect(start).toBe(6);
  });

  test("an earlier offset scrolls back through the transcript", () => {
    const { start } = subAgentScrollWindow(10, 7, 2);
    expect(start).toBe(2);
  });

  test("clamps a negative or overshooting offset into range", () => {
    expect(subAgentScrollWindow(10, 7, -5).start).toBe(0);
    expect(subAgentScrollWindow(10, 7, 999).start).toBe(6);
  });

  test("a transcript shorter than the viewport has no scroll room", () => {
    const { start, maxOffset } = subAgentScrollWindow(2, 7, 3);
    expect(maxOffset).toBe(0);
    expect(start).toBe(0);
  });
});
