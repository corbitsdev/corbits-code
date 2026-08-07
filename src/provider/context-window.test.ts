import { describe, expect, it, afterEach } from "bun:test";
import {
  contextWindowFor,
  hasContextWindowFor,
  setModelContextWindows,
} from "./context-window.js";

describe("contextWindowFor", () => {
  afterEach(() => {
    setModelContextWindows(undefined);
  });

  it("resolves a custom-provider-prefixed id against the bare model registry entry", () => {
    setModelContextWindows({ "grok-4.5": 500_000 });
    expect(contextWindowFor("xai/thegreataxios:grok-4.5")).toBe(500_000);
  });

  it("resolves a custom-provider-prefixed id against the canonical provider/model entry", () => {
    setModelContextWindows({ "xai/grok-4.5": 500_000 });
    expect(contextWindowFor("xai/thegreataxios:grok-4.5")).toBe(500_000);
  });

  it("falls back to a grok/xai heuristic window when the registry has no entry", () => {
    setModelContextWindows(undefined);
    expect(contextWindowFor("xai/thegreataxios:grok-4.5")).toBe(256_000);
  });

  it("reports low confidence when a miss falls through to the heuristic", () => {
    setModelContextWindows(undefined);
    expect(hasContextWindowFor("xai/thegreataxios:grok-4.5")).toBe(false);
  });

  it("reports confidence when the registry has a matching entry", () => {
    setModelContextWindows({ "grok-4.5": 500_000 });
    expect(hasContextWindowFor("xai/thegreataxios:grok-4.5")).toBe(true);
  });
});
