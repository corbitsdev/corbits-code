import { expect, test } from "bun:test";
import type { ArchiveOccurrence } from "./compaction-archive-schema.js";
import { buildArchiveSummaryExcerpt } from "./summary-excerpt.js";

function occ(
  partial: Pick<ArchiveOccurrence, "occurrenceId" | "kind"> &
    Partial<Omit<ArchiveOccurrence, "occurrenceId" | "kind">>,
): ArchiveOccurrence {
  return {
    sessionId: "s1",
    contentHash: "hash",
    blobKey: `blob-${partial.occurrenceId}`,
    recordedAt: 1,
    ...partial,
  };
}

test("empty archive yields an empty excerpt", async () => {
  const excerpt = await buildArchiveSummaryExcerpt({
    listOccurrences: async () => [],
    readAuthorizedPayload: async () => {
      throw new Error("should not read");
    },
  });
  expect(excerpt).toBe("");
});

test("prefers user messages over tool results and keeps the full payload", async () => {
  const userBody = `USER_BODY ${"y".repeat(500)}`;
  const excerpt = await buildArchiveSummaryExcerpt({
    listOccurrences: async () => [
      occ({ occurrenceId: "occ-result", kind: "tool_result", callId: "c1" }),
      occ({ occurrenceId: "occ-user", kind: "user_message" }),
    ],
    readAuthorizedPayload: async (id) => (id === "occ-user" ? userBody : "RESULT_BODY"),
  });
  expect(excerpt.indexOf("USER_BODY")).toBeGreaterThanOrEqual(0);
  expect(excerpt.indexOf("USER_BODY")).toBeLessThan(excerpt.indexOf("RESULT_BODY"));
  expect(excerpt).toContain(userBody);
  expect(excerpt).toContain("archive:///occ-user");
});

test("gap rows contribute metadata only", async () => {
  const excerpt = await buildArchiveSummaryExcerpt({
    listOccurrences: async () => [
      occ({ occurrenceId: "occ-gap", kind: "tool_result", callId: "c9", gap: true }),
    ],
    readAuthorizedPayload: async () => {
      throw new Error("gap rows must not load a payload");
    },
  });
  expect(excerpt).toContain("[gap]");
  expect(excerpt).toContain("(payload not stored)");
  expect(excerpt).toContain("archive:///occ-gap");
});

test("later kinds yield when the budget is already full", async () => {
  const excerpt = await buildArchiveSummaryExcerpt(
    {
      listOccurrences: async () => [
        occ({ occurrenceId: "occ-user", kind: "user_message" }),
        occ({ occurrenceId: "occ-result", kind: "tool_result" }),
      ],
      readAuthorizedPayload: async (id) => (id === "occ-user" ? "USER" : "RESULT"),
    },
    80,
  );
  expect(excerpt).toContain("USER");
  expect(excerpt).not.toContain("RESULT");
});

test("omits an occurrence whose full payload cannot fit, without slicing it", async () => {
  const excerpt = await buildArchiveSummaryExcerpt(
    {
      listOccurrences: async () => [
        occ({ occurrenceId: "occ-big", kind: "user_message" }),
        occ({ occurrenceId: "occ-small", kind: "user_message" }),
      ],
      readAuthorizedPayload: async (id) => (id === "occ-big" ? `BIG${"x".repeat(500)}` : "SMALL"),
    },
    80,
  );
  expect(excerpt).not.toContain("BIG");
  expect(excerpt).not.toContain("xxxxx");
  expect(excerpt).toContain("SMALL");
  expect(excerpt).toContain("archive:///occ-small");
});
