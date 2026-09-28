import { expect, test } from "bun:test";
import { join } from "node:path";

import { loadPluginEntry } from "./loader.js";
import { resolveAgentPluginProfiles } from "./agent-plugins.js";
import { defined } from "../testkit/defined.js";

const pluginRoot = join(
  import.meta.dirname,
  "../../fixtures/plugins/example-agent",
);

test("example-agent plugin loads scout profile when enabled", async () => {
  const mod = defined(await loadPluginEntry(pluginRoot), "plugin module");
  expect(mod.manifest?.id).toBe("example-agent");
  expect(mod.manifest?.kind).toBe("agent");

  const profiles = await resolveAgentPluginProfiles([mod], {
    "example-agent": { enabled: true },
  });
  expect(profiles.map((p) => p.id)).toEqual(["scout"]);
  const scout = profiles[0];
  expect(scout?.capabilities?.mode).toBe("allow");
  expect(scout?.capabilities?.tools).toContain("read_file");
  expect(scout?.capabilities?.tools).not.toContain("run_shell");
});
