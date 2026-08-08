import { describe, expect, test } from "bun:test"
import {
  buildPromptRecognitionMatcher,
  resolvePromptHighlightSpans,
  resolvePromptRecognitionMatcher,
  type PromptRecognitionSource,
} from "./prompt-recognition"

describe("buildPromptRecognitionMatcher", () => {
  test("returns null for an empty name set", () => {
    expect(buildPromptRecognitionMatcher([])).toBeNull()
  })

  test("matches a known single-word name as a whole word", () => {
    const matcher = buildPromptRecognitionMatcher(["emil"])
    expect(resolvePromptHighlightSpans("ask emil to review", matcher)).toEqual([
      { start: 4, end: 8 },
    ])
  })

  test("does not match a lookalike that only contains the name", () => {
    const matcher = buildPromptRecognitionMatcher(["emil"])
    expect(resolvePromptHighlightSpans("emily said hi", matcher)).toEqual([])
  })

  test("matches a multi-word skill name as a whole phrase", () => {
    const matcher = buildPromptRecognitionMatcher(["brand review"])
    expect(
      resolvePromptHighlightSpans("ask draper to run a brand review", matcher),
    ).toEqual([{ start: 20, end: 32 }])
  })

  test("longer names win over a shorter name that is their prefix", () => {
    const matcher = buildPromptRecognitionMatcher(["brand", "brand review"])
    const spans = resolvePromptHighlightSpans("run brand review now", matcher)
    expect(spans).toEqual([{ start: 4, end: 16 }])
  })

  test("matches every recognized token in a mixed line", () => {
    const matcher = buildPromptRecognitionMatcher(["emil", "draper", "brand review"])
    const spans = resolvePromptHighlightSpans(
      "ask emil and draper to run a brand review",
      matcher,
    )
    expect(spans).toEqual([
      { start: 4, end: 8 },
      { start: 13, end: 19 },
      { start: 29, end: 41 },
    ])
  })

  test("matching is case-insensitive", () => {
    const matcher = buildPromptRecognitionMatcher(["emil"])
    expect(resolvePromptHighlightSpans("EMIL, please look", matcher)).toEqual([
      { start: 0, end: 4 },
    ])
  })
})

describe("resolvePromptRecognitionMatcher", () => {
  test("caches the matcher while the name set is unchanged", () => {
    const source: PromptRecognitionSource = () => ({
      skillNames: ["brand review"],
      agentNames: ["emil"],
    })
    const first = resolvePromptRecognitionMatcher(source)
    const second = resolvePromptRecognitionMatcher(source)
    expect(second).toBe(first)
  })

  test("rebuilds the matcher when the name set changes", () => {
    let names = ["emil"]
    const source: PromptRecognitionSource = () => ({
      skillNames: [],
      agentNames: names,
    })
    const first = resolvePromptRecognitionMatcher(source)
    names = ["emil", "draper"]
    const second = resolvePromptRecognitionMatcher(source)
    expect(second).not.toBe(first)
    expect(resolvePromptHighlightSpans("ask draper", second)).toEqual([
      { start: 4, end: 10 },
    ])
  })
})
