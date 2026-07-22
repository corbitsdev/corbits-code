import { test, expect, mock, beforeEach } from "bun:test";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { act } from "react";

const mockSaveGlobalSettings = mock(async (_path: string, _settings: unknown) => {});
const mockSaveLocalSettings = mock(async (_path: string, _settings: unknown) => {});
const mockLoadSettings = mock(async (_path: string): Promise<unknown> => null);

// Keep real settings exports (PROVIDER_TIERS, etc.) and only stub I/O so the
// inference-sources import chain still resolves.
const settingsActual = await import("../../../src/config/settings.js");
mock.module("../../../src/config/settings.js", () => ({
  ...settingsActual,
  saveGlobalSettings: mockSaveGlobalSettings,
  saveLocalSettings: mockSaveLocalSettings,
  loadSettings: mockLoadSettings,
  localSettingsPath: (cwd: string) => `${cwd}/.agent/settings.json`,
}));

const indexActual = await import("../../../src/config/index.js");
mock.module("../../../src/config/index.js", () => ({
  ...indexActual,
  buildOpenAISource: (opts: unknown) => opts,
  // Mirror production: keep every non-provider field from the merge base.
  providerCatalogToSettings: (
    _catalog: unknown[],
    defaultProvider: string | undefined,
    existing?: Record<string, unknown>,
  ) => {
    if (existing === undefined) {
      return {
        ...(defaultProvider !== undefined ? { defaultProvider } : {}),
        providers: {},
      };
    }
    const { providers: _p, defaultProvider: _d, ...rest } = existing;
    return {
      ...rest,
      ...(defaultProvider !== undefined ? { defaultProvider } : {}),
      providers: {},
    };
  },
}));

const { useProviderManager } = await import(
  "../../../src/tui/hooks/use-provider-manager.js"
);

import type { UseProviderManagerArgs, ProviderManagerController } from "../../../src/tui/hooks/use-provider-manager.js";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

const BASE_CATALOG = [
  { name: "openai", baseURL: "https://api.openai.com/v1", apiKey: "sk-test", models: ["gpt-4o", "gpt-3.5-turbo"] },
  { name: "anthropic", baseURL: "https://api.anthropic.com/v1", apiKey: "sk-ant", models: ["claude-3-opus"] },
];

function makeAgent() {
  return { setSources: mock((_sources: unknown, _default: string) => {}) };
}

function makeArgs(overrides: Partial<UseProviderManagerArgs> = {}): UseProviderManagerArgs {
  const base: UseProviderManagerArgs = {
    initialProvider: "openai",
    initialModel: "gpt-4o",
    initialCatalog: BASE_CATALOG,
    initialGlobalDefaultProvider: "openai",
    cwd: "/repo",
    globalSettingsPath: "/home/.agent/settings.json",
    getSessionId: () => "test-session",
    agent: makeAgent() as unknown as UseProviderManagerArgs["agent"],
    onMessage: mock((_msg: string) => {}),
  };
  return { ...base, ...overrides };
}

let capturedCtrl: ProviderManagerController;

function CapturingHarness({ args }: { args: UseProviderManagerArgs }) {
  const ctrl = useProviderManager(args);
  capturedCtrl = ctrl;
  return (
    <Text>
      {JSON.stringify({
        provider: ctrl.provider,
        model: ctrl.model,
        catalogLen: ctrl.providerCatalog.length,
        globalDefaultProvider: ctrl.globalDefaultProvider,
      })}
    </Text>
  );
}

beforeEach(() => {
  mockSaveGlobalSettings.mockClear();
  mockSaveLocalSettings.mockClear();
  mockLoadSettings.mockClear();
  mockLoadSettings.mockImplementation(async () => null);
});

test("initial state: provider and model match initial values", () => {
  const args = makeArgs();
  const { lastFrame } = render(<CapturingHarness args={args} />);
  const state = JSON.parse(lastFrame()!);
  expect(state.provider).toBe("openai");
  expect(state.model).toBe("gpt-4o");
  expect(state.catalogLen).toBe(2);
});

test("applySelection with valid provider updates provider/model, calls setSource and onMessage", async () => {
  const onMessage = mock((_msg: string) => {});
  const agent = makeAgent();
  const args = makeArgs({ onMessage, agent: agent as unknown as UseProviderManagerArgs["agent"] });
  const { lastFrame } = render(<CapturingHarness args={args} />);

  await act(async () => {
    capturedCtrl.applySelection("anthropic", "claude-3-opus", undefined);
  });

  const state = JSON.parse(lastFrame()!);
  expect(state.provider).toBe("anthropic");
  expect(state.model).toBe("claude-3-opus");
  expect(agent.setSources).toHaveBeenCalled();
  expect(onMessage).toHaveBeenCalledWith(expect.stringContaining("Now using anthropic"));
});

