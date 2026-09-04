import { describe, expect, test } from "bun:test";

import {
  billingProductForProvider,
  isBareZenBaseURL,
  isGoModelOnZenPath,
} from "./billing-product.js";

describe("isBareZenBaseURL", () => {
  test("matches bare zen PAYG bases", () => {
    expect(isBareZenBaseURL("https://opencode.ai/zen/v1")).toBe(true);
    expect(isBareZenBaseURL("https://opencode.ai/zen/v1/")).toBe(true);
    expect(isBareZenBaseURL("https://opencode.ai/zen")).toBe(true);
  });

  test("rejects Go subscription bases", () => {
    expect(isBareZenBaseURL("https://opencode.ai/zen/go/v1")).toBe(false);
    expect(isBareZenBaseURL("https://opencode.ai/zen/go")).toBe(false);
  });

  test("rejects unrelated hosts", () => {
    expect(isBareZenBaseURL("https://api.openai.com/v1")).toBe(false);
  });
});

describe("billingProductForProvider", () => {
  test("OpenCode Go flag or id is subscription", () => {
    expect(billingProductForProvider({ opencodeGo: true })).toBe("subscription");
    expect(billingProductForProvider({ name: "opencode-go" })).toBe("subscription");
    expect(billingProductForProvider({ name: "OpenCode Go" })).toBe("subscription");
    expect(
      billingProductForProvider({
        name: "opencode-go",
        baseURL: "https://opencode.ai/zen/go/v1",
        opencodeGo: true,
      }),
    ).toBe("subscription");
  });

  test("custom name with Go baseURL only is subscription", () => {
    expect(
      billingProductForProvider({
        name: "go/personal",
        baseURL: "https://opencode.ai/zen/go/v1",
      }),
    ).toBe("subscription");
  });

  test("zen name or bare zen baseURL is credits", () => {
    expect(billingProductForProvider({ name: "zen" })).toBe("credits");
    expect(
      billingProductForProvider({
        name: "custom-zen",
        baseURL: "https://opencode.ai/zen/v1",
      }),
    ).toBe("credits");
  });

  test("Go takes precedence over a wrong zen baseURL when flag is set", () => {
    expect(
      billingProductForProvider({
        name: "opencode-go",
        baseURL: "https://opencode.ai/zen/v1",
        opencodeGo: true,
      }),
    ).toBe("subscription");
  });

  test("unknown providers return undefined", () => {
    expect(
      billingProductForProvider({
        name: "openai",
        baseURL: "https://api.openai.com/v1",
      }),
    ).toBeUndefined();
  });
});

describe("isGoModelOnZenPath", () => {
  test("true when a known Go model sits on a Zen-billed provider", () => {
    expect(
      isGoModelOnZenPath("kimi-k2.7-code", {
        name: "zen",
        baseURL: "https://opencode.ai/zen/v1",
      }),
    ).toBe(true);
  });

  test("false when provider is Go subscription", () => {
    expect(
      isGoModelOnZenPath("kimi-k2.7-code", {
        name: "opencode-go",
        baseURL: "https://opencode.ai/zen/go/v1",
        opencodeGo: true,
      }),
    ).toBe(false);
  });

  test("false for a live-only Go id on Zen (protocol map, not picker membership)", () => {
    expect(
      isGoModelOnZenPath("muse-spark-1.2-contributor", {
        name: "zen",
        baseURL: "https://opencode.ai/zen/v1",
      }),
    ).toBe(false);
  });

  test("false for non-Go models on Zen", () => {
    expect(
      isGoModelOnZenPath("claude-sonnet-4-5", {
        name: "zen",
        baseURL: "https://opencode.ai/zen/v1",
      }),
    ).toBe(false);
  });

  test("false for Go models on unrelated providers", () => {
    expect(
      isGoModelOnZenPath("kimi-k2.7-code", {
        name: "openai",
        baseURL: "https://api.openai.com/v1",
      }),
    ).toBe(false);
  });
});

describe("billingProductForProvider", () => {
  test("resolves subscription and credits labels for UI rows", () => {
    expect(billingProductForProvider({ name: "opencode-go", opencodeGo: true })).toBe(
      "subscription",
    );
    expect(billingProductForProvider({ name: "zen" })).toBe("credits");
    expect(billingProductForProvider({ name: "openai" })).toBeUndefined();
  });
});
