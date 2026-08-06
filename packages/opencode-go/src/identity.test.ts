import { describe, expect, test } from "bun:test";

import { OPENCODE_GO_DISPLAY_NAME, OPENCODE_GO_PROVIDER_ID } from "./constants.js";
import {
  isOpenCodeGoProvider,
  isOpenCodeGoProviderId,
  isOpenCodeGoURL,
} from "./identity.js";

describe("isOpenCodeGoProviderId", () => {
  test("matches stable id and display name", () => {
    expect(isOpenCodeGoProviderId(OPENCODE_GO_PROVIDER_ID)).toBe(true);
    expect(isOpenCodeGoProviderId(OPENCODE_GO_DISPLAY_NAME)).toBe(true);
    expect(isOpenCodeGoProviderId("opencode-go")).toBe(true);
    expect(isOpenCodeGoProviderId("OpenCode Go")).toBe(true);
  });

  test("rejects zen, empty, and unrelated names", () => {
    expect(isOpenCodeGoProviderId("zen")).toBe(false);
    expect(isOpenCodeGoProviderId("openai")).toBe(false);
    expect(isOpenCodeGoProviderId("")).toBe(false);
    expect(isOpenCodeGoProviderId(undefined)).toBe(false);
    expect(isOpenCodeGoProviderId("opencode go")).toBe(false);
  });
});

describe("isOpenCodeGoProvider", () => {
  test("true on flag or known name", () => {
    expect(isOpenCodeGoProvider({ opencodeGo: true })).toBe(true);
    expect(isOpenCodeGoProvider({ name: "opencode-go" })).toBe(true);
    expect(isOpenCodeGoProvider({ name: "OpenCode Go" })).toBe(true);
  });

  test("true on Go baseURL even with a custom name", () => {
    expect(
      isOpenCodeGoProvider({
        name: "go/personal",
        baseURL: "https://opencode.ai/zen/go/v1",
      }),
    ).toBe(true);
    expect(
      isOpenCodeGoProvider({
        name: "go/personal",
        baseURL: "https://opencode.ai/zen/go",
      }),
    ).toBe(true);
  });

  test("URL wins over a zen name when baseURL is Go", () => {
    expect(
      isOpenCodeGoProvider({
        name: "zen",
        baseURL: "https://opencode.ai/zen/go/v1",
      }),
    ).toBe(true);
  });

  test("false without flag, known name, or Go baseURL", () => {
    expect(isOpenCodeGoProvider({ name: "zen" })).toBe(false);
    expect(isOpenCodeGoProvider({})).toBe(false);
    expect(isOpenCodeGoProvider({ opencodeGo: false, name: "zen" })).toBe(false);
  });

  test("bare Zen baseURL is not Go", () => {
    expect(
      isOpenCodeGoProvider({
        name: "custom-zen",
        baseURL: "https://opencode.ai/zen/v1",
      }),
    ).toBe(false);
    expect(
      isOpenCodeGoProvider({
        name: "zen",
        baseURL: "https://opencode.ai/zen",
      }),
    ).toBe(false);
  });

  test("rejects spoofed Go-looking baseURLs", () => {
    expect(
      isOpenCodeGoProvider({
        name: "spoof",
        baseURL: "https://not-opencode.ai/zen/go/v1",
      }),
    ).toBe(false);
    expect(
      isOpenCodeGoProvider({
        name: "spoof",
        baseURL: "https://myopencode.ai/zen/go/v1",
      }),
    ).toBe(false);
    expect(
      isOpenCodeGoProvider({
        name: "spoof",
        baseURL: "https://opencode.ai/zen/goodies",
      }),
    ).toBe(false);
    expect(
      isOpenCodeGoProvider({
        name: "spoof",
        baseURL: "https://evil.com/?u=https://opencode.ai/zen/go/v1",
      }),
    ).toBe(false);
  });

  test("private host needs flag or known name (URL alone is not enough)", () => {
    expect(
      isOpenCodeGoProvider({
        name: "go-proxy",
        baseURL: "https://go.internal.example/zen/go/v1",
      }),
    ).toBe(false);
    expect(
      isOpenCodeGoProvider({
        name: "go-proxy",
        baseURL: "https://go.internal.example/zen/go/v1",
        opencodeGo: true,
      }),
    ).toBe(true);
    expect(
      isOpenCodeGoProvider({
        name: "opencode-go",
        baseURL: "https://go.internal.example/zen/go/v1",
      }),
    ).toBe(true);
  });
});

describe("isOpenCodeGoURL (identity export)", () => {
  test("is exported from identity and matches public Go bases", () => {
    expect(isOpenCodeGoURL("https://opencode.ai/zen/go/v1")).toBe(true);
    expect(isOpenCodeGoURL("https://go.internal.example/zen/go/v1")).toBe(false);
  });
});
