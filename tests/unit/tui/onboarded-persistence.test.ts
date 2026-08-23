import { test, expect } from "bun:test";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markOnboarded, loadSettings } from "../../../src/config/settings.js";

async function tempSettingsPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "corbits-onboarded-"));
  return join(dir, "settings.json");
}

test("markOnboarded sets onboarded:true on an existing global settings file", async () => {
  const path = await tempSettingsPath();
  await writeFile(
    path,
    JSON.stringify({
      defaultProvider: "openai",
      providers: {
        openai: { baseURL: "https://api.openai.com/v1", apiKey: "sk-real", models: ["gpt-4o"] },
      },
    }),
  );

  await markOnboarded(path);

  const loaded = await loadSettings(path);
  expect(loaded?.onboarded).toBe(true);
  expect(loaded?.defaultProvider).toBe("openai");
  expect(loaded?.providers.openai?.apiKey).toBe("sk-real");
});

test("markOnboarded writes a minimal valid file when none exists — no invented providers", async () => {
  const path = await tempSettingsPath();

  await markOnboarded(path);

  const written = JSON.parse(await readFile(path, "utf8"));
  expect(written.onboarded).toBe(true);
  expect(written.providers).toEqual({});
});

test("markOnboarded never persists injected OAuth provider tokens", async () => {
  // The on-disk file holds only a real provider. An in-memory Settings used
  // during resolution would also carry synthetic codex/xai entries with
  // short-lived access tokens; markOnboarded must ignore that and read disk.
  const path = await tempSettingsPath();
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({
      providers: {
        openai: { baseURL: "https://api.openai.com/v1", apiKey: "sk-real", models: ["gpt-4o"] },
      },
    }),
  );

  await markOnboarded(path);

  const raw = await readFile(path, "utf8");
  expect(raw).not.toContain("codex");
  expect(raw).not.toContain("xai");
  expect(raw).not.toContain("oauth");
  expect(raw).not.toContain("access_token");
  const loaded = await loadSettings(path);
  expect(Object.keys(loaded?.providers ?? {})).toEqual(["openai"]);
  expect(loaded?.onboarded).toBe(true);
});
