import { describe, expect, test } from "bun:test";

import {
  BUNDLED_PLUGIN_MARKER,
  pluginOriginMarker,
  withOriginMarker,
} from "./origin-marker";

describe("pluginOriginMarker", () => {
  test("bundled repo plugins get the mountain marker", () => {
    expect(pluginOriginMarker("repo")).toBe(BUNDLED_PLUGIN_MARKER);
  });

  test("other origins render as their origin label", () => {
    expect(pluginOriginMarker("user")).toBe("[user]");
    expect(pluginOriginMarker("project")).toBe("[project]");
    expect(pluginOriginMarker("path")).toBe("[path]");
  });

  test("rows without an origin stay unmarked", () => {
    expect(pluginOriginMarker(undefined)).toBe("");
  });
});

describe("withOriginMarker", () => {
  test("appends the marker after the label", () => {
    expect(withOriginMarker("/implement", "repo")).toBe(
      `/implement ${BUNDLED_PLUGIN_MARKER}`,
    );
    expect(withOriginMarker("exa — enabled", "user")).toBe(
      "exa — enabled [user]",
    );
  });

  test("leaves unmarked labels alone", () => {
    expect(withOriginMarker("/help", undefined)).toBe("/help");
  });
});