test("applySelection with unknown provider calls onMessage with 'no longer configured', does not update state", async () => {
  const onMessage = mock((_msg: string) => {});
  const agent = makeAgent();
  const args = makeArgs({ onMessage, agent: agent as unknown as UseProviderManagerArgs["agent"] });
  const { lastFrame } = render(<CapturingHarness args={args} />);

  await act(async () => {
    capturedCtrl.applySelection("nonexistent", "some-model", undefined);
  });

  const state = JSON.parse(lastFrame()!);
  expect(state.provider).toBe("openai");
  expect(state.model).toBe("gpt-4o");
  expect(onMessage).toHaveBeenCalledWith(expect.stringContaining("no longer configured"));
  expect(agent.setSources).not.toHaveBeenCalled();
});

test("persistSelection applies selection and calls saveLocalSettings", async () => {
  const onMessage = mock((_msg: string) => {});
  const args = makeArgs({ onMessage });
  const { lastFrame } = render(<CapturingHarness args={args} />);

  await act(async () => {
    capturedCtrl.persistSelection("anthropic", "claude-3-opus", undefined);
  });
  await tick();

  const state = JSON.parse(lastFrame()!);
  expect(state.provider).toBe("anthropic");
  expect(state.model).toBe("claude-3-opus");
  expect(mockSaveLocalSettings).toHaveBeenCalledWith(
    "/repo/.agent/settings.json",
    { provider: "anthropic", model: "claude-3-opus" },
  );
});

test("applySelection threads reasoning effort into the source and state", async () => {
  const agent = makeAgent();
  const args = makeArgs({ agent: agent as unknown as UseProviderManagerArgs["agent"] });
  render(<CapturingHarness args={args} />);

  await act(async () => {
    capturedCtrl.applySelection("anthropic", "claude-3-opus", "high");
  });

  expect(capturedCtrl.reasoningEffort).toBe("high");
  expect(agent.setSources).toHaveBeenCalled();
});

test("persistSelection with effort writes reasoningEffort to local settings", async () => {
  const args = makeArgs();
  render(<CapturingHarness args={args} />);

  await act(async () => {
    capturedCtrl.persistSelection("anthropic", "claude-3-opus", "medium");
  });
  await tick();

  expect(mockSaveLocalSettings).toHaveBeenCalledWith(
    "/repo/.agent/settings.json",
    { provider: "anthropic", model: "claude-3-opus", reasoningEffort: "medium" },
  );
});

test("persistSelection with no override omits reasoningEffort from local settings", async () => {
  const args = makeArgs({ initialReasoningEffort: "high" });
  render(<CapturingHarness args={args} />);

  await act(async () => {
    capturedCtrl.persistSelection("anthropic", "claude-3-opus", undefined);
  });
  await tick();

  expect(mockSaveLocalSettings).toHaveBeenCalledWith(
    "/repo/.agent/settings.json",
    { provider: "anthropic", model: "claude-3-opus" },
  );
});

test("upsertProvider with name conflict returns error and does not update state", async () => {
  const args = makeArgs();
  render(<CapturingHarness args={args} />);

  let result: ReturnType<ProviderManagerController["upsertProvider"]>;
  await act(async () => {
    result = capturedCtrl.upsertProvider({
      name: "anthropic",
      baseURL: "https://api.anthropic.com/v1",
      apiKey: "sk-new",
      models: ["claude-3-opus"],
    });
  });

  expect(result!.ok).toBe(false);
  expect((result! as { ok: false; error: string }).error).toContain("already exists");
});

test("upsertProvider with missing API key returns error", async () => {
  const args = makeArgs();
  render(<CapturingHarness args={args} />);

  let result: ReturnType<ProviderManagerController["upsertProvider"]>;
  await act(async () => {
    result = capturedCtrl.upsertProvider({
      name: "newprovider",
      baseURL: "https://api.newprovider.com/v1",
      models: ["model-a"],
    });
  });

  expect(result!.ok).toBe(false);
  expect((result! as { ok: false; error: string }).error).toContain("API key is required");
});

test("upsertProvider with no models returns error", async () => {
  const args = makeArgs();
  render(<CapturingHarness args={args} />);

  let result: ReturnType<ProviderManagerController["upsertProvider"]>;
  await act(async () => {
    result = capturedCtrl.upsertProvider({
      name: "newprovider",
      baseURL: "https://api.newprovider.com/v1",
      apiKey: "sk-new",
      models: [],
    });
  });

  expect(result!.ok).toBe(false);
  expect((result! as { ok: false; error: string }).error).toContain("at least one model");
});

test("upsertProvider success adds to catalog, calls setSource, saveLocalSettings, saveGlobalSettings", async () => {
  const agent = makeAgent();
  const args = makeArgs({ agent: agent as unknown as UseProviderManagerArgs["agent"] });
  const { lastFrame } = render(<CapturingHarness args={args} />);

  let result: ReturnType<ProviderManagerController["upsertProvider"]>;
  await act(async () => {
    result = capturedCtrl.upsertProvider({
      name: "mistral",
      baseURL: "https://api.mistral.ai/v1",
      apiKey: "sk-mis",
      models: ["mistral-large"],
    });
  });
  await tick();

  expect(result!.ok).toBe(true);
  const state = JSON.parse(lastFrame()!);
  expect(state.catalogLen).toBe(3);
  expect(agent.setSources).toHaveBeenCalled();
  expect(mockSaveLocalSettings).toHaveBeenCalled();
  expect(mockSaveGlobalSettings).toHaveBeenCalled();
});

