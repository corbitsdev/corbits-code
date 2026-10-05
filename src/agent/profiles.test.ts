import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadAgentProfiles } from "./profiles.js";
import { defined } from "../../testkit/defined.js";

describe("loadAgentProfiles director overlay", () => {
  test("plugin extraProfiles with a closed director id replace the default", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cl9917-profiles-"));
    try {
      const profiles = await loadAgentProfiles(dir, [
        {
          id: "designer",
          source: "plugin:p1",
          systemPromptRole: "Plugin designer prompt.",
          optionalSkills: ["better-ui"],
        },
      ]);
      const designer = defined(
        profiles.find((p) => p.id === "designer"),
        "designer profile",
      );
      expect(designer.systemPromptRole).toBe("Plugin designer prompt.");
      expect(designer.source).toBe("plugin:p1");
      expect(designer.optionalSkills).toEqual(["better-ui"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("local file with a closed director id replaces the default", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cl9917-profiles-local-"));
    try {
      await writeFile(
        join(dir, "designer.json"),
        JSON.stringify({
          id: "designer",
          systemPromptRole: "Local designer prompt.",
        }),
      );
      const profiles = await loadAgentProfiles(dir);
      const designer = defined(
        profiles.find((p) => p.id === "designer"),
        "designer profile",
      );
      expect(designer.systemPromptRole).toBe("Local designer prompt.");
      expect(designer.source).toBe("local");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
