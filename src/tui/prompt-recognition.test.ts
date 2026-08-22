import { describe, expect, test } from "bun:test"
import {
  buildPromptRecognitionMatcher,
  resolvePromptHighlightSpans,
  resolvePromptRecognitionMatcher,
  type PromptRecognitionSource,
} from "./prompt-recognition"

const COMMANDS = ["implement", "review", "improve", "linear-create"] as const

describe("buildPromptRecognitionMatcher", () => {
  test("returns null for an empty name set", () => {
    expect(buildPromptRecognitionMatcher([])).toBeNull()
  })

  test("a leading registered slash command paints /name only", () => {
    const matcher = buildPromptRecognitionMatcher(["implement", "review"])
    expect(resolvePromptHighlightSpans("/implement now", matcher)).toEqual([
      { start: 0, end: 10 },
    ])
  })

  test("does not paint arguments after the command name", () => {
    const matcher = buildPromptRecognitionMatcher(["implement"])
    expect(resolvePromptHighlightSpans("/implement the thing", matcher)).toEqual([
      { start: 0, end: 10 },
    ])
  })

  test("bare words stay unstyled even when they match a registered name", () => {
    const matcher = buildPromptRecognitionMatcher([...COMMANDS])
    for (const text of ["emil", "implement", "brand review", "improve", "linear-create"]) {
      expect(resolvePromptHighlightSpans(text, matcher)).toEqual([])
    }
  })

  test("a mid-prose slash command stays unstyled", () => {
    const matcher = buildPromptRecognitionMatcher(["review", "implement"])
    expect(resolvePromptHighlightSpans("please /review this", matcher)).toEqual([])
  })

  test("an @mention paints anywhere", () => {
    const matcher = buildPromptRecognitionMatcher(["implement"])
    expect(resolvePromptHighlightSpans("ask @emil to review", matcher)).toEqual([
      { start: 4, end: 9 },
    ])
  })

  test("mentions paint even when no commands are registered", () => {
    expect(resolvePromptHighlightSpans("@emil", null)).toEqual([{ start: 0, end: 5 }])
  })

  test("a quoted @mention paints the quoted token", () => {
    expect(resolvePromptHighlightSpans('see @"brand review" please', null)).toEqual([
      { start: 4, end: 19 },
    ])
  })

  test("a leading command and a mention both paint", () => {
    const matcher = buildPromptRecognitionMatcher(["implement"])
    expect(resolvePromptHighlightSpans("/implement @emil", matcher)).toEqual([
      { start: 0, end: 10 },
      { start: 11, end: 16 },
    ])
  })

  test("longer command names win over a shorter prefix", () => {
    const matcher = buildPromptRecognitionMatcher(["brand", "brand-review"])
    expect(resolvePromptHighlightSpans("/brand-review now", matcher)).toEqual([
      { start: 0, end: 13 },
    ])
  })

  test("a lookalike command prefix does not match", () => {
    const matcher = buildPromptRecognitionMatcher(["implement"])
    expect(resolvePromptHighlightSpans("/implements", matcher)).toEqual([])
  })

  test("slash matching is case-insensitive", () => {
    const matcher = buildPromptRecognitionMatcher(["implement"])
    expect(resolvePromptHighlightSpans("/IMPLEMENT", matcher)).toEqual([
      { start: 0, end: 10 },
    ])
  })
})

describe("resolvePromptRecognitionMatcher", () => {
  test("caches the matcher while the name set is unchanged", () => {
    const source: PromptRecognitionSource = () => ({
      commandNames: ["implement"],
    })
    const first = resolvePromptRecognitionMatcher(source)
    const second = resolvePromptRecognitionMatcher(source)
    expect(second).toBe(first)
  })

  test("rebuilds the matcher when the name set changes", () => {
    let names = ["implement"]
    const source: PromptRecognitionSource = () => ({
      commandNames: names,
    })
    const first = resolvePromptRecognitionMatcher(source)
    names = ["implement", "review"]
    const second = resolvePromptRecognitionMatcher(source)
    expect(second).not.toBe(first)
    expect(resolvePromptHighlightSpans("/review", second)).toEqual([{ start: 0, end: 7 }])
    expect(resolvePromptHighlightSpans("review", second)).toEqual([])
  })
})
