import { test, expect, describe } from "bun:test";
import {
  formatCodexUsage,
  formatCodexUsageCompact,
  parseCodexRateLimitHeaders,
  type CodexUsage,
} from "../../src/auth/codex/usage.js";

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

describe("formatCodexUsageCompact", () => {
  test("renders a one-line status-bar form", () => {
    const usage: CodexUsage = {
      planType: "team",
      allowed: true,
      limitReached: false,
      primary: { usedPercent: 42, windowSeconds: 18000, resetAfterSeconds: 0, resetAt: 0 },
      secondary: { usedPercent: 74, windowSeconds: 604800, resetAfterSeconds: 0, resetAt: 0 },
      hasCredits: true,
    };
    expect(formatCodexUsageCompact(usage)).toBe("Codex 5h 42% · wk 74%");
  });

  test("derives the window label from the actual duration", () => {
    const usage: CodexUsage = {
      planType: "team",
      allowed: true,
      limitReached: false,
      primary: { usedPercent: 10, windowSeconds: 10800, resetAfterSeconds: 0, resetAt: 0 },
      secondary: { usedPercent: 5, windowSeconds: 86400, resetAfterSeconds: 0, resetAt: 0 },
      hasCredits: true,
    };
    expect(formatCodexUsageCompact(usage)).toBe("Codex 3h 10% · 1d 5%");
  });

  test("falls back to default labels when the window duration is missing", () => {
    const usage: CodexUsage = {
      planType: "team",
      allowed: true,
      limitReached: false,
      primary: { usedPercent: 10, windowSeconds: 0, resetAfterSeconds: 0, resetAt: 0 },
      secondary: { usedPercent: 5, windowSeconds: 0, resetAfterSeconds: 0, resetAt: 0 },
      hasCredits: true,
    };
    expect(formatCodexUsageCompact(usage)).toBe("Codex 5h 10% · wk 5%");
  });

  test("marks the limit-reached state", () => {
    const usage: CodexUsage = {
      planType: "team",
      allowed: false,
      limitReached: true,
      primary: { usedPercent: 100, windowSeconds: 18000, resetAfterSeconds: 0, resetAt: 0 },
      hasCredits: false,
    };
    expect(formatCodexUsageCompact(usage)).toBe("Codex 5h 100% · (limit reached)");
  });
});

describe("parseCodexRateLimitHeaders", () => {
  test("parses x-codex-* headers into the usage shape", () => {
    const now = 1_000_000_000_000; // fixed ms
    const nowSec = Math.floor(now / 1000);
    const headers = new Headers({
      "x-codex-primary-used-percent": "55",
      "x-codex-primary-window-minutes": "300",
      "x-codex-primary-reset-at": String(nowSec + 600),
      "x-codex-secondary-used-percent": "74",
      "x-codex-secondary-window-minutes": "10080",
      "x-codex-secondary-reset-at": String(nowSec + 86400),
    });
    const usage = parseCodexRateLimitHeaders(headers, now);
    expect(usage?.primary).toEqual({ usedPercent: 55, windowSeconds: 18000, resetAfterSeconds: 600, resetAt: nowSec + 600 });
    expect(usage?.secondary?.usedPercent).toBe(74);
    expect(usage?.allowed).toBe(true);
  });

  test("flags limit reached from the reached-type header", () => {
    const headers = new Headers({
      "x-codex-primary-used-percent": "100",
      "x-codex-rate-limit-reached-type": "workspace_member_credits_depleted",
    });
    const usage = parseCodexRateLimitHeaders(headers, 0);
    expect(usage?.allowed).toBe(false);
    expect(usage?.reachedType).toBe("workspace_member_credits_depleted");
  });

  test("returns undefined when the rate-limit headers are absent", () => {
    expect(parseCodexRateLimitHeaders(new Headers({ "content-type": "text/event-stream" }), 0)).toBeUndefined();
  });
});
