import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  matchesWritePathAllowlist,
  writePathDeniedReason,
} from "./write-path-policy.js";

const cwd = resolve("/tmp/write-path-policy-fixture");

describe("matchesWritePathAllowlist", () => {
  test("bare filename matches only the workspace-root file", () => {
    expect(matchesWritePathAllowlist("PRODUCT.md", ["PRODUCT.md"], cwd)).toBe(true);
    // Nested file of the same basename does NOT match a bare pattern.
    expect(matchesWritePathAllowlist("docs/PRODUCT.md", ["PRODUCT.md"], cwd)).toBe(false);
    expect(matchesWritePathAllowlist("vendor/x/PRODUCT.md", ["PRODUCT.md"], cwd)).toBe(false);
    // An explicit glob reaches nested files of that name.
    expect(matchesWritePathAllowlist("docs/PRODUCT.md", ["**/PRODUCT.md"], cwd)).toBe(true);
    expect(matchesWritePathAllowlist("src/foo.ts", ["PRODUCT.md"], cwd)).toBe(false);
  });

  test("relative globs match workspace-relative paths", () => {
    expect(matchesWritePathAllowlist("docs/a.md", ["docs/*"], cwd)).toBe(true);
    expect(matchesWritePathAllowlist("src/a.md", ["docs/*"], cwd)).toBe(false);
  });

  test("empty allowlist or empty subject denies", () => {
    expect(matchesWritePathAllowlist("PRODUCT.md", [], cwd)).toBe(false);
    expect(matchesWritePathAllowlist("", ["PRODUCT.md"], cwd)).toBe(false);
  });

  test("absolute paths under cwd still match bare basename", () => {
    const abs = resolve(cwd, "DESIGN.md");
    expect(matchesWritePathAllowlist(abs, ["DESIGN.md"], cwd)).toBe(true);
  });
});

describe("writePathDeniedReason", () => {
  test("names allowlist and subject", () => {
    const reason = writePathDeniedReason("src/x.ts", ["PRODUCT.md", "docs/*"]);
    expect(reason).toContain("PRODUCT.md");
    expect(reason).toContain("docs/*");
    expect(reason).toContain("src/x.ts");
    expect(reason).toMatch(/authz/i);
  });
});
