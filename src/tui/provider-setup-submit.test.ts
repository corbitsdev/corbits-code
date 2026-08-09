import { describe, test, expect, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildProviderSubmitHandler } from "./provider-setup-submit.js";
import { loadSettings } from "../config/settings.js";
import type { ProviderFormValues, SubmitPhase } from "./provider-setup.js";

const noopSetPhase = (_phase: SubmitPhase): void => {};

async function withTempSettingsPath(
  run: (path: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "provider-setup-submit-"));
  const path = join(dir, "settings.json");
  try {
    await run(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("buildProviderSubmitHandler", () => {
  test("rejects an empty key on a key-required preset without persisting", async () => {
    await withTempSettingsPath(async (path) => {
      const submit = buildProviderSubmitHandler(path, null, "/tmp/cwd");
      const values: ProviderFormValues = {
        name: "openai",
        baseURL: "https://api.openai.com/v1",
        apiKey: "",
        model: "gpt-5",
      };
      const preset = { id: "openai", models: ["gpt-5"], anthropic: false, opencodeGo: false };

      await expect(
        submit(values, noopSetPhase, { skipValidation: false, preset }),
      ).rejects.toThrow(/api key/i);

      expect(await loadSettings(path)).toBeNull();
    });
  });

  test("allows an empty key on the manual/custom path (no preset)", async () => {
    await withTempSettingsPath(async (path) => {
      const submit = buildProviderSubmitHandler(path, null, "/tmp/cwd");
      const values: ProviderFormValues = {
        name: "local",
        baseURL: "http://localhost:11434/v1",
        apiKey: "",
        model: "llama3",
      };

      // skipValidation avoids the live connection probe in this unit test.
      await submit(values, noopSetPhase, { skipValidation: true });

      const settings = await loadSettings(path);
      expect(settings?.providers.local?.keyless).toBe(true);
    });
  });

  test("marks a save-anyway submit as unverified", async () => {
    await withTempSettingsPath(async (path) => {
      const submit = buildProviderSubmitHandler(path, null, "/tmp/cwd");
      const values: ProviderFormValues = {
        name: "openai",
        baseURL: "https://api.openai.com/v1",
        apiKey: "sk-test-fake",
        model: "gpt-5",
      };
      const preset = { id: "openai", models: ["gpt-5"], anthropic: false, opencodeGo: false };

      await submit(values, noopSetPhase, { skipValidation: true, preset });

      const settings = await loadSettings(path);
      expect(settings?.providers.openai?.verified).toBe(false);
    });
  });
});
