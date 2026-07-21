import { test, expect } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config/index.js";
import { resetPricingMetadataRefreshForTests } from "../../src/cost/pricing-metadata.js";

// Rejects immediately instead of touching the network. loadConfig's pricing
// refresh is fire-and-forget, so a resolved run proves only that the injected
// impl was reached — which is exactly the regression this file guards against:
// the default impl performs a real fetch of models.dev from inside the suite.
function offlineFetch(): { impl: typeof fetch; calls: () => number } {
  let count = 0;
  const impl = (() => {
    count++;
    return Promise.reject(new Error("offline"));
  }) as unknown as typeof fetch;
  return { impl, calls: () => count };
}

// Writes a minimal valid global settings file with a single provider so that
// provider resolution succeeds; these tests only exercise flag parsing.
async function withSettings(
  fn: (opts: { cwd: string; globalSettingsPath: string }) => void | Promise<void>,
): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "ic-unit-config-"));
  const globalSettingsPath = join(cwd, "global.json");
  await writeFile(
    globalSettingsPath,
    JSON.stringify({
      defaultProvider: "test-provider",
      providers: {
        "test-provider": {
          baseURL: "http://localhost:1234",
          apiKey: "test-key",
          models: ["test-model"],
        },
      },
    }),
  );
  try {
    await fn({ cwd, globalSettingsPath });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("loadConfig defaults auto mode on", async () => {
  await withSettings(async ({ cwd, globalSettingsPath }) => {
    const { impl } = offlineFetch();
    const config = await loadConfig(["--cwd", cwd, "do something"], {
      globalSettingsPath,
      pricing: { fetchImpl: impl },
    });
    expect(config.auto).toBe(true);
  });
});

test("loadConfig --no-auto disables auto mode", async () => {
  await withSettings(async ({ cwd, globalSettingsPath }) => {
    const { impl } = offlineFetch();
    const config = await loadConfig(["--cwd", cwd, "--no-auto", "do something"], {
      globalSettingsPath,
      pricing: { fetchImpl: impl },
    });
    expect(config.auto).toBe(false);
  });
});

test("loadConfig uses the injected pricing fetchImpl instead of the network", async () => {
  await withSettings(async ({ cwd, globalSettingsPath }) => {
    resetPricingMetadataRefreshForTests();
    const { impl, calls } = offlineFetch();
    await loadConfig(["--cwd", cwd, "do something"], {
      globalSettingsPath,
      pricing: { fetchImpl: impl },
    });
    // The refresh is scheduled fire-and-forget; yield so it kicks off.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls()).toBeGreaterThan(0);
  });
});


