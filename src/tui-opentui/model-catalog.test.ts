import { describe, expect, test } from "bun:test"
import {
  buildModelCatalog,
  modelOptionId,
} from "./model-catalog"

describe("buildModelCatalog", () => {
  test("maps provider array to id/label picker options", () => {
    const options = buildModelCatalog([
      { name: "xai", models: ["grok-4", "grok-3"], label: "xAI" },
      { name: "openai", models: ["gpt-4.1"] },
    ])
    expect(options).toEqual([
      { id: "xai:grok-4", label: "xAI / grok-4" },
      { id: "xai:grok-3", label: "xAI / grok-3" },
      { id: "openai:gpt-4.1", label: "openai / gpt-4.1" },
    ])
  })

  test("maps settings-style providers record", () => {
    const options = buildModelCatalog({
      fp: { models: ["fp-small", "fp-large"] },
      zen: { models: ["claude-sonnet-4-5"], label: "Zen" },
    })
    expect(options).toEqual([
      { id: "fp:fp-small", label: "fp / fp-small" },
      { id: "fp:fp-large", label: "fp / fp-large" },
      { id: "zen:claude-sonnet-4-5", label: "Zen / claude-sonnet-4-5" },
    ])
  })

  test("skips empty models and blank names", () => {
    expect(
      buildModelCatalog([
        { name: "empty", models: [] },
        { name: "blank", models: ["  ", "keep"] },
      ]),
    ).toEqual([{ id: "blank:keep", label: "blank / keep" }])
  })

  test("dedupes by provider:model id", () => {
    const options = buildModelCatalog([
      { name: "xai", models: ["grok-4", "grok-4"] },
    ])
    expect(options).toEqual([{ id: "xai:grok-4", label: "xai / grok-4" }])
  })

  test("empty input yields empty catalog", () => {
    expect(buildModelCatalog([])).toEqual([])
    expect(buildModelCatalog({})).toEqual([])
  })
})

describe("modelOptionId", () => {
  test("provider:model", () => {
    expect(modelOptionId("xai", "grok-4")).toBe("xai:grok-4")
  })
})
