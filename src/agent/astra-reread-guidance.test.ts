import { describe, expect, test } from "bun:test";
import { ASTRA_PROMPT_RESIDUAL } from "./model-family-policy.js";

// CL-9921: the astra residual permits necessary re-reads while still
// discouraging redundant unchanged re-read loops. Each test names the
// scripted scenario the wording must allow (or, for the negative
// control, keep forbidding).
describe("astra necessary-reread guidance (CL-9921)", () => {
  test("changed-file scenario: re-reading content that changed since the last read is permitted", () => {
    expect(ASTRA_PROMPT_RESIDUAL).toContain("changed since");
  });

  test("paginated-report scenario: reading unread pages is permitted", () => {
    expect(ASTRA_PROMPT_RESIDUAL).toContain("unread pages");
  });

  test("compacted-evidence scenario: targeted re-reads that resolve uncertainty or recover compaction-lost evidence are permitted, with a stated reason and bounded scope", () => {
    expect(ASTRA_PROMPT_RESIDUAL).toContain("uncertainty");
    expect(ASTRA_PROMPT_RESIDUAL).toContain("compaction");
    expect(ASTRA_PROMPT_RESIDUAL).toContain("reason and bounded scope");
  });

  test("unchanged-repetition negative control: unchanged full-file re-read loops stay discouraged, the absolute ban is gone, and the boundary is stated", () => {
    expect(ASTRA_PROMPT_RESIDUAL).toContain("full-file re-read");
    expect(ASTRA_PROMPT_RESIDUAL).toContain("Boundary");
    expect(ASTRA_PROMPT_RESIDUAL).not.toContain(
      "Never re-read a file you have already read",
    );
  });
});
