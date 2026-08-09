import { describe, expect, test } from "bun:test"

import {
  filterMentionSuggestions,
  splitMentionToken,
} from "./mention-filter"

describe("splitMentionToken", () => {
  test("bare fragment lists the working directory", () => {
    expect(splitMentionToken("ses")).toEqual({ dir: "", fragment: "ses" })
  })

  test("keeps the directory portion with its trailing slash", () => {
    expect(splitMentionToken("src/tui/ses")).toEqual({
      dir: "src/tui/",
      fragment: "ses",
    })
  })

  test("a token ending in a slash has no fragment to narrow on", () => {
    expect(splitMentionToken("src/")).toEqual({ dir: "src/", fragment: "" })
  })
})

describe("filterMentionSuggestions", () => {
  const ENTRIES = ["session.ts", "src/", "parse-session.ts", "README.md"]

  test("empty fragment keeps every suggestion in source order", () => {
    expect(filterMentionSuggestions(ENTRIES, "")).toEqual(ENTRIES)
  })

  test("matches anywhere in the entry name, prefix hits first", () => {
    expect(filterMentionSuggestions(ENTRIES, "ses")).toEqual([
      "session.ts",
      "parse-session.ts",
    ])
  })

  test("is case-insensitive", () => {
    expect(filterMentionSuggestions(ENTRIES, "READ")).toEqual(["README.md"])
    expect(filterMentionSuggestions(ENTRIES, "readme")).toEqual(["README.md"])
  })

  test("matches the entry name, not the directory it sits in", () => {
    expect(
      filterMentionSuggestions(["session/notes.md", "session/log.md"], "log"),
    ).toEqual(["session/log.md"])
  })

  test("directory entries keep their trailing slash", () => {
    expect(filterMentionSuggestions(["src/tui-opentui/"], "opentui")).toEqual([
      "src/tui-opentui/",
    ])
  })
})
