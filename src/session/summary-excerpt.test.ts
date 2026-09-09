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

test("includes attachments after user messages", async () => {
  const excerpt = await buildArchiveSummaryExcerpt({
    listOccurrences: async () => [
      occ({ occurrenceId: "occ-asst", kind: "assistant_text" }),
      occ({ occurrenceId: "occ-att", kind: "attachment" }),
      occ({ occurrenceId: "occ-user", kind: "user_message" }),
    ],
    readAuthorizedPayload: async (id) => {
      if (id === "occ-user") return "USER";
      if (id === "occ-att") return "ATTACH";
      return "ASSISTANT";
    },
  });
  expect(excerpt.indexOf("USER")).toBeGreaterThanOrEqual(0);
  expect(excerpt.indexOf("USER")).toBeLessThan(excerpt.indexOf("ATTACH"));
  expect(excerpt.indexOf("ATTACH")).toBeLessThan(excerpt.indexOf("ASSISTANT"));
});

test("marks over-budget occurrences as omitted instead of dropping them silently", async () => {
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
  expect(excerpt).toMatch(/1 occurrence omitted/);
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
  expect(excerpt).toMatch(/1 occurrence omitted/);
});

test("a readAuthorizedPayload throw omits that occurrence and continues", async () => {
  const excerpt = await buildArchiveSummaryExcerpt({
    listOccurrences: async () => [
      occ({ occurrenceId: "occ-bad", kind: "user_message" }),
      occ({ occurrenceId: "occ-ok", kind: "user_message" }),
    ],
    readAuthorizedPayload: async (id) => {
      if (id === "occ-bad") throw new Error("blob missing");
      return "OK_BODY";
    },
  });
  expect(excerpt).toContain("OK_BODY");
  expect(excerpt).toContain("archive:///occ-ok");
  expect(excerpt).toMatch(/1 occurrence omitted/);
});

test("join separators are not charged against the first section", async () => {
  const excerpt = await buildArchiveSummaryExcerpt(
    {
      listOccurrences: async () => [
        occ({ occurrenceId: "occ-a", kind: "user_message" }),
        occ({ occurrenceId: "occ-b", kind: "user_message" }),
      ],
      readAuthorizedPayload: async (id) => (id === "occ-a" ? "AAAA" : "BB"),
    },
    "### user_message archive:///occ-a\nAAAA\n\n### user_message archive:///occ-b\nBB".length,
  );
  expect(excerpt).toContain("AAAA");
  expect(excerpt).toContain("BB");
  expect(excerpt).not.toMatch(/omitted/);
});
