import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

describe("matchesWritePathAllowlist with a symlinked cwd", () => {
  test("allows a write under the canonical target of a symlinked cwd", () => {
    // Mirrors macOS's /tmp -> /private/tmp: cwd is spelled via the symlink,
    // but resolveWorkspacePath (and any tool arg it rewrites) hands the
    // subject in already realpathed. Both sides of the compare must
    // canonicalize the same way or a legitimate write is hard-denied.
    const real = mkdtempSync(join(realpathSync(tmpdir()), "write-path-real-"));
    const linkDir = join(realpathSync(tmpdir()), `write-path-link-${process.pid}`);
    try {
      symlinkSync(real, linkDir);
      const symlinkedCwd = linkDir; // lexically distinct from `real`
      const canonicalSubject = join(real, "docs", "a.md"); // already realpathed

      expect(
        matchesWritePathAllowlist(canonicalSubject, ["docs/*"], symlinkedCwd),
      ).toBe(true);

      // A genuinely outside path is still denied.
      const outsideReal = mkdtempSync(join(realpathSync(tmpdir()), "write-path-outside-"));
      try {
        expect(
          matchesWritePathAllowlist(join(outsideReal, "docs", "a.md"), ["docs/*"], symlinkedCwd),
        ).toBe(false);
      } finally {
        rmSync(outsideReal, { recursive: true, force: true });
      }
    } finally {
      rmSync(linkDir, { force: true });
      rmSync(real, { recursive: true, force: true });
    }
  });
});

describe("matchesWritePathAllowlist with an unresolvable cwd", () => {
  test("a cwd whose final component is a dangling symlink is hard-denied, not spuriously allowed (CL-6715)", () => {
    // If cwd itself is unresolvable, both absCwd and abs collapse to the same
    // UNRESOLVABLE sentinel, `abs === absCwd` goes true, rel becomes ".", and
    // a root-matching pattern (e.g. "**") would otherwise spuriously allow —
    // turning a hard authz deny into an ask-prompt.
    const parent = mkdtempSync(join(realpathSync(tmpdir()), "write-path-dangling-parent-"));
    const danglingCwd = join(parent, "dangling-cwd");
    try {
      symlinkSync(join(parent, "does-not-exist"), danglingCwd);

      expect(matchesWritePathAllowlist("anything.md", ["**"], danglingCwd)).toBe(false);
      expect(matchesWritePathAllowlist("PRODUCT.md", ["PRODUCT.md"], danglingCwd)).toBe(false);
    } finally {
      rmSync(danglingCwd, { force: true });
      rmSync(parent, { recursive: true, force: true });
    }
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
