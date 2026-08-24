import { describe, expect, test } from "bun:test";
import { resolveSubAgentMaxTurns } from "../config/settings.js";
import { resolveDirector } from "../agent/directors/registry.js";
import { resolveDirectorDispatch } from "./agent-fleet.js";

describe("spawn_agent vs task() turn budget parity", () => {
  for (const id of ["intern", "explore", "build", "critique", "greybeard"]) {
    test(`${id}: spawn_agent and task() resolve the same finite budget`, () => {
      const resolved = resolveDirector({ agentId: id });
      expect(resolved.ok).toBe(true);
      const pkgMax = resolved.ok ? resolved.package.nudge?.maxTurns : undefined;
      expect(Number.isFinite(pkgMax)).toBe(true);

      // task() path: passes profileMaxTurns (task-tool.ts:595)
      const viaTask = resolveSubAgentMaxTurns({ profileMaxTurns: pkgMax as number });
      expect(viaTask).toBe(pkgMax as number);

      // spawn_agent path: resolveDirectorDispatch now surfaces the same
      // package budget, and agent-fleet.ts threads it through.
      const dispatch = resolveDirectorDispatch(id, undefined);
      expect(dispatch.ok).toBe(true);
      const viaSpawn = resolveSubAgentMaxTurns({
        ...(dispatch.ok && dispatch.profileMaxTurns !== undefined
          ? { profileMaxTurns: dispatch.profileMaxTurns }
          : {}),
      });
      expect(viaSpawn).toBe(pkgMax as number);
      expect(viaSpawn).toBe(viaTask);
    });
  }

  test("non-director dispatch with no explicit maxTurns remains unbounded", () => {
    // No agent/intent resolved to a director means no package budget exists;
    // this is intentional and must not gain a default cap.
    const viaSpawn = resolveSubAgentMaxTurns({});
    expect(viaSpawn).toBe(Infinity);
  });
});
