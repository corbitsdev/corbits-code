import { describe, test, expect, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OAuthScopeCheckResult } from "../auth/oauth-scope-check.js";
import { COMMAND_NAME } from "../branding.js";
import type { Telemetry, TelemetryEvent } from "../telemetry/index.js";
import { withMockedModule } from "../../testkit/mock-module.js";

// The oauth branch probes provider scope over the network; stub the check so
// these tests exercise the handler's own branching without a live call.
let scopeCheckResult: OAuthScopeCheckResult = { status: "ok" };
const scopeCheckCalls: unknown[][] = [];
const connectionChecks: unknown[] = [];
await withMockedModule(
  import.meta.resolve("../auth/oauth-scope-check.js"),
  (real: typeof import("../auth/oauth-scope-check.js")) => ({
    ...real,
    checkOAuthProviderScope: async (...args: unknown[]) => {
      scopeCheckCalls.push(args);
      return scopeCheckResult;
    },
  }),
);
await withMockedModule(
  import.meta.resolve("../provider/validate-connection.js"),
  (real: typeof import("../provider/validate-connection.js")) => ({
    ...real,
    validateProviderConnection: async (args: unknown) => {
      connectionChecks.push(args);
      return { ok: true as const };
    },
  }),
);

const { buildProviderSubmitHandler } = await import("./provider/submit.js");
const { createGlobalSettingsWriter, persistGlobalHTTPMCPServer } =
  await import("../mcp/add-server.js");
const {
  loadLocalSettings,
  loadSettings,
  localSettingsPath,
  resolveLocalSettingsPath,
} = await import("../config/settings.js");
import type {
  OAuthResult,
  ProviderFormValues,
  SubmitPhase,
} from "./provider/types.js";

const noopSetPhase = (_phase: SubmitPhase): void => undefined;
const stagedCodexTokens = {
  access: "staged-access",
  refresh: "staged-refresh",
  expiresAt: 10_000,
  accountId: "staged-account",
};

