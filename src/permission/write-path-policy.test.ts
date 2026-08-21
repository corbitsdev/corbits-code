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

  test("path traversal cannot escape a glob (subject never matched raw)", () => {
    // `docs/../src/hack.ts` resolves under src/, not docs/ — must NOT match
    // `docs/*` even though the raw subject string starts with `docs/`.
    expect(matchesWritePathAllowlist("docs/../src/hack.ts", ["docs/*"], cwd)).toBe(false);
    expect(matchesWritePathAllowlist("docs/../src/hack.ts", ["docs/**"], cwd)).toBe(false);
    // Same escape via a bare-name allowlist.
    expect(matchesWritePathAllowlist("PRODUCT.md/../src/hack.ts", ["PRODUCT.md"], cwd)).toBe(false);
    // A legitimately nested docs file still matches.
    expect(matchesWritePathAllowlist("docs/a/b.md", ["docs/**"], cwd)).toBe(true);
  });

  test("absolute paths outside cwd are hard-denied even if basename matches", () => {
    // Outside root: /tmp/evil/PRODUCT.md is not under cwd, so PRODUCT.md must
    // not match — no fallthrough to pattern match on the outside path.
    const outside = resolve("/tmp/write-path-policy-elsewhere", "PRODUCT.md");
    expect(outside).not.toBe(resolve(cwd, "PRODUCT.md"));
    expect(matchesWritePathAllowlist(outside, ["PRODUCT.md"], cwd)).toBe(false);
    expect(matchesWritePathAllowlist(outside, ["**/PRODUCT.md"], cwd)).toBe(false);
    // A sibling of cwd (shared /tmp parent) still denied.
    expect(
      matchesWritePathAllowlist("../sibling/PRODUCT.md", ["PRODUCT.md"], cwd),
    ).toBe(false);
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
