import { describe, expect, test } from "bun:test";
import {
  buildModelCatalog,
  buildModelsFirstCatalog,
  describeModelCatalogOption,
  modelOptionId,
  modelOptionRef,
  type ModelCatalogProvider,
} from "./model-catalog";

describe("buildModelCatalog", () => {
  test("maps provider array to id/label picker options", () => {
    const options = buildModelCatalog([
      { name: "xai", models: ["grok-4", "grok-3"], label: "xAI" },
      { name: "openai", models: ["gpt-5.6"] },
    ]);
    expect(options).toEqual([
      { id: modelOptionId("xai", "grok-4"), label: "grok-4 * [xAI]" },
      { id: modelOptionId("xai", "grok-3"), label: "grok-3 * [xAI]" },
      { id: modelOptionId("openai", "gpt-5.6"), label: "gpt-5.6 * [openai]" },
    ]);
  });

  test("maps settings-style providers record", () => {
    const options = buildModelCatalog({
      fp: { models: ["fp-small", "fp-large"] },
      zen: { models: ["claude-sonnet-4-5"], label: "Zen" },
    });
    expect(options).toEqual([
      { id: modelOptionId("fp", "fp-small"), label: "fp-small * [fp]" },
      { id: modelOptionId("fp", "fp-large"), label: "fp-large * [fp]" },
      {
        id: modelOptionId("zen", "claude-sonnet-4-5"),
        label: "claude-sonnet-4-5 * [Zen]",
      },
    ]);
  });

  test("skips empty models and blank names", () => {
    expect(
      buildModelCatalog([
        { name: "empty", models: [] },
        { name: "blank", models: ["  ", "keep"] },
      ]),
    ).toEqual([
      { id: modelOptionId("blank", "keep"), label: "keep * [blank]" },
    ]);
  });

  test("dedupes by provider:model id", () => {
    const options = buildModelCatalog([
      { name: "xai", models: ["grok-4", "grok-4"] },
    ]);
    expect(options).toEqual([
      { id: modelOptionId("xai", "grok-4"), label: "grok-4 * [xai]" },
    ]);
  });

  test("empty input yields empty catalog", () => {
    expect(buildModelCatalog([])).toEqual([]);
    expect(buildModelCatalog({})).toEqual([]);
  });
});

describe("modelOptionId", () => {
  test("round-trips representative legal identities", () => {
    const values = [
      "plain",
      "leading[bracket",
      "colon:value",
      'quote"value',
      '["encoded","looking"]',
    ];
    for (const provider of values) {
      for (const model of values) {
        expect(modelOptionRef(modelOptionId(provider, model))).toEqual({
          provider,
          model,
        });
      }
    }
  });

  test("is unique across provider and model domains", () => {
    const pairs = [
      ["a:b", "c"],
      ["a", "b:c"],
      ['["a","b"]', "c"],
      ["a", '["b","c"]'],
      ["[a", 'b:c"'],
    ] as const;
    expect(
      new Set(pairs.map(([provider, model]) => modelOptionId(provider, model)))
        .size,
    ).toBe(pairs.length);
  });

  test("rejects malformed and non-canonical identities", () => {
    for (const id of ["", "a:b", "[]", '["a"]', '["a","b","c"]'])
      expect(modelOptionRef(id)).toBeNull();
  });
});

const xai: ModelCatalogProvider = {
  name: "xai",
  label: "xAI",
  models: ["grok-4", "grok-3"],
};

const zen: ModelCatalogProvider = {
  name: "zen",
  label: "OpenCode Zen",
  models: ["kimi-k2.7-code", "claude-sonnet-4-5"],
  baseURL: "https://opencode.ai/zen/v1",
};

const go: ModelCatalogProvider = {
  name: "opencode-go",
  label: "OpenCode Go",
  models: ["kimi-k2.7-code", "glm-5"],
  opencodeGo: true,
};

/** A provider whose every model is also a recent entry, for recentMax tests. */
function allRecentCatalog(count: number, recentMax?: number) {
  const many = Array.from({ length: count }, (_, i) => ({
    provider: "xai",
    model: `m${i}`,
  }));
  const provider: ModelCatalogProvider = {
    name: "xai",
    models: many.map((r) => r.model),
  };
  return buildModelsFirstCatalog({
    providers: [provider],
    recent: many,
    favorites: [],
    ...(recentMax === undefined ? {} : { recentMax }),
  });
}

