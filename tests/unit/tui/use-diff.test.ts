import { test, expect } from "bun:test";
import { shouldRefreshDiff } from "../../../src/tui/hooks/use-diff.js";

test("shouldRefreshDiff: refreshes when active and enough time has elapsed", () => {
  expect(shouldRefreshDiff({ active: true, lastRefreshAt: 0, nowMs: 4000, intervalMs: 3000 })).toBe(true);
});

test("shouldRefreshDiff: does not refresh when interval has not elapsed", () => {
  expect(shouldRefreshDiff({ active: true, lastRefreshAt: 3000, nowMs: 4000, intervalMs: 3000 })).toBe(false);
});

test("shouldRefreshDiff: does not refresh when panel is not active", () => {
  expect(shouldRefreshDiff({ active: false, lastRefreshAt: 0, nowMs: 10000, intervalMs: 3000 })).toBe(false);
});

test("shouldRefreshDiff: refreshes immediately when lastRefreshAt is null (never refreshed)", () => {
  expect(shouldRefreshDiff({ active: true, lastRefreshAt: null, nowMs: 0, intervalMs: 3000 })).toBe(true);
});

test("shouldRefreshDiff: boundary — exactly at interval is a refresh", () => {
  expect(shouldRefreshDiff({ active: true, lastRefreshAt: 0, nowMs: 3000, intervalMs: 3000 })).toBe(true);
});
