import { describe, expect, test } from "bun:test";

import { resolveZenEndpoint } from "./endpoint.js";
import { isKnownZenModel, protocolForZenModel } from "./models.js";

describe("protocolForZenModel", () => {
  test("maps grok-4.7 to responses like grok-4.6", () => {
    expect(protocolForZenModel("grok-4.7")).toBe("responses");
    expect(protocolForZenModel("grok-4.6")).toBe("responses");
    expect(isKnownZenModel("grok-4.7")).toBe(true);
    expect(isKnownZenModel("grok-4.6")).toBe(true);
  });
});

describe("resolveZenEndpoint", () => {
  test("routes grok-4.7 the same as grok-4.6", () => {
    expect(resolveZenEndpoint("grok-4.7")).toEqual(
      resolveZenEndpoint("grok-4.6"),
    );
    expect(resolveZenEndpoint("grok-4.7").adapter).toBe("openai-responses");
  });
});
