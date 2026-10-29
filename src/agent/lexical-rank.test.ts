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

describe("scoreLexical tool names across a trailing plural s", () => {
  // No fixture name contains this raw query whole, so only the per-token
  // tiers differ between the scores compared.
  const rawQuery = "linear issue";

  function nameScore(name: string, query: string): number {
    return scoreLexical(
      lexicalFields(name, "", NO_LEXICAL_PARAMS),
      tokenizeLexical(query),
      rawQuery,
    );
  }

  // `substring` holds the query word only inside a longer name token.
  function expectFoldedBetween(
    query: string,
    names: { substring: string; folded: string; exact: string },
  ) {
    const folded = nameScore(names.folded, query);
    expect(folded).toBeGreaterThan(nameScore(names.substring, query));
    expect(folded).toBeLessThan(nameScore(names.exact, query));
  }

  test("a singular query word matches its plural in a name", () => {
    expectFoldedBetween("issue", {
      substring: "mcp__acme__issuetracker",
      folded: "mcp__linear__list_issues",
      exact: "mcp__linear__list_issue",
    });
  });

  test("a plural query word matches its singular in a name", () => {
    expectFoldedBetween("issues", {
      substring: "mcp__acme__issuestracker",
      folded: "mcp__linear__get_issue",
      exact: "mcp__linear__get_issues",
    });
  });

  test("a word given in both forms counts once, as its better spelling", () => {
    const fields = lexicalFields(
      "mcp__linear__list_issues",
      "List issues in Linear",
      NO_LEXICAL_PARAMS,
    );
    expect(
      scoreLexical(fields, tokenizeLexical("linear issue issues"), rawQuery),
    ).toBe(scoreLexical(fields, tokenizeLexical("linear issues"), rawQuery));
  });

  test("a word given in both forms scores the same in either order", () => {
    // "issue" sits only inside "issuetracker", so only a substring tier
    // matches, and it matches the singular but not the plural.
    const fields = lexicalFields(
      "mcp__acme__issuetracker",
      "",
      NO_LEXICAL_PARAMS,
    );
    const pluralFirst = scoreLexical(
      fields,
      tokenizeLexical("issues issue"),
      rawQuery,
    );
    expect(pluralFirst).toBeGreaterThan(0);
    expect(pluralFirst).toBe(
      scoreLexical(fields, tokenizeLexical("issue issues"), rawQuery),
    );
  });

  test("a word of three letters keeps its trailing s", () => {
    const fields = lexicalFields("mcp__acme__get_it", "", NO_LEXICAL_PARAMS);
    expect(scoreLexical(fields, tokenizeLexical("its"), "its")).toBe(0);
  });

  test("a plural query word earns no substring credit for its singular", () => {
    // "users" folds to "user", which sits inside "username"; the substring
    // tier still looks for "users".
    const fields = lexicalFields(
      "mcp__acme__username_lookup",
      "",
      NO_LEXICAL_PARAMS,
    );
    expect(scoreLexical(fields, tokenizeLexical("users"), "users")).toBe(0);
  });

  test("a description word does not match a query word that folds to it", () => {
    const fields = lexicalFields(
      "mcp__linear__save_issue",
      "Create a new issue",
      NO_LEXICAL_PARAMS,
    );
    expect(scoreLexical(fields, tokenizeLexical("news"), "news")).toBe(0);
  });
});
