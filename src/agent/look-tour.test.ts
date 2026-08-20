import { describe, expect, test } from "bun:test";
import { PRIMARY_SALVAGE_NUDGE } from "./look-tour.js";

describe("primary salvage nudge", () => {
  test("tells Skywalker not to search the repo after a failed worker", () => {
    expect(PRIMARY_SALVAGE_NUDGE).toContain("stopped without finishing");
    expect(PRIMARY_SALVAGE_NUDGE).toContain("Do not search the repo yourself");
    expect(PRIMARY_SALVAGE_NUDGE).toContain("Change the brief");
  });
});
