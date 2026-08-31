import { describe, test, expect } from "bun:test";

import { sessionResumeLabel } from "./pick-session.js";
import type { SessionSummary } from "../session/index.js";

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: "00000000-0000-7000-8000-000000000000",
    task: "Ship picker",
    startedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    status: "done",
    ...overrides,
  };
}

describe("sessionResumeLabel", () => {
  test("uses updatedAt for relative age, not startedAt", () => {
    const now = Date.now();
    const label = sessionResumeLabel(
      summary({
        startedAt: now - 48 * 60 * 60 * 1000,
        updatedAt: now - 5 * 60 * 1000,
        status: "done",
      }),
    );
    expect(label).toBe("Ship picker · 5m ago · done");
  });

  test("includes completed and crashed statuses in the row", () => {
    expect(sessionResumeLabel(summary({ status: "failed" }))).toContain("failed");
    expect(sessionResumeLabel(summary({ status: "crashed" }))).toContain("crashed");
  });

  test("falls back to Untitled session when the task is blank", () => {
    const label = sessionResumeLabel(summary({ task: "   " }));
    expect(label.startsWith("Untitled session ·")).toBe(true);
  });
});
