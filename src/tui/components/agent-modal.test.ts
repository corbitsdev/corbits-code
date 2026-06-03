import { describe, test, expect } from "bun:test";
import { toAgentProviders } from "./agent-modal.js";

describe("toAgentProviders", () => {
  test("projects to name + models and drops credentials", () => {
    const result = toAgentProviders([
      { name: "fp", baseURL: "https://fp/v1", apiKey: "sk-secret", models: ["a", "b"], defaultModel: "a" },
    ] as never);
    expect(result).toEqual([{ name: "fp", models: ["a", "b"], defaultModel: "a" }]);
    // The credential-isolation invariant, as an executable check: no apiKey or
    // baseURL may survive the projection into what the modal renders.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("sk-secret");
    expect(serialized).not.toContain("baseURL");
  });

  test("omits defaultModel when absent", () => {
    const result = toAgentProviders([{ name: "solo", models: ["only"] }]);
    expect(result[0]).toEqual({ name: "solo", models: ["only"] });
    expect("defaultModel" in result[0]!).toBe(false);
  });
});