test("deleteProvider with only one provider calls onMessage and leaves catalog unchanged", async () => {
  const onMessage = mock((_msg: string) => {});
  const singleCatalog = [
    { name: "openai", baseURL: "https://api.openai.com/v1", apiKey: "sk-test", models: ["gpt-4o"] },
  ];
  const args = makeArgs({ initialCatalog: singleCatalog, onMessage });
  const { lastFrame } = render(<CapturingHarness args={args} />);

  await act(async () => {
    capturedCtrl.deleteProvider("openai");
  });

  const state = JSON.parse(lastFrame()!);
  expect(state.catalogLen).toBe(1);
  expect(onMessage).toHaveBeenCalledWith(expect.stringContaining("Cannot remove the last provider"));
});

test("deleteProvider success removes from catalog and calls saveGlobalSettings", async () => {
  const args = makeArgs();
  const { lastFrame } = render(<CapturingHarness args={args} />);

  await act(async () => {
    capturedCtrl.deleteProvider("anthropic");
  });
  await tick();

  const state = JSON.parse(lastFrame()!);
  expect(state.catalogLen).toBe(1);
  expect(mockSaveGlobalSettings).toHaveBeenCalled();
});

test("provider save merges plugins from on-disk settings, not only session-start snapshot", async () => {
  // Session started without plugins; mid-session /plugins wrote them to disk.
  // A later provider save must not stomp that enablement with initialSettings.
  mockLoadSettings.mockImplementation(async () => ({
    providers: {
      openai: { baseURL: "https://api.openai.com/v1", apiKey: "sk-test", models: ["gpt-4o"] },
    },
    plugins: { "path-plugin": { enabled: true } },
    pluginPaths: ["/abs/plugins/path-plugin"],
  }));

  const args = makeArgs({
    initialSettings: {
      providers: {
        openai: { baseURL: "https://api.openai.com/v1", apiKey: "sk-test", models: ["gpt-4o"] },
      },
    },
  });
  render(<CapturingHarness args={args} />);

  await act(async () => {
    capturedCtrl.upsertProvider({
      name: "mistral",
      baseURL: "https://api.mistral.ai/v1",
      apiKey: "sk-mis",
      models: ["mistral-large"],
    });
  });
  await tick();

  expect(mockLoadSettings).toHaveBeenCalledWith("/home/.agent/settings.json");
  expect(mockSaveGlobalSettings).toHaveBeenCalled();
  const saved = mockSaveGlobalSettings.mock.calls[0]![1] as {
    plugins?: Record<string, { enabled?: boolean }>;
    pluginPaths?: string[];
  };
  expect(saved.plugins).toEqual({ "path-plugin": { enabled: true } });
  expect(saved.pluginPaths).toEqual(["/abs/plugins/path-plugin"]);
});

test("provider save fails closed when on-disk settings cannot be loaded", async () => {
  mockLoadSettings.mockImplementation(async () => {
    throw new Error("Invalid JSON in settings file");
  });
  const onMessage = mock((_msg: string) => {});
  const args = makeArgs({ onMessage });
  render(<CapturingHarness args={args} />);

  await act(async () => {
    capturedCtrl.upsertProvider({
      name: "mistral",
      baseURL: "https://api.mistral.ai/v1",
      apiKey: "sk-mis",
      models: ["mistral-large"],
    });
  });
  await tick();

  expect(mockSaveGlobalSettings).not.toHaveBeenCalled();
  expect(onMessage).toHaveBeenCalledWith(expect.stringContaining("saving failed"));
});

test("tier save merges plugins from on-disk settings", async () => {
  mockLoadSettings.mockImplementation(async () => ({
    providers: {
      openai: { baseURL: "https://api.openai.com/v1", apiKey: "sk-test", models: ["gpt-4o"] },
    },
    plugins: { cmd: { enabled: true } },
    pluginPaths: ["/abs/cmd"],
  }));
  const args = makeArgs({
    initialSettings: {
      providers: {
        openai: { baseURL: "https://api.openai.com/v1", apiKey: "sk-test", models: ["gpt-4o"] },
      },
    },
  });
  render(<CapturingHarness args={args} />);

  await act(async () => {
    capturedCtrl.saveTierAssignment("fast", "openai", "gpt-4o");
  });
  await tick();

  expect(mockLoadSettings).toHaveBeenCalled();
  const saved = mockSaveGlobalSettings.mock.calls[0]![1] as {
    plugins?: Record<string, { enabled?: boolean }>;
    tiers?: Record<string, unknown>;
  };
  expect(saved.plugins).toEqual({ cmd: { enabled: true } });
  expect(saved.tiers).toBeDefined();
});
