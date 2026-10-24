import { describe, expect, test } from "bun:test";

import {
  lexicalFields,
  NO_LEXICAL_PARAMS,
  scoreLexical,
  tokenizeLexical,
} from "./lexical-rank.js";

describe("scoreLexical", () => {
  test("counts a word repeated in the query once", () => {
    const fields = lexicalFields(
      "mcp__linear__list_release_notes",
      "List release notes in the workspace",
      NO_LEXICAL_PARAMS,
    );
    // Same raw query on both sides so only the token list differs; the raw
    // query feeds a separate whole-query substring bonus.
    const rawQuery = "release notes release";
    expect(
      scoreLexical(fields, tokenizeLexical("release notes release"), rawQuery),
    ).toBe(scoreLexical(fields, tokenizeLexical("release notes"), rawQuery));
  });

  // Two-word raw query that no fixture contains whole, so the whole-query
  // substring bonus never applies and only the per-token tiers are compared.
  const rawQuery = "release filter";
  const queryTokens = tokenizeLexical(rawQuery);

  test("ranks a name substring above a parameter name above a parameter description", () => {
    // Every fixture matches "filter" in its blob, so the parameter tiers have
    // a direct match to boost.
    const nameSubstring = lexicalFields(
      "mcp__acme__releaselog",
      "Filter logs",
      NO_LEXICAL_PARAMS,
    );
    const paramName = lexicalFields("mcp__acme__records", "Filter records", {
      names: ["release"],
      blob: "",
    });
    const paramDescription = lexicalFields(
      "mcp__acme__records",
      "Filter records",
      {
        names: ["id"],
        blob: "Release ID or slug",
      },
    );
    const scores = [nameSubstring, paramName, paramDescription].map((fields) =>
      scoreLexical(fields, queryTokens, rawQuery),
    );
    expect(scores[0]).toBeGreaterThan(scores[1] ?? 0);
    expect(scores[1]).toBeGreaterThan(scores[2] ?? 0);
    expect(scores[2]).toBeGreaterThan(0);
  });

  test("ranks a parameter name above a description substring of the same word", () => {
    // "release" sits only inside "prereleases", so the description offers
    // just a raw-substring hit.
    const without = lexicalFields(
      "mcp__acme__records",
      "Read prereleases",
      NO_LEXICAL_PARAMS,
    );
    const withParam = lexicalFields("mcp__acme__records", "Read prereleases", {
      names: ["release"],
      blob: "",
    });
    expect(scoreLexical(withParam, queryTokens, rawQuery)).toBeGreaterThan(
      scoreLexical(without, queryTokens, rawQuery),
    );
  });

  test("a parameter match alone scores nothing", () => {
    const fields = lexicalFields("mcp__acme__records", "Read records", {
      names: ["release"],
      blob: "Release ID or slug",
    });
    expect(scoreLexical(fields, queryTokens, rawQuery)).toBe(0);
  });

  test("a parameter match adds nothing to a word already matched by name or description", () => {
    const params = { names: ["release"], blob: "Release ID or slug" };
    for (const [name, blob] of [
      ["mcp__acme__release", "Read logs"],
      ["mcp__acme__records", "Read a release"],
      ["mcp__acme__releaselog", "Read logs"],
    ] as const) {
      expect(
        scoreLexical(lexicalFields(name, blob, params), queryTokens, rawQuery),
      ).toBe(
        scoreLexical(
          lexicalFields(name, blob, NO_LEXICAL_PARAMS),
          queryTokens,
          rawQuery,
        ),
      );
    }
  });
});
