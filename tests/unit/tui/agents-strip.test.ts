import { describe, expect, test } from "bun:test";

import {
  agentsStripRowCount,
  DEFAULT_STRIP_MAX_VISIBLE,
} from "../../../src/tui/components/agents-strip.js";

describe("agentsStripRowCount", () => {
  test("no sessions reserves no rows", () => {
    expect(agentsStripRowCount(0, DEFAULT_STRIP_MAX_VISIBLE)).toBe(0);
  });

  test("below the cap reserves header plus one row per session", () => {
    expect(agentsStripRowCount(3, DEFAULT_STRIP_MAX_VISIBLE)).toBe(1 + 3);
  });

  test("above the cap stays bounded and adds a single overflow row", () => {
    // 20 retained sessions must not reserve 20 rows; the strip caps and folds
    // the remainder into one overflow line.
    expect(agentsStripRowCount(20, DEFAULT_STRIP_MAX_VISIBLE)).toBe(
      1 + DEFAULT_STRIP_MAX_VISIBLE + 1,
    );
  });
});