describe("buildModelsFirstCatalog", () => {
  test("orders recent, then favorites, then provider buckets", () => {
    const list = buildModelsFirstCatalog({
      providers: [xai, zen],
      recent: [{ provider: "zen", model: "claude-sonnet-4-5" }],
      favorites: [{ provider: "xai", model: "grok-4" }],
    });

    expect(list.map((r) => `${r.section}:${r.id}`)).toEqual([
      `recent:${modelOptionId("zen", "claude-sonnet-4-5")}`,
      `favorites:${modelOptionId("xai", "grok-4")}`,
      `provider:${modelOptionId("xai", "grok-3")}`,
      `provider:${modelOptionId("zen", "kimi-k2.7-code")}`,
    ]);
  });

  test("drops recent entries whose model no longer exists on the provider", () => {
    const list = buildModelsFirstCatalog({
      providers: [xai],
      recent: [
        { provider: "xai", model: "gone-model" },
        { provider: "xai", model: "grok-4" },
      ],
      favorites: [],
    });

    expect(list.filter((r) => r.section === "recent").map((r) => r.id)).toEqual(
      [modelOptionId("xai", "grok-4")],
    );
  });

  test("skips favorites and provider rows already covered by recent", () => {
    const list = buildModelsFirstCatalog({
      providers: [xai],
      recent: [{ provider: "xai", model: "grok-4" }],
      favorites: [{ provider: "xai", model: "grok-4" }],
    });

    expect(
      list.filter((r) => r.id === modelOptionId("xai", "grok-4")),
    ).toHaveLength(1);
    expect(list[0]?.section).toBe("recent");
  });

  test("caps recent at recentMax (default 5)", () => {
    const list = allRecentCatalog(8);

    expect(list.filter((r) => r.section === "recent")).toHaveLength(5);
  });

  test("respects a custom recentMax", () => {
    const list = allRecentCatalog(4, 2);

    expect(list.filter((r) => r.section === "recent")).toHaveLength(2);
  });

  test("attaches zen-path billing warning via injected predicate", () => {
    const list = buildModelsFirstCatalog({
      providers: [zen, go],
      recent: [{ provider: "zen", model: "kimi-k2.7-code" }],
      favorites: [],
      isGoModelOnZenPath: (model, provider) =>
        model === "kimi-k2.7-code" && provider.name === "zen",
    });

    const recent = list.find((r) => r.section === "recent");
    expect(recent?.warning).toBeTruthy();
    expect(recent?.label).not.toContain(String(recent?.warning));

    const goRow = list.find(
      (r) => r.id === modelOptionId("opencode-go", "kimi-k2.7-code"),
    );
    expect(goRow?.warning).toBeUndefined();
  });

  test("attaches the real billing-product warning by default (no predicate injected)", () => {
    const list = buildModelsFirstCatalog({
      providers: [zen],
      recent: [{ provider: "zen", model: "kimi-k2.7-code" }],
      favorites: [],
    });

    const row = list.find(
      (r) => r.id === modelOptionId("zen", "kimi-k2.7-code"),
    );
    expect(row?.warning).toBeTruthy();
  });
});

describe("describeModelCatalogOption", () => {
  test("surfaces the Go-on-Zen billing warning as a consequence-toned impact, not the label", () => {
    const description = describeModelCatalogOption(
      {
        id: modelOptionId("zen", "kimi-k2.7-code"),
        label: "kimi-k2.7-code * [OpenCode Zen]",
        warning: "Go model on Zen path",
      },
      { pricing: null },
    );
    expect(description?.tone).toBe("consequence");
    expect(description?.impact).toBeTruthy();
  });

  test("reports pricing as unknown rather than inventing a number", () => {
    const description = describeModelCatalogOption(
      { id: modelOptionId("xai", "grok-4"), label: "grok-4 * [xAI]" },
      { pricing: null },
    );
    expect(description?.impact).toBeTruthy();
    expect(description?.impact).not.toMatch(/[$\d]/);
  });

  test("connected subscription rows state plan billing plainly instead of unknown pricing (CL-5606)", () => {
    // Subscription-billed models have no per-token price; "Pricing unknown"
    // misreads as metered billing with a missing rate.
    const unknown = describeModelCatalogOption(
      { id: modelOptionId("xai", "grok-4"), label: "x" },
      { pricing: null },
    );
    for (const id of [
      modelOptionId("codex/default", "gpt-5.1-codex-max"),
      modelOptionId("xai/work", "grok-4"),
    ]) {
      const description = describeModelCatalogOption(
        { id, label: "x" },
        { pricing: null },
      );
      expect(description?.impact).toBeTruthy();
      expect(description?.impact).not.toBe(unknown?.impact);
    }
  });

  test("colon-less ids keep the full provider instead of dropping the last character", () => {
    // slice(0, indexOf(":")) truncates a colon-less id (indexOf is -1), so
    // "codex/" became "code" and missed subscription billing.
    const description = describeModelCatalogOption(
      { id: "codex/", label: "default * [Codex default]" },
      { pricing: null },
    );
    const reference = describeModelCatalogOption(
      { id: modelOptionId("codex/default", "gpt-5.1-codex-max"), label: "x" },
      { pricing: null },
    );
    expect(description?.impact).toBe(reference?.impact);
  });
});
