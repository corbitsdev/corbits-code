import { describe, expect, test } from "bun:test";

import {
  formatArchiveRef,
  isArchiveLike,
  parseArchiveRef,
  parseArchiveTarget,
} from "./archive-uri.js";

describe("archive URI", () => {
  test("formats and parses archive:/// occurrence refs", () => {
    expect(formatArchiveRef("occ-abc")).toBe("archive:///occ-abc");
    expect(parseArchiveRef("archive:///occ-abc")).toBe("occ-abc");
    expect(parseArchiveRef("archive:/occ-abc")).toBe("occ-abc");
    expect(parseArchiveRef("archive:///occ-abc?x=1")).toBe("occ-abc");
    expect(parseArchiveRef("occ-abc")).toBeUndefined();
    expect(parseArchiveRef("archive:///")).toBeUndefined();
    expect(parseArchiveRef("/tmp/evidence-archive/index.jsonl")).toBeUndefined();
  });

  test("treats archive:/// as the virtual search root", () => {
    expect(isArchiveLike("archive:///")).toBe(true);
    expect(isArchiveLike("archive:///occ-abc")).toBe(true);
    expect(isArchiveLike("evidence-archive/index.jsonl")).toBe(false);
    expect(parseArchiveTarget("archive:///")).toEqual({});
    expect(parseArchiveTarget("archive:/")).toEqual({});
    expect(parseArchiveTarget("archive:///occ-abc")).toEqual({ occurrenceId: "occ-abc" });
    expect(parseArchiveTarget("src/foo.ts")).toBeUndefined();
  });
});
