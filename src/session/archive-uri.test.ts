import { describe, expect, test } from "bun:test";

import { formatArchiveRef, parseArchiveRef } from "./archive-uri.js";

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
});
