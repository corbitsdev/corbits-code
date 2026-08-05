import { describe, expect, test } from "bun:test";
import { Box } from "ink";
import { render } from "ink-testing-library";

import { GoalView } from "../../../src/tui/components/goal-view.js";
import type { GoalSnapshot } from "../../../src/agent/goal.js";

function snap(over: Partial<GoalSnapshot> = {}): GoalSnapshot {
  return {
    status: "active",
    phase: "planning",
    condition: "ship it",
    brief: "ship it",
    criteria: [],
    turnsUsed: 0,
    turnBudget: 0,
    startedAt: Date.now(),
    mainTokens: 0,
    evalTokens: 0,
    consecutiveEvalFailures: 0,
    consecutiveEmptyYields: 0,
    ...over,
  };
}

describe("GoalView", () => {
  test("compact strip shows phase trail and brief", () => {
    const frame =
      render(
        <GoalView
          goal={snap({
            phase: "implementing",
            brief: "Fix goal mode layout overflow",
          })}
          compact
        />,
      ).lastFrame() ?? "";

    expect(frame).toContain("Goal");
    expect(frame).toContain("impl");
    expect(frame).toContain("Fix goal mode layout overflow");
  });

  test("long brief truncates inside a narrow container", () => {
    const brief =
      "A very long goal brief that would previously wrap into the Work checklist and footer chrome causing unreadable collisions on both full-width and split panes";
    const frame =
      render(
        <Box width={40}>
          <GoalView goal={snap({ brief, condition: brief })} compact />
        </Box>,
      ).lastFrame() ?? "";

    expect(frame).toContain("Goal");
    const lines = frame.split("\n");
    for (const line of lines) {
      // paddingX=1 eats 2 cols; allow a small slack for ink measurement
      expect(line.length).toBeLessThanOrEqual(42);
    }
    // Full brief should not appear as a single unbroken line longer than width.
    expect(frame.includes(brief)).toBe(false);
  });

  test("acceptance criteria keep glyph and title separated under width pressure", () => {
    const frame =
      render(
        <Box width={40}>
          <GoalView
            goal={snap({
              phase: "reviewing",
              criteria: [
                {
                  id: "c1",
                  title: "Active acceptance criterion with a very long title that must truncate",
                  status: "doing",
                },
                { id: "c2", title: "Done item", status: "done" },
              ],
            })}
          />
        </Box>,
      ).lastFrame() ?? "";

    expect(frame).toContain("Acceptance");
    expect(frame).toContain("●");
    expect(frame).toMatch(/●\s/);
    expect(frame).not.toMatch(/Acceptance[a-z]/);
  });

  test("phase trail remains readable (current phase visible)", () => {
    const frame =
      render(
        <GoalView goal={snap({ phase: "reviewing", brief: "review work" })} compact />,
      ).lastFrame() ?? "";

    expect(frame).toContain("review");
  });
});
