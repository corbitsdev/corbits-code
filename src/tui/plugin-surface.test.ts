import { describe, expect, test } from "bun:test";

import type { PluginModule } from "../plugins/loader.js";
import { isPluginEnabledForSurface } from "./plugin-surface.js";

const bundledSkills: PluginModule = {
  origin: "repo",
  manifest: {
    id: "corbits-skills",
    name: "Corbits Skills",
    kind: "command",
    defaultEnabled: true,
  },
};

describe("isPluginEnabledForSurface", () => {
  test("projects an unknown plugin as disabled", () => {
    expect(isPluginEnabledForSurface(undefined, {})).toBe(false);
  });

  test("projects a bundled default-on plugin as enabled without settings", () => {
    expect(isPluginEnabledForSurface(bundledSkills, {})).toBe(true);
  });

  test("projects explicit disabled and enabled settings", () => {
    expect(
      isPluginEnabledForSurface(bundledSkills, {
        "corbits-skills": { enabled: false },
      }),
    ).toBe(false);
    expect(
      isPluginEnabledForSurface(bundledSkills, {
        "corbits-skills": { enabled: true },
      }),
    ).toBe(true);
  });
});
