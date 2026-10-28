import { describe, expect, test } from "bun:test";

import { liveLinearCatalog } from "../../testkit/linear-mcp-catalog.js";
import { createToolIndex } from "./tool-search.js";

const index = createToolIndex(() => liveLinearCatalog);

// Queries models sent while looking for a release's issues, at the limit
// each one used; every one should shortlist list_issues.
describe("tool_search on logged Linear issue queries", () => {
  test.each([
    [
      "Get a Linear release by URL or identifier and list its issues including titles, status, and descriptions",
      10,
    ],
    ["Linear retrieve pipeline release issue list and issue details", 5],
    ["Linear list issues filtered by release ID or release slug", 5],
    ["issue list", 5],
  ] as const)("%p (limit %p) shortlists list_issues", (query, limit) => {
    expect(index.search(query, limit)).toContain("mcp__linear__list_issues");
  });

  // Shortlisted only while "issue" and "issues" counted as two words; the
  // query splits between release and issue tools, and release tools match more
  // of its words.
  test.failing(
    '"Linear read pipeline release issues and issue details" (limit 5) shortlists list_issues',
    () => {
      expect(
        index.search(
          "Linear read pipeline release issues and issue details",
          5,
        ),
      ).toContain("mcp__linear__list_issues");
    },
  );
});