function stagedCodexOAuth(
  commit: () => Promise<void> = async () => undefined,
): OAuthResult {
  return {
    kind: "codex",
    providerName: "codex/work",
    tokens: stagedCodexTokens,
    commit,
  };
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "provider-setup-submit-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("buildProviderSubmitHandler", () => {
  test.each([
    { reasoningEfforts: [], defaultReasoningEffort: "none" },
    { reasoningEfforts: ["low"], defaultReasoningEffort: "max" },
    { reasoningEfforts: ["low"], defaultReasoningEffort: "" },
  ])(
    "refuses saving invalid custom reasoning controls: %j",
    async (reasoning) => {
      let writes = 0;
      const submit = buildProviderSubmitHandler(
        "/unused",
        null,
        null,
        async (apply) => {
          writes += 1;
          return apply({ providers: {} });
        },
      );
      await expect(
        submit(
          {
            name: "custom",
            baseURL: "https://custom.example/v1",
            apiKey: "",
            model: "custom-model",
            oauthProfile: "",
            contextWindow: "",
            maxTokens: "",
            temperature: "",
            topP: "",
            ...reasoning,
            reasoningEfforts: [...reasoning.reasoningEfforts],
          },
          noopSetPhase,
          { skipValidation: true },
        ),
      ).rejects.toThrow(/reasoning effort/i);
      expect(writes).toBe(0);
    },
  );

  test.each(["preset", "oauth"] as const)(
    "%s ignores stale hidden custom numeric fields",
    async (pathKind) => {
      await withTempDir(async (dir) => {
        const path = join(dir, "settings.json");
        let committed = false;
        const submit = buildProviderSubmitHandler(path, null, null);
        await submit(
          {
            name: "openai/work",
            baseURL: "https://api.example/v1",
            apiKey: "test-key",
            model: "test-model",
            oauthProfile: "work",
            reasoningEfforts: ["low"],
            defaultReasoningEffort: "low",
            contextWindow: "not-a-number",
            maxTokens: "-1",
            temperature: "0.7",
            topP: "0.9",
          },
          noopSetPhase,
          pathKind === "preset"
            ? {
                skipValidation: true,
                preset: {
                  id: "openai",
                  models: ["test-model"],
                  anthropic: false,
                  opencodeGo: false,
                },
              }
            : {
                skipValidation: true,
                oauth: stagedCodexOAuth(async () => {
                  committed = true;
                }),
              },
        );
        const provider = (await loadSettings(path))?.providers[
          pathKind === "preset" ? "openai/work" : "codex/work"
        ];
        expect(provider).toBeDefined();
        for (const field of [
          "contextWindow",
          "maxTokens",
          "temperature",
          "topP",
        ] as const) {
          expect(provider?.[field]).toBeUndefined();
        }
        expect(committed).toBe(pathKind === "oauth");
      });
    },
  );

  test.each([
    ["contextWindow", "0"],
    ["contextWindow", "-1"],
    ["contextWindow", "12.5"],
    ["maxTokens", "0"],
    ["maxTokens", "-1"],
    ["maxTokens", "12.5"],
    ["maxTokens", "Infinity"],
    ["maxTokens", "not-a-number"],
    ["temperature", "-0.1"],
    ["temperature", "2.1"],
    ["topP", "-0.1"],
    ["topP", "1.1"],
  ] as const)(
    "custom submit rejects invalid %s=%s before persistence",
    async (field, value) => {
      let writes = 0;
      const probes = connectionChecks.length;
      const submit = buildProviderSubmitHandler(
        "/tmp/unused-custom-provider-settings.json",
        null,
        null,
        async (apply) => {
          writes++;
          return apply({ providers: {} });
        },
      );
      await expect(
        submit(
          {
            name: "custom",
            baseURL: "https://custom.example/v1",
            apiKey: "",
            model: "test-model",
            oauthProfile: "",
            reasoningEfforts: ["low"],
            defaultReasoningEffort: "low",
            contextWindow: "",
            maxTokens: "",
            temperature: "",
            topP: "",
            [field]: value,
          },
          noopSetPhase,
          { skipValidation: false },
        ),
      ).rejects.toThrow();
      expect(writes).toBe(0);
      expect(connectionChecks.length).toBe(probes);
    },
  );

  test("custom submit rejects simultaneous sampling options before persistence", async () => {
    let writes = 0;
    const submit = buildProviderSubmitHandler(
      "/tmp/unused-custom-provider-settings.json",
      null,
      null,
      async (apply) => {
        writes++;
        return apply({ providers: {} });
      },
    );
    await expect(
      submit(
        {
          name: "custom",
          baseURL: "https://custom.example/v1",
          apiKey: "",
          model: "test-model",
          oauthProfile: "",
          reasoningEfforts: ["low"],
          defaultReasoningEffort: "low",
          contextWindow: "",
          maxTokens: "",
          temperature: "0",
          topP: "0",
        },
        noopSetPhase,
        { skipValidation: true },
      ),
    ).rejects.toThrow();
    expect(writes).toBe(0);
  });

  test("custom numeric fields round-trip, preserve zero sampling, and clear on blank edit", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "settings.json");
      const values: ProviderFormValues = {
        name: "custom",
        baseURL: "https://custom.example/v1",
        apiKey: "",
        model: "test-model",
        oauthProfile: "",
        reasoningEfforts: ["low"],
        defaultReasoningEffort: "low",
        contextWindow: "32000",
        maxTokens: "8192",
        temperature: "0",
        topP: "",
      };
      await buildProviderSubmitHandler(path, null, null)(values, noopSetPhase, {
        skipValidation: true,
      });
      const saved = await loadSettings(path);
      expect(saved?.providers["custom"]).toMatchObject({
        contextWindow: 32_000,
        maxTokens: 8192,
        temperature: 0,
      });
      await buildProviderSubmitHandler(path, saved, null)(
        {
          ...values,
          contextWindow: " ",
          maxTokens: "",
          temperature: "",
        },
        noopSetPhase,
        { skipValidation: true },
      );
      const edited = (await loadSettings(path))?.providers["custom"];
      expect(edited?.contextWindow).toBeUndefined();
      expect(edited?.maxTokens).toBeUndefined();
      expect(edited?.temperature).toBeUndefined();
      expect(edited?.topP).toBeUndefined();
    });
  });

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
        reasoningEfforts: [],
        defaultReasoningEffort: "",
        contextWindow: "",
        maxTokens: "",
        temperature: "",
        topP: "",
      };
      const preset = {
        id: "openai",
        models: ["gpt-5"],
        anthropic: false,
        opencodeGo: false,
      };

      await expect(
        submit(values, noopSetPhase, { skipValidation: false, preset }),
      ).rejects.toThrow(/api key/i);

      expect(await loadSettings(path)).toBeNull();
      expect(await loadLocalSettings(localPath)).toBeNull();
    });
  });

  test("allows an empty key on the manual/custom path (no preset)", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "settings.json");
      const submit = buildProviderSubmitHandler(
        path,
        null,
        localSettingsPath(dir),
      );
      const values: ProviderFormValues = {
        name: "local",
        baseURL: "http://localhost:11434/v1",
        apiKey: "",
        model: "llama3",
        oauthProfile: "",
        reasoningEfforts: ["low"],
        defaultReasoningEffort: "low",
        contextWindow: "",
        maxTokens: "",
        temperature: "",
        topP: "",
      };

      // skipValidation avoids the live connection probe in this unit test.
      await submit(values, noopSetPhase, { skipValidation: true });

      const settings = await loadSettings(path);
      expect(settings?.providers.local?.keyless).toBe(true);
    });
  });

  test("never validates or persists a stale API key for Ollama", async () => {
    await withTempDir(async (dir) => {
      connectionChecks.length = 0;
      const path = join(dir, "settings.json");
      const submit = buildProviderSubmitHandler(
        path,
        null,
        localSettingsPath(dir),
      );
      const values: ProviderFormValues = {
        name: "ollama/default",
        baseURL: "http://remote:11434/",
        apiKey: "sk-stale-secret",
        model: "qwen3",
        oauthProfile: "default",
        reasoningEfforts: [],
        defaultReasoningEffort: "",
        contextWindow: "",
        maxTokens: "",
        temperature: "",
        topP: "",
      };
      const preset = {
        id: "ollama",
        models: [],
        anthropic: false,
        opencodeGo: false,
      };

      await submit(values, noopSetPhase, { skipValidation: false, preset });

      expect(connectionChecks).toEqual([
        { baseURL: "http://remote:11434/v1", apiKey: undefined },
      ]);
      const provider = (await loadSettings(path))?.providers["ollama/default"];
      expect(provider).toMatchObject({
        baseURL: "http://remote:11434",
        keyless: true,
        models: ["qwen3"],
      });
      expect(provider?.apiKey).toBeUndefined();
    });
  });

  test("accepts a pasted Ollama /v1 URL and persists the server root", async () => {
    await withTempDir(async (dir) => {
      connectionChecks.length = 0;
      const path = join(dir, "settings.json");
      const submit = buildProviderSubmitHandler(
        path,
        null,
        localSettingsPath(dir),
      );
      const values: ProviderFormValues = {
        name: "ollama/default",
        baseURL: "http://localhost:11434/v1",
        apiKey: "",
        model: "qwen3",
        oauthProfile: "default",
        reasoningEfforts: [],
        defaultReasoningEffort: "",
        contextWindow: "",
        maxTokens: "",
        temperature: "",
        topP: "",
      };
      const preset = {
        id: "ollama",
        models: ["qwen3", "deepseek-r1"],
        anthropic: false,
        opencodeGo: false,
      };

      await submit(values, noopSetPhase, { skipValidation: false, preset });

      expect(connectionChecks).toEqual([
        { baseURL: "http://localhost:11434/v1", apiKey: undefined },
      ]);
      const provider = (await loadSettings(path))?.providers["ollama/default"];
      expect(provider).toMatchObject({
        baseURL: "http://localhost:11434",
        keyless: true,
        models: ["qwen3", "deepseek-r1"],
        defaultModel: "qwen3",
      });
      expect(provider?.apiKey).toBeUndefined();
    });
  });

  test("preserves a queued MCP add when a provider is persisted from stale runner settings", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "settings.json");
      const writer = createGlobalSettingsWriter(path);
      await persistGlobalHTTPMCPServer(
        writer,
        "linear",
        "https://mcp.linear.app/mcp",
      );
      const staleRunnerSettings = { providers: {} };
      const submit = buildProviderSubmitHandler(
        path,
        staleRunnerSettings,
        localSettingsPath(dir),
        async (apply) => {
          const next = await writer.update(apply);
          if (next === null) throw new Error("global settings are unreadable");
          return next;
        },
      );

      await submit(
        {
          name: "local",
          baseURL: "http://localhost:11434/v1",
          apiKey: "",
          model: "llama3",
          oauthProfile: "",
          reasoningEfforts: ["low"],
          defaultReasoningEffort: "low",
          contextWindow: "",
          maxTokens: "",
          temperature: "",
          topP: "",
        },
        noopSetPhase,
        { skipValidation: true },
      );

      expect(await loadSettings(path)).toMatchObject({
        providers: { local: { keyless: true } },
        mcpServers: [
          { name: "linear", type: "http", url: "https://mcp.linear.app/mcp" },
        ],
      });
    });
  });

  test("marks a save-anyway submit as unverified", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "settings.json");
      const submit = buildProviderSubmitHandler(
        path,
        null,
        localSettingsPath(dir),
      );
      const values: ProviderFormValues = {
        name: "openai",
        baseURL: "https://api.openai.com/v1",
        apiKey: "sk-test-fake",
        model: "gpt-5",
        oauthProfile: "",
        reasoningEfforts: [],
        defaultReasoningEffort: "",
        contextWindow: "",
        maxTokens: "",
        temperature: "",
        topP: "",
      };
      const preset = {
        id: "openai",
        models: ["gpt-5"],
        anthropic: false,
        opencodeGo: false,
      };

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
        reasoningEfforts: [] as string[],
        defaultReasoningEffort: "",
        contextWindow: "",
        maxTokens: "",
        temperature: "",
        topP: "",
      },
      options: {
        skipValidation: true,
        preset: {
          id: "openai",
          models: ["gpt-5"],
          anthropic: false,
          opencodeGo: false,
        },
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
        reasoningEfforts: ["low"] as string[],
        defaultReasoningEffort: "low",
        contextWindow: "",
        maxTokens: "",
        temperature: "",
        topP: "",
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
        reasoningEfforts: [] as string[],
        defaultReasoningEffort: "",
        contextWindow: "",
        maxTokens: "",
        temperature: "",
        topP: "",
      },
      options: {
        skipValidation: true,
        oauth: stagedCodexOAuth(),
      },
      provider: "codex/work",
    },
  ])(
    "$name setup preserves global settings when local path aliases it",
    async (testCase) => {
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
        const submit = buildProviderSubmitHandler(
          settingsPath,
          existing,
          localTarget,
        );

        await submit(testCase.values, noopSetPhase, testCase.options);

        const settings = await loadSettings(settingsPath);
        expect(settings?.defaultProvider).toBe(testCase.provider);
        expect(settings?.providers.existing?.apiKey).toBe("existing-key");
        if (testCase.provider === "codex/work") {
          expect(settings?.providers[testCase.provider]?.defaultModel).toBe(
            testCase.values.model,
          );
          expect(
            settings?.providers[testCase.provider]?.apiKey,
          ).toBeUndefined();
        } else {
          expect(settings?.providers[testCase.provider]).toBeDefined();
        }
      });
    },
  );

  // Every connect path writes the local selection OAuth writes, so a restart
  // resolves to the connected provider/model.
  test.each([
    {
      label: "API-key preset",
      values: {
        name: "openai",
        baseURL: "https://api.openai.com/v1",
        apiKey: "sk-test-fake",
        model: "gpt-5",
        oauthProfile: "",
        reasoningEfforts: [] as string[],
        defaultReasoningEffort: "",
        contextWindow: "",
        maxTokens: "",
        temperature: "",
        topP: "",
      },
      options: {
        skipValidation: true,
        preset: {
          id: "openai",
          models: ["gpt-5"],
          anthropic: false,
          opencodeGo: false,
        },
      },
      provider: "openai",
      model: "gpt-5",
    },
    {
      label: "custom provider",
      values: {
        name: "ollama",
        baseURL: "http://localhost:11434/v1",
        apiKey: "",
        model: "llama3",
        oauthProfile: "",
        reasoningEfforts: ["low"] as string[],
        defaultReasoningEffort: "low",
        contextWindow: "",
        maxTokens: "",
        temperature: "",
        topP: "",
      },
      options: { skipValidation: true },
      provider: "ollama",
      model: "llama3",
    },
    {
      label: "OAuth provider",
      values: {
        name: "",
        baseURL: "https://chatgpt.com/backend-api",
        apiKey: "",
        model: "gpt-5",
        oauthProfile: "work",
        reasoningEfforts: [] as string[],
        defaultReasoningEffort: "",
        contextWindow: "",
        maxTokens: "",
        temperature: "",
        topP: "",
      },
      options: { skipValidation: true, oauth: stagedCodexOAuth() },
      provider: "codex/work",
      model: "gpt-5",
    },
  ])(
    "$label connect persists project-local selection",
    async ({ values, options, provider, model }) => {
      await withTempDir(async (dir) => {
        const path = join(dir, "settings.json");
        const localPath = localSettingsPath(dir);
        const submit = buildProviderSubmitHandler(path, null, localPath);

        await submit(values, noopSetPhase, options);

        const local = await loadLocalSettings(localPath);
        expect(local).toEqual({ provider, model });
        if (values.apiKey !== "") {
          // Secrets stay out of the local selection file.
          expect(JSON.stringify(local)).not.toContain(values.apiKey);
          const global = await loadSettings(path);
          expect(global?.providers[provider]?.apiKey).toBe(values.apiKey);
        }
      });
    },
  );

  describe("OAuth-issued token scope validation (CL-5710)", () => {
    afterEach(() => {
      scopeCheckResult = { status: "ok" };
      scopeCheckCalls.length = 0;
    });

    test("valid scope: onboarding commits staged credentials exactly once", async () => {
      await withTempDir(async (dir) => {
        scopeCheckResult = { status: "ok" };
        const path = join(dir, "settings.json");
        const localPath = localSettingsPath(dir);
        const submit = buildProviderSubmitHandler(path, null, localPath);
        let commits = 0;

        await submit(
          {
            name: "",
            baseURL: "https://chatgpt.com/backend-api",
            apiKey: "",
            model: "gpt-5",
            oauthProfile: "work",
            reasoningEfforts: [],
            defaultReasoningEffort: "",
            contextWindow: "",
            maxTokens: "",
            temperature: "",
            topP: "",
          },
          noopSetPhase,
          {
            skipValidation: false,
            oauth: stagedCodexOAuth(async () => {
              commits += 1;
            }),
          },
        );

        expect(commits).toBe(1);
        expect(scopeCheckCalls).toEqual([
          ["codex", stagedCodexTokens, COMMAND_NAME],
        ]);
        expect(await loadLocalSettings(localPath)).toEqual({
          provider: "codex/work",
          model: "gpt-5",
        });
      });
    });

    test("fresh insufficient scope persists no credential or restart selection", async () => {
      await withTempDir(async (dir) => {
        scopeCheckResult = {
          status: "blocked",
          message:
            "Your Codex sign-in doesn't carry API access. Reconnect Codex and try again.",
        };
        const path = join(dir, "settings.json");
        const localPath = localSettingsPath(dir);
        const submit = buildProviderSubmitHandler(path, null, localPath);
        let committedProfile: string | undefined;

        await expect(
          submit(
            {
              name: "",
              baseURL: "https://chatgpt.com/backend-api",
              apiKey: "",
              model: "gpt-5",
              oauthProfile: "work",
              reasoningEfforts: [],
              defaultReasoningEffort: "",
              contextWindow: "",
              maxTokens: "",
              temperature: "",
              topP: "",
            },
            noopSetPhase,
            {
              skipValidation: false,
              oauth: stagedCodexOAuth(async () => {
                committedProfile = "work";
              }),
            },
          ),
        ).rejects.toThrow(/reconnect codex/i);

        expect(committedProfile).toBeUndefined();
        expect(await loadSettings(path)).toBeNull();
        expect(await loadLocalSettings(localPath)).toBeNull();
      });
    });

    test("failed same-name reauthorization preserves the exact durable profile", async () => {
      await withTempDir(async (dir) => {
        scopeCheckResult = { status: "blocked", message: "Reconnect Codex." };
        const oldProfile = {
          name: "work",
          tokens: {
            access: "old-access",
            refresh: "old-refresh",
            expiresAt: 500,
          },
          createdAt: 10,
        };
        let durableProfile = structuredClone(oldProfile);
        const submit = buildProviderSubmitHandler(
          join(dir, "settings.json"),
          null,
          localSettingsPath(dir),
        );

        await expect(
          submit(
            {
              name: "",
              baseURL: "https://chatgpt.com/backend-api",
              apiKey: "",
              model: "gpt-5",
              oauthProfile: "work",
              reasoningEfforts: [],
              defaultReasoningEffort: "",
              contextWindow: "",
              maxTokens: "",
              temperature: "",
              topP: "",
            },
            noopSetPhase,
            {
              skipValidation: false,
              oauth: stagedCodexOAuth(async () => {
                durableProfile = {
                  name: "work",
                  tokens: stagedCodexTokens,
                  createdAt: 20,
                };
              }),
            },
          ),
        ).rejects.toThrow(/reconnect codex/i);

        expect(durableProfile).toEqual(oldProfile);
      });
    });

    test("check-unavailable commits staged credentials exactly once", async () => {
      await withTempDir(async (dir) => {
        scopeCheckResult = {
          status: "unavailable",
          message: "Couldn't confirm Codex API access right now.",
        };
        const localPath = localSettingsPath(dir);
        const submit = buildProviderSubmitHandler(
          join(dir, "settings.json"),
          null,
          localPath,
        );
        let commits = 0;

        await submit(
          {
            name: "",
            baseURL: "https://chatgpt.com/backend-api",
            apiKey: "",
            model: "gpt-5",
            oauthProfile: "work",
            reasoningEfforts: [],
            defaultReasoningEffort: "",
            contextWindow: "",
            maxTokens: "",
            temperature: "",
            topP: "",
          },
          noopSetPhase,
          {
            skipValidation: false,
            oauth: stagedCodexOAuth(async () => {
              commits += 1;
            }),
          },
        );

        expect(commits).toBe(1);
        expect(await loadLocalSettings(localPath)).toEqual({
          provider: "codex/work",
          model: "gpt-5",
        });
      });
    });

    test("explicit save-anyway skips the scope probe and commits exactly once", async () => {
      await withTempDir(async (dir) => {
        scopeCheckResult = {
          status: "blocked",
          message: "should never be thrown",
        };
        const localPath = localSettingsPath(dir);
        const submit = buildProviderSubmitHandler(
          join(dir, "settings.json"),
          null,
          localPath,
        );
        let commits = 0;

        await submit(
          {
            name: "",
            baseURL: "https://chatgpt.com/backend-api",
            apiKey: "",
            model: "gpt-5",
            oauthProfile: "work",
            reasoningEfforts: [],
            defaultReasoningEffort: "",
            contextWindow: "",
            maxTokens: "",
            temperature: "",
            topP: "",
          },
          noopSetPhase,
          {
            skipValidation: true,
            oauth: stagedCodexOAuth(async () => {
              commits += 1;
            }),
          },
        );

        expect(scopeCheckCalls).toEqual([]);
        expect(commits).toBe(1);
        expect(await loadLocalSettings(localPath)).toEqual({
          provider: "codex/work",
          model: "gpt-5",
        });
      });
    });
  });

  describe("auth_success telemetry", () => {
    function recordingTelemetry(): {
      telemetry: Telemetry;
      events: {
        event: TelemetryEvent;
        properties: Record<string, unknown> | undefined;
      }[];
    } {
      const events: {
        event: TelemetryEvent;
        properties: Record<string, unknown> | undefined;
      }[] = [];
      const telemetry: Telemetry = {
        enabled: true,
        installationId: "test-installation",
        capture: (event, properties) => {
          events.push({ event, properties });
        },
        captureIntentional: () => false,
        flush: async () => undefined,
        discard: () => undefined,
      };
      return { telemetry, events };
    }

    test("OAuth success reports the OAuth kind, not the settings name", async () => {
      await withTempDir(async (dir) => {
        const { telemetry, events } = recordingTelemetry();
        const submit = buildProviderSubmitHandler(
          join(dir, "settings.json"),
          null,
          localSettingsPath(dir),
          undefined,
          telemetry,
        );

        await submit(
          {
            name: "",
            baseURL: "https://chatgpt.com/backend-api",
            apiKey: "",
            model: "gpt-5",
            oauthProfile: "work",
            reasoningEfforts: [],
            defaultReasoningEffort: "",
            contextWindow: "",
            maxTokens: "",
            temperature: "",
            topP: "",
          },
          noopSetPhase,
          { skipValidation: true, oauth: stagedCodexOAuth() },
        );

        expect(events).toEqual([
          { event: "auth_success", properties: { auth_provider: "codex" } },
        ]);
      });
    });

    test("API-key success reports anthropic only for the Anthropic preset", async () => {
      await withTempDir(async (dir) => {
        const { telemetry, events } = recordingTelemetry();
        const submit = buildProviderSubmitHandler(
          join(dir, "settings.json"),
          null,
          localSettingsPath(dir),
          undefined,
          telemetry,
        );
        const values: ProviderFormValues = {
          name: "acmecorp-proxy",
          baseURL: "https://api.acmecorp.example/v1",
          apiKey: "sk-test-fake",
          model: "gpt-5",
          oauthProfile: "",
          reasoningEfforts: [],
          defaultReasoningEffort: "",
          contextWindow: "",
          maxTokens: "",
          temperature: "",
          topP: "",
        };

        await submit(values, noopSetPhase, {
          skipValidation: true,
          preset: {
            id: "openai",
            models: ["gpt-5"],
            anthropic: false,
            opencodeGo: false,
          },
        });

        expect(events).toEqual([
          { event: "auth_success", properties: { auth_provider: "other" } },
        ]);
      });
    });

    test("failed validation emits no auth_success", async () => {
      await withTempDir(async (dir) => {
        const { telemetry, events } = recordingTelemetry();
        const submit = buildProviderSubmitHandler(
          join(dir, "settings.json"),
          null,
          localSettingsPath(dir),
          undefined,
          telemetry,
        );

        await expect(
          submit(
            {
              name: "openai",
              baseURL: "https://api.openai.com/v1",
              apiKey: "",
              model: "gpt-5",
              oauthProfile: "",
              reasoningEfforts: [],
              defaultReasoningEffort: "",
              contextWindow: "",
              maxTokens: "",
              temperature: "",
              topP: "",
            },
            noopSetPhase,
            {
              skipValidation: false,
              preset: {
                id: "openai",
                models: ["gpt-5"],
                anthropic: false,
                opencodeGo: false,
              },
            },
          ),
        ).rejects.toThrow(/api key/i);

        expect(events).toEqual([]);
      });
    });
  });
});
