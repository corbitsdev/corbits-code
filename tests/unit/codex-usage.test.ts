import { test, expect, describe } from "bun:test";
import { formatCodexUsage, type CodexUsage } from "../../src/auth/codex/usage.js";

describe("formatCodexUsage", () => {
  test("renders both windows with percent and reset, no dollar figures", () => {
    const usage: CodexUsage = {
      planType: "team",
      allowed: true,
      limitReached: false,
      primary: { usedPercent: 42, windowSeconds: 18000, resetAfterSeconds: 3600, resetAt: 0 },
      secondary: { usedPercent: 74, windowSeconds: 604800, resetAfterSeconds: 266511, resetAt: 0 },
      hasCredits: true,
    };
    const out = formatCodexUsage(usage);
    expect(out).toContain("Codex (team) — active");
    expect(out).toContain("5-hour: 42% used · resets in 1h 0m");
    expect(out).toContain("weekly: 74% used · resets in 3d 2h");
    expect(out).not.toContain("$");
  });

  test("surfaces the blocked reason when the limit is reached", () => {
    const usage: CodexUsage = {
      planType: "team",
      allowed: false,
      limitReached: true,
      primary: { usedPercent: 100, windowSeconds: 18000, resetAfterSeconds: 562, resetAt: 0 },
      hasCredits: false,
      reachedType: "workspace_member_credits_depleted",
    };
    const out = formatCodexUsage(usage);
    expect(out).toContain("limit reached");
    expect(out).toContain("5-hour: 100% used · resets in 9m");
    expect(out).toContain("blocked: workspace member credits depleted");
  });

  test("omits windows that are absent", () => {
    const usage: CodexUsage = { planType: "pro", allowed: true, limitReached: false, hasCredits: true };
    expect(formatCodexUsage(usage)).toBe("Codex (pro) — active");
  });
});
