import { describe, expect, test } from "bun:test";

import {
  lexicalFields,
  scoreLexical,
  tokenizeLexical,
} from "./lexical-rank.js";

describe("scoreLexical", () => {
  test("counts a word repeated in the query once", () => {
    const fields = lexicalFields(
      "mcp__linear__list_release_notes",
      "List release notes in the workspace",
    );
    // Same raw query on both sides so only the token list differs; the raw
    // query feeds a separate whole-query substring bonus.
    const rawQuery = "release notes release";
    expect(
      scoreLexical(fields, tokenizeLexical("release notes release"), rawQuery),
    ).toBe(scoreLexical(fields, tokenizeLexical("release notes"), rawQuery));
  });
});
