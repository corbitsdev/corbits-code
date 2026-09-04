import { describe, test, expect } from "bun:test";
import { resolveResumeSeed } from "./session-start.js";
import type { RunState } from "../session/state.js";

function pickedState(overrides: Partial<RunState>): RunState {
  return {
    status: "running",
    turnsUsed: 0,
    task: "task",
    startedAt: 1,
    ...overrides,
  };
}

describe("resolveResumeSeed", () => {
  test("a fresh (non-resumed) run seeds zero turns and no servers", () => {
    expect(resolveResumeSeed(null)).toEqual({ turnsUsed: 0, mcpServers: [] });
  });

  test("carries forward a resumed session's non-zero turnsUsed and non-empty mcpServers", () => {
    const seed = resolveResumeSeed(
      pickedState({
        turnsUsed: 12,
        mcpServers: [
          { name: "filesystem", toolCount: 5 },
          { name: "search", toolCount: 2 },
        ],
      }),
    );

    expect(seed.turnsUsed).toBe(12);
    expect(seed.mcpServers).toEqual([
      { name: "filesystem", toolCount: 5 },
      { name: "search", toolCount: 2 },
    ]);
  });

  test("defaults mcpServers to empty when a resumed record predates that field", () => {
    const seed = resolveResumeSeed(pickedState({ turnsUsed: 3 }));

    expect(seed.turnsUsed).toBe(3);
    expect(seed.mcpServers).toEqual([]);
  });
});
