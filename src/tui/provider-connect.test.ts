import { describe, test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHarness } from "./harness.js";
import { connectProviderInline } from "./provider-connect.js";
import { loadSettings } from "../config/settings.js";

// The mid-session "connect a new provider" flow shares its persistence and
// validation with first-run onboarding (see provider-setup-submit.ts) — this
// pins that an empty key on a key-required preset is rejected here too,
// rather than silently downgraded to a keyless credential.
describe("connectProviderInline", () => {
  test("rejects an empty key on a key-required preset without persisting", async () => {
    const dir = await mkdtemp(join(tmpdir(), "provider-connect-"));
    const settingsPath = join(dir, "settings.json");
    try {
      const harness = await createHarness({ width: 80, height: 30 });
      const resultPromise = connectProviderInline({
        providerId: "openai",
        settingsPath,
        localSettingsPath: join(dir, "local.json"),
        existing: null,
        createRenderer: async () => harness.renderer,
      });
      await harness.renderOnce();

      // initialProviderId lands on the instance-name step first.
      harness.pressKey("Enter");
      await harness.renderOnce();
      // Leave the api key blank.
      harness.pressKey("Enter");
      await harness.renderOnce();
      // Model step: accept the default.
      harness.pressKey("Enter");
      await harness.renderOnce();
      // The rejection is thrown from the async onSubmit handler.
      await new Promise((r) => setTimeout(r, 0));
      await harness.renderOnce();

      const frame = harness.captureCharFrame();
      expect(frame).toContain("requires an api key");

      harness.pressKey("Ctrl+C");
      const result = await resultPromise;
      expect(result.connected).toBe(false);
      expect(await loadSettings(settingsPath)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
