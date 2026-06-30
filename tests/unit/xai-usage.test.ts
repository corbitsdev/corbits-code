import { test, expect, describe } from "bun:test";
import {
  formatXaiUsage,
  formatXaiUsageCompact,
  type XaiUsage,
} from "../../src/auth/xai/usage.js";

describe("formatXaiUsage", () => {
  test("renders tier and credit percent, no dollar figures", () => {
    const usage: XaiUsage = {
      subscriptionTier: "pro",
      creditUsagePercent: 23,
      monthlyLimit: 1000,
      includedUsed: 230,
    };
    const out = formatXaiUsage(usage);
    expect(out).toContain("Grok (pro)");
    expect(out).toContain("credit: 23% used");
    expect(out).toContain("monthly: 230/1000");
    expect(out).not.toContain("$");
  });

  test("includes on-demand when present", () => {
    const usage: XaiUsage = {
      subscriptionTier: "pro",
      creditUsagePercent: 5,
      onDemandUsed: 12,
      onDemandCap: 100,
    };
    const out = formatXaiUsage(usage);
    expect(out).toContain("on-demand: 12/100");
  });

  test("omits optional fields when absent", () => {
    const usage: XaiUsage = { subscriptionTier: "free", creditUsagePercent: 0 };
    expect(formatXaiUsage(usage)).toBe("Grok (free)\ncredit: 0% used");
  });
});

describe("formatXaiUsageCompact", () => {
  test("renders a one-line status-bar form", () => {
    const usage: XaiUsage = { subscriptionTier: "pro", creditUsagePercent: 23 };
    expect(formatXaiUsageCompact(usage)).toBe("Grok pro 23%");
  });

  test("falls back for unknown tier", () => {
    const usage: XaiUsage = { subscriptionTier: "unknown", creditUsagePercent: 7 };
    expect(formatXaiUsageCompact(usage)).toBe("Grok 7%");
  });
});
