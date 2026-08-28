import { describe, test, expect, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OAuthScopeCheckResult } from "../auth/oauth-scope-check.js";
import { withMockedModule } from "../../tests/helpers/mock-module.js";

// The oauth branch probes real provider scope over the network; stub the
// check so these tests exercise buildProviderSubmitHandler's own branching
// (ok / insufficient-scope / unavailable) without a live call.
let scopeCheckResult: OAuthScopeCheckResult = { status: "ok" };
await withMockedModule(
  import.meta.resolve("../auth/oauth-scope-check.js"),
  (real: typeof import("../auth/oauth-scope-check.js")) => ({
    ...real,
    checkOAuthProviderScope: async () => scopeCheckResult,
  }),
);

const { buildProviderSubmitHandler } = await import("./provider-setup-submit.js");
const { loadLocalSettings, loadSettings, localSettingsPath, resolveLocalSettingsPath } =
  await import("../config/settings.js");
import type { ProviderFormValues, SubmitPhase } from "./provider-setup.js";

const noopSetPhase = (_phase: SubmitPhase): void => {};

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "provider-setup-submit-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("buildProviderSubmitHandler", () => {
  test("rejects an empty key on a key-required preset without persisting", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "settings.json");
      const localPath = localSettingsPath(dir);
      const submit = buildProviderSubmitHandler(path, null, localPath);
      const values: ProviderFormValues = {
        name: "openai",
        baseURL: "https://api.openai.com/v1",
        apiKey: "",
        model: "gpt-5",
        oauthProfile: "",
      };
      const preset = { id: "openai", models: ["gpt-5"], anthropic: false, opencodeGo: false };

      await expect(submit(values, noopSetPhase, { skipValidation: false, preset })).rejects.toThrow(
        /api key/i,
      );

      expect(await loadSettings(path)).toBeNull();
      expect(await loadLocalSettings(localPath)).toBeNull();
    });
  });

  test("allows an empty key on the manual/custom path (no preset)", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "settings.json");
      const submit = buildProviderSubmitHandler(path, null, localSettingsPath(dir));
      const values: ProviderFormValues = {
        name: "local",
        baseURL: "http://localhost:11434/v1",
        apiKey: "",
        model: "llama3",
        oauthProfile: "",
      };

      // skipValidation avoids the live connection probe in this unit test.
      await submit(values, noopSetPhase, { skipValidation: true });

      const settings = await loadSettings(path);
      expect(settings?.providers.local?.keyless).toBe(true);
    });
  });

  test("marks a save-anyway submit as unverified", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "settings.json");
      const submit = buildProviderSubmitHandler(path, null, localSettingsPath(dir));
      const values: ProviderFormValues = {
        name: "openai",
        baseURL: "https://api.openai.com/v1",
        apiKey: "sk-test-fake",
        model: "gpt-5",
        oauthProfile: "",
      };
      const preset = { id: "openai", models: ["gpt-5"], anthropic: false, opencodeGo: false };

      await submit(values, noopSetPhase, { skipValidation: true, preset });

      const settings = await loadSettings(path);
      expect(settings?.providers.openai?.verified).toBe(false);
    });
  });

  test.each([
    {
      name: "API-key preset",
      values: {
        name: "openai",
        baseURL: "https://api.openai.com/v1",
        apiKey: "sk-test-fake",
        model: "gpt-5",
        oauthProfile: "",
      },
      options: {
        skipValidation: true,
        preset: { id: "openai", models: ["gpt-5"], anthropic: false, opencodeGo: false },
      },
      provider: "openai",
    },
    {
      name: "custom provider",
      values: {
        name: "ollama",
        baseURL: "http://localhost:11434/v1",
        apiKey: "",
        model: "llama3",
        oauthProfile: "",
      },
      options: { skipValidation: true },
      provider: "ollama",
    },
    {
      name: "OAuth provider",
      values: {
        name: "",
        baseURL: "https://chatgpt.com/backend-api",
        apiKey: "",
        model: "gpt-5",
        oauthProfile: "work",
      },
      options: {
        skipValidation: true,
        oauth: { kind: "codex" as const, providerName: "codex/work", profile: "work" },
      },
      provider: "codex/work",
    },
  ])("$name setup preserves global settings when local path aliases it", async (testCase) => {
    await withTempDir(async (home) => {
      const settingsPath = localSettingsPath(home);
      const localTarget = resolveLocalSettingsPath(home, settingsPath);
      const existing = {
        defaultProvider: "existing",
        providers: {
          existing: {
            baseURL: "https://example.test/v1",
            apiKey: "existing-key",
            models: ["existing-model"],
          },
        },
      };
      const submit = buildProviderSubmitHandler(settingsPath, existing, localTarget);

      await submit(testCase.values, noopSetPhase, testCase.options);

      const settings = await loadSettings(settingsPath);
      expect(settings?.defaultProvider).toBe(testCase.provider);
      expect(settings?.providers.existing?.apiKey).toBe("existing-key");
      if (testCase.provider === "codex/work") {
        expect(settings?.providers[testCase.provider]?.defaultModel).toBe(testCase.values.model);
        expect(settings?.providers[testCase.provider]?.apiKey).toBeUndefined();
      } else {
        expect(settings?.providers[testCase.provider]).toBeDefined();
      }
    });
  });

  test("API-key connect persists project-local selection like OAuth", async () => {
    // CL-5900: API-key path must write the same local selection OAuth writes,
    // so a restart in this repo resolves to the connected provider/model.
    await withTempDir(async (dir) => {
      const path = join(dir, "settings.json");
      const localPath = localSettingsPath(dir);
      const submit = buildProviderSubmitHandler(path, null, localPath);
      const values: ProviderFormValues = {
        name: "openai",
        baseURL: "https://api.openai.com/v1",
        apiKey: "sk-test-fake",
        model: "gpt-5",
        oauthProfile: "",
      };
      const preset = { id: "openai", models: ["gpt-5"], anthropic: false, opencodeGo: false };

      await submit(values, noopSetPhase, { skipValidation: true, preset });

      const local = await loadLocalSettings(localPath);
      expect(local).toEqual({ provider: "openai", model: "gpt-5" });
      // Secrets stay out of the local selection file.
      expect(JSON.stringify(local)).not.toContain("sk-test-fake");
      const global = await loadSettings(path);
      expect(global?.providers.openai?.apiKey).toBe("sk-test-fake");
    });
  });

  test("Custom connect also persists project-local selection", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "settings.json");
      const localPath = localSettingsPath(dir);
      const submit = buildProviderSubmitHandler(path, null, localPath);
      const values: ProviderFormValues = {
        name: "ollama",
        baseURL: "http://localhost:11434/v1",
        apiKey: "",
        model: "llama3",
        oauthProfile: "",
      };

      await submit(values, noopSetPhase, { skipValidation: true });

      const local = await loadLocalSettings(localPath);
      expect(local).toEqual({ provider: "ollama", model: "llama3" });
    });
  });

  test("OAuth connect still persists project-local selection via the shared helper", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "settings.json");
      const localPath = localSettingsPath(dir);
      const submit = buildProviderSubmitHandler(path, null, localPath);
      const values: ProviderFormValues = {
        name: "",
        baseURL: "https://chatgpt.com/backend-api",
        apiKey: "",
        model: "gpt-5",
        oauthProfile: "work",
      };

      await submit(values, noopSetPhase, {
        skipValidation: true,
        oauth: { kind: "codex", providerName: "codex/work", profile: "work" },
      });

      const local = await loadLocalSettings(localPath);
      expect(local).toEqual({ provider: "codex/work", model: "gpt-5" });
    });
  });

  test("restart resolution reads the local selection written by API-key connect", async () => {
    // Regression: after connect, loadLocalSettings must surface the same
    // provider/model pair a subsequent session would resolve against.
    await withTempDir(async (dir) => {
      const path = join(dir, "settings.json");
      const localPath = localSettingsPath(dir);
      const submit = buildProviderSubmitHandler(path, null, localPath);
      await submit(
        {
          name: "anthropic",
          baseURL: "https://api.anthropic.com",
          apiKey: "sk-ant-test",
          model: "claude-sonnet-4",
          oauthProfile: "",
        },
        noopSetPhase,
        {
          skipValidation: true,
          preset: {
            id: "anthropic",
            models: ["claude-sonnet-4"],
            anthropic: true,
            opencodeGo: false,
          },
        },
      );

      // Simulate restart: re-load both files the way config resolution does.
      const global = await loadSettings(path);
      const local = await loadLocalSettings(localPath);
      expect(local?.provider).toBe("anthropic");
      expect(local?.model).toBe("claude-sonnet-4");
      expect(global?.providers.anthropic?.defaultModel).toBe("claude-sonnet-4");
      // Local selection is what wins on restart when present.
      const resolvedProvider = local?.provider ?? global?.defaultProvider;
      const resolvedModel = local?.model ?? global?.providers[resolvedProvider ?? ""]?.defaultModel;
      expect(resolvedProvider).toBe("anthropic");
      expect(resolvedModel).toBe("claude-sonnet-4");
    });
  });

  describe("OAuth-issued token scope validation (CL-5710)", () => {
    afterEach(() => {
      scopeCheckResult = { status: "ok" };
    });

    test("valid scope: onboarding completes", async () => {
      await withTempDir(async (dir) => {
        scopeCheckResult = { status: "ok" };
        const path = join(dir, "settings.json");
        const localPath = localSettingsPath(dir);
        const submit = buildProviderSubmitHandler(path, null, localPath);

        await submit(
          {
            name: "",
            baseURL: "https://chatgpt.com/backend-api",
            apiKey: "",
            model: "gpt-5",
            oauthProfile: "work",
          },
          noopSetPhase,
          {
            skipValidation: false,
            oauth: { kind: "codex", providerName: "codex/work", profile: "work" },
          },
        );

        const local = await loadLocalSettings(localPath);
        expect(local).toEqual({ provider: "codex/work", model: "gpt-5" });
      });
    });

    test("definitively insufficient scope: onboarding is rejected with a setup-attributable message, not a raw adapter error", async () => {
      await withTempDir(async (dir) => {
        scopeCheckResult = {
          status: "insufficient-scope",
          message: "Your Codex sign-in doesn't carry API access. Reconnect Codex and try again.",
        };
        const path = join(dir, "settings.json");
        const localPath = localSettingsPath(dir);
        const submit = buildProviderSubmitHandler(path, null, localPath);

        await expect(
          submit(
            {
              name: "",
              baseURL: "https://chatgpt.com/backend-api",
              apiKey: "",
              model: "gpt-5",
              oauthProfile: "work",
            },
            noopSetPhase,
            {
              skipValidation: false,
              oauth: { kind: "codex", providerName: "codex/work", profile: "work" },
            },
          ),
        ).rejects.toThrow(/reconnect codex/i);

        // Nothing is persisted on a proven scope failure.
        expect(await loadSettings(path)).toBeNull();
        expect(await loadLocalSettings(localPath)).toBeNull();
      });
    });

    test("check-unavailable (network blip): onboarding still completes, not blocked", async () => {
      await withTempDir(async (dir) => {
        scopeCheckResult = {
          status: "unavailable",
          message: "Couldn't confirm Codex API access right now.",
        };
        const path = join(dir, "settings.json");
        const localPath = localSettingsPath(dir);
        const submit = buildProviderSubmitHandler(path, null, localPath);

        await submit(
          {
            name: "",
            baseURL: "https://chatgpt.com/backend-api",
            apiKey: "",
            model: "gpt-5",
            oauthProfile: "work",
          },
          noopSetPhase,
          {
            skipValidation: false,
            oauth: { kind: "codex", providerName: "codex/work", profile: "work" },
          },
        );

        const local = await loadLocalSettings(localPath);
        expect(local).toEqual({ provider: "codex/work", model: "gpt-5" });
      });
    });

    test("skipValidation bypasses the scope probe entirely", async () => {
      await withTempDir(async (dir) => {
        scopeCheckResult = { status: "insufficient-scope", message: "should never be thrown" };
        const path = join(dir, "settings.json");
        const localPath = localSettingsPath(dir);
        const submit = buildProviderSubmitHandler(path, null, localPath);

        await submit(
          {
            name: "",
            baseURL: "https://chatgpt.com/backend-api",
            apiKey: "",
            model: "gpt-5",
            oauthProfile: "work",
          },
          noopSetPhase,
          {
            skipValidation: true,
            oauth: { kind: "codex", providerName: "codex/work", profile: "work" },
          },
        );

        const local = await loadLocalSettings(localPath);
        expect(local).toEqual({ provider: "codex/work", model: "gpt-5" });
      });
    });
  });
});
