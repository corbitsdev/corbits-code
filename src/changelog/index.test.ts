import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  compareVersions,
  decideStartupChangelog,
  formatStartupChangelog,
  getNewEntries,
  parseChangelog,
  parseChangelogText,
  parseVersionString,
  resolveChangelogPath,
  stampVersionAfterStartup,
} from "./index.js";

const SAMPLE = `# Changelog

## [Unreleased]

### New Features
- not a release

## [0.2.86] - 2026-07-30

### New Features
- Feature A

## [0.2.85] - 2026-07-20

### Fixed
- Bug B

## [0.1.0] - 2026-01-01

### New Features
- Initial
`;

describe("parseChangelogText", () => {
  test("parses versioned sections and skips Unreleased", () => {
    const entries = parseChangelogText(SAMPLE);
    expect(entries.map((e) => `${e.major}.${e.minor}.${e.patch}`)).toEqual([
      "0.2.86",
      "0.2.85",
      "0.1.0",
    ]);
    expect(entries[0]!.content).toContain("## [0.2.86]");
    expect(entries[0]!.content).toContain("Feature A");
    expect(entries.every((e) => !e.content.includes("Unreleased"))).toBe(true);
  });

  test("accepts unbracketed version headers", () => {
    const entries = parseChangelogText("## 1.2.3\n\n- note\n");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.major).toBe(1);
    expect(entries[0]!.minor).toBe(2);
    expect(entries[0]!.patch).toBe(3);
  });
});

describe("compareVersions / getNewEntries", () => {
  test("orders major.minor.patch", () => {
    const a = parseVersionString("0.2.86")!;
    const b = parseVersionString("0.2.85")!;
    expect(compareVersions(a, b)).toBeGreaterThan(0);
    expect(compareVersions(b, a)).toBeLessThan(0);
    expect(compareVersions(a, a)).toBe(0);
  });

  test("returns only newer entries", () => {
    const entries = parseChangelogText(SAMPLE);
    const newer = getNewEntries(entries, "0.2.85");
    expect(newer.map((e) => `${e.major}.${e.minor}.${e.patch}`)).toEqual(["0.2.86"]);
  });
});

describe("decideStartupChangelog", () => {
  const entries = parseChangelogText(SAMPLE);

  test("missing watermark is first install — stamp, no history", () => {
    const d = decideStartupChangelog({
      entries,
      lastChangelogVersion: undefined,
      packageVersion: "0.2.86",
    });
    expect(d).toEqual({ kind: "first_install", stampVersion: "0.2.86" });
  });

  test("malformed watermark is first install", () => {
    const d = decideStartupChangelog({
      entries,
      lastChangelogVersion: "not-a-version",
      packageVersion: "0.2.86",
    });
    expect(d.kind).toBe("first_install");
  });

  test("upgrade yields notes with stampVersion for when shown", () => {
    const d = decideStartupChangelog({
      entries,
      lastChangelogVersion: "0.2.85",
      packageVersion: "0.2.86",
    });
    expect(d.kind).toBe("upgrade");
    if (d.kind === "upgrade") {
      expect(d.markdown).toContain("0.2.86");
      expect(d.markdown).toContain("Feature A");
      expect(d.markdown).not.toContain("0.1.0");
      expect(d.stampVersion).toBe("0.2.86");
      expect(d.versions).toContain("0.2.86");
    }
  });

  test("current version is quiet", () => {
    const d = decideStartupChangelog({
      entries,
      lastChangelogVersion: "0.2.86",
      packageVersion: "0.2.86",
    });
    expect(d).toEqual({ kind: "current" });
  });
});

describe("stampVersionAfterStartup", () => {
  const entries = parseChangelogText(SAMPLE);

  test("first_install always stamps (quiet, no history dump)", () => {
    const d = decideStartupChangelog({
      entries,
      lastChangelogVersion: undefined,
      packageVersion: "0.2.86",
    });
    expect(stampVersionAfterStartup(d, false)).toBe("0.2.86");
    expect(stampVersionAfterStartup(d, true)).toBe("0.2.86");
  });

  test("upgrade stamps only when notes were shown (CL-5475)", () => {
    const d = decideStartupChangelog({
      entries,
      lastChangelogVersion: "0.2.85",
      packageVersion: "0.2.86",
    });
    expect(d.kind).toBe("upgrade");
    // Dead surface / OpenTUI gap: do not consume notes without display.
    expect(stampVersionAfterStartup(d, false)).toBeNull();
    // When a surface restores and actually shows markdown, stamp.
    expect(stampVersionAfterStartup(d, true)).toBe("0.2.86");
  });

  test("current never stamps", () => {
    const d = decideStartupChangelog({
      entries,
      lastChangelogVersion: "0.2.86",
      packageVersion: "0.2.86",
    });
    expect(stampVersionAfterStartup(d, false)).toBeNull();
    expect(stampVersionAfterStartup(d, true)).toBeNull();
  });
});

describe("formatStartupChangelog", () => {
  test("caps entry count and marks truncated", () => {
    const entries = parseChangelogText(SAMPLE);
    const formatted = formatStartupChangelog(entries, { maxEntries: 1 });
    expect(formatted.versions).toEqual(["0.2.86"]);
    expect(formatted.truncated).toBe(true);
    expect(formatted.markdown).toContain("/changelog");
  });

  test("caps byte size", () => {
    const big = parseChangelogText(
      `## [9.0.0]\n\n${"x".repeat(200)}\n\n## [8.0.0]\n\n${"y".repeat(200)}\n`,
    );
    const formatted = formatStartupChangelog(big, { maxEntries: 5, maxBytes: 120 });
    expect(Buffer.byteLength(formatted.markdown, "utf8")).toBeLessThanOrEqual(120);
    expect(formatted.truncated).toBe(true);
  });
});

describe("parseChangelog file + resolveChangelogPath", () => {
  test("missing file yields empty", () => {
    expect(parseChangelog("/no/such/CHANGELOG.md")).toEqual([]);
  });

  test("reads a real file; resolve prefers package then cwd", () => {
    const dir = mkdtempSync(join(tmpdir(), "corbits-changelog-"));
    const path = join(dir, "CHANGELOG.md");
    writeFileSync(path, SAMPLE, "utf8");
    expect(parseChangelog(path)).toHaveLength(3);
    // Package-root candidates win when the worktree has CHANGELOG.md; when they
    // do not exist, cwd is used.
    const resolved = resolveChangelogPath({
      cwd: dir,
      execPath: "/nonexistent/bin/corbits",
      moduleUrl: `file://${join(dir, "src", "changelog", "index.ts")}`,
    });
    expect(resolved).toBe(path);
  });
});
