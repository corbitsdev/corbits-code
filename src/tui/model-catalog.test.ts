import { describe, expect, test } from "bun:test"
import {
  buildModelCatalog,
  buildModelsFirstCatalog,
  describeModelCatalogOption,
  modelOptionId,
  type ModelCatalogProvider,
} from "./model-catalog"

describe("buildModelCatalog", () => {
  test("maps provider array to id/label picker options", () => {
    const options = buildModelCatalog([
      { name: "xai", models: ["grok-4", "grok-3"], label: "xAI" },
      { name: "openai", models: ["gpt-4.1"] },
    ])
    expect(options).toEqual([
      { id: "xai:grok-4", label: "grok-4 * [xAI]" },
      { id: "xai:grok-3", label: "grok-3 * [xAI]" },
      { id: "openai:gpt-4.1", label: "gpt-4.1 * [openai]" },
    ])
  })

  test("maps settings-style providers record", () => {
    const options = buildModelCatalog({
      fp: { models: ["fp-small", "fp-large"] },
      zen: { models: ["claude-sonnet-4-5"], label: "Zen" },
    })
    expect(options).toEqual([
      { id: "fp:fp-small", label: "fp-small * [fp]" },
      { id: "fp:fp-large", label: "fp-large * [fp]" },
      { id: "zen:claude-sonnet-4-5", label: "claude-sonnet-4-5 * [Zen]" },
    ])
  })

  test("skips empty models and blank names", () => {
    expect(
      buildModelCatalog([
        { name: "empty", models: [] },
        { name: "blank", models: ["  ", "keep"] },
      ]),
    ).toEqual([{ id: "blank:keep", label: "keep * [blank]" }])
  })

  test("dedupes by provider:model id", () => {
    const options = buildModelCatalog([
      { name: "xai", models: ["grok-4", "grok-4"] },
    ])
    expect(options).toEqual([{ id: "xai:grok-4", label: "grok-4 * [xai]" }])
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

const xai: ModelCatalogProvider = {
  name: "xai",
  label: "xAI",
  models: ["grok-4", "grok-3"],
}

const zen: ModelCatalogProvider = {
  name: "zen",
  label: "OpenCode Zen",
  models: ["kimi-k2.7-code", "claude-sonnet-4-5"],
  baseURL: "https://opencode.ai/zen/v1",
}

const go: ModelCatalogProvider = {
  name: "opencode-go",
  label: "OpenCode Go",
  models: ["kimi-k2.7-code", "glm-5"],
  opencodeGo: true,
}

describe("buildModelsFirstCatalog", () => {
  test("orders recent, then favorites, then provider buckets", () => {
    const list = buildModelsFirstCatalog({
      providers: [xai, zen],
      recent: [{ provider: "zen", model: "claude-sonnet-4-5" }],
      favorites: [{ provider: "xai", model: "grok-4" }],
    })

    expect(list.map((r) => `${r.section}:${r.id}`)).toEqual([
      "recent:zen:claude-sonnet-4-5",
      "favorites:xai:grok-4",
      "provider:xai:grok-3",
      "provider:zen:kimi-k2.7-code",
    ])
  })

  test("drops recent entries whose model no longer exists on the provider", () => {
    const list = buildModelsFirstCatalog({
      providers: [xai],
      recent: [
        { provider: "xai", model: "gone-model" },
        { provider: "xai", model: "grok-4" },
      ],
      favorites: [],
    })

    expect(list.filter((r) => r.section === "recent").map((r) => r.id)).toEqual([
      "xai:grok-4",
    ])
  })

  test("skips favorites and provider rows already covered by recent", () => {
    const list = buildModelsFirstCatalog({
      providers: [xai],
      recent: [{ provider: "xai", model: "grok-4" }],
      favorites: [{ provider: "xai", model: "grok-4" }],
    })

    expect(list.filter((r) => r.id === "xai:grok-4")).toHaveLength(1)
    expect(list[0]?.section).toBe("recent")
  })

  test("caps recent at recentMax (default 5)", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      provider: "xai",
      model: `m${i}`,
    }))
    const provider: ModelCatalogProvider = {
      name: "xai",
      models: many.map((r) => r.model),
    }
    const list = buildModelsFirstCatalog({
      providers: [provider],
      recent: many,
      favorites: [],
    })

    expect(list.filter((r) => r.section === "recent")).toHaveLength(5)
  })

  test("respects a custom recentMax", () => {
    const many = Array.from({ length: 4 }, (_, i) => ({
      provider: "xai",
      model: `m${i}`,
    }))
    const provider: ModelCatalogProvider = {
      name: "xai",
      models: many.map((r) => r.model),
    }
    const list = buildModelsFirstCatalog({
      providers: [provider],
      recent: many,
      favorites: [],
      recentMax: 2,
    })

    expect(list.filter((r) => r.section === "recent")).toHaveLength(2)
  })

  test("attaches zen-path billing warning via injected predicate", () => {
    const list = buildModelsFirstCatalog({
      providers: [zen, go],
      recent: [{ provider: "zen", model: "kimi-k2.7-code" }],
      favorites: [],
      isGoModelOnZenPath: (model, provider) =>
        model === "kimi-k2.7-code" && provider.name === "zen",
    })

    const recent = list.find((r) => r.section === "recent")
    expect(recent?.warning).toMatch(/Go model on Zen path/)
    expect(recent?.label).not.toContain("Go model on Zen path")

    const goRow = list.find((r) => r.id === "opencode-go:kimi-k2.7-code")
    expect(goRow?.warning).toBeUndefined()
  })

  test("attaches the real billing-product warning by default (no predicate injected)", () => {
    const list = buildModelsFirstCatalog({
      providers: [zen],
      recent: [{ provider: "zen", model: "kimi-k2.7-code" }],
      favorites: [],
    })

    const row = list.find((r) => r.id === "zen:kimi-k2.7-code")
    expect(row?.warning).toMatch(/Go model on Zen path/)
  })

  test("uses provider name as label when label is unset", () => {
    const list = buildModelsFirstCatalog({
      providers: [{ name: "custom", models: ["m1"] }],
      recent: [],
      favorites: [],
    })
    expect(list[0]?.label).toBe("m1 * [custom]")
  })
})

describe("describeModelCatalogOption", () => {
  test("surfaces the Go-on-Zen billing warning as a consequence-toned impact, not the label", () => {
    const description = describeModelCatalogOption(
      { id: "zen:kimi-k2.7-code", label: "kimi-k2.7-code * [OpenCode Zen]", warning: "Go model on Zen path" },
      { pricing: null },
    )
    expect(description?.tone).toBe("consequence")
    expect(description?.impact).toMatch(/Zen credits/)
  })

  test("reports pricing as unknown rather than inventing a number", () => {
    const description = describeModelCatalogOption(
      { id: "xai:grok-4", label: "grok-4 * [xAI]" },
      { pricing: null },
    )
    expect(description?.impact).toMatch(/pricing unknown/i)
  })
})
