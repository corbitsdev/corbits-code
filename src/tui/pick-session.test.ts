import { describe, test, expect } from "bun:test";
import { isResumableByDefault } from "./pick-session.js";

describe("isResumableByDefault", () => {
  test("in-progress sessions are resumable", () => {
    expect(isResumableByDefault({ status: "running" })).toBe(true);
  });

  test("interrupted sessions are resumable without --force", () => {
    expect(isResumableByDefault({ status: "cancelled" })).toBe(true);
  });

  test("completed and failed sessions need --force", () => {
    expect(isResumableByDefault({ status: "done" })).toBe(false);
    expect(isResumableByDefault({ status: "failed" })).toBe(false);
  });
});
