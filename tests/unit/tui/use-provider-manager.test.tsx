import { test, expect, mock, beforeEach } from "bun:test";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { act } from "react";

const mockSaveGlobalSettings = mock(async (_path: string, _settings: unknown) => {});
const mockSaveLocalSettings = mock(async (_path: string, _settings: unknown) => {});

mock.module("../../../src/config/settings.js", () => ({
  saveGlobalSettings: mockSaveGlobalSettings,
  saveLocalSettings: mockSaveLocalSettings,
  localSettingsPath: (cwd: string) => `${cwd}/.agent/settings.json`,
}));

mock.module("../../../src/config/index.js", () => ({
  buildOpenAISource: (opts: unknown) => opts,
  providerCatalogToSettings: (catalog: unknown[], defaultProvider: string | undefined) => ({
    providers: {},
    defaultProvider,
  }),
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
  return { setSource: mock((_source: unknown) => {}) };
}

function makeArgs(overrides: Partial<UseProviderManagerArgs> = {}): UseProviderManagerArgs {
  return {
    initialProvider: "openai",
    initialModel: "gpt-4o",
    initialCatalog: BASE_CATALOG,
    initialGlobalDefaultProvider: "openai",
    cwd: "/repo",
    globalSettingsPath: "/home/.agent/settings.json",
    agent: makeAgent() as unknown as UseProviderManagerArgs["agent"],
    onMessage: mock((_msg: string) => {}),
    ...overrides,
  };
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
    capturedCtrl.applySelection("anthropic", "claude-3-opus");
  });

  const state = JSON.parse(lastFrame()!);
  expect(state.provider).toBe("anthropic");
  expect(state.model).toBe("claude-3-opus");
  expect(agent.setSource).toHaveBeenCalled();
  expect(onMessage).toHaveBeenCalledWith(expect.stringContaining("Now using anthropic"));
});

test("applySelection with unknown provider calls onMessage with 'no longer configured', does not update state", async () => {
  const onMessage = mock((_msg: string) => {});
  const agent = makeAgent();
  const args = makeArgs({ onMessage, agent: agent as unknown as UseProviderManagerArgs["agent"] });
  const { lastFrame } = render(<CapturingHarness args={args} />);

  await act(async () => {
    capturedCtrl.applySelection("nonexistent", "some-model");
  });

  const state = JSON.parse(lastFrame()!);
  expect(state.provider).toBe("openai");
  expect(state.model).toBe("gpt-4o");
  expect(onMessage).toHaveBeenCalledWith(expect.stringContaining("no longer configured"));
  expect(agent.setSource).not.toHaveBeenCalled();
});

test("persistSelection applies selection and calls saveLocalSettings", async () => {
  const onMessage = mock((_msg: string) => {});
  const args = makeArgs({ onMessage });
  const { lastFrame } = render(<CapturingHarness args={args} />);

  await act(async () => {
    capturedCtrl.persistSelection("anthropic", "claude-3-opus");
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
  expect(agent.setSource).toHaveBeenCalledWith(expect.objectContaining({ reasoningEffort: "high" }));
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
  expect(agent.setSource).toHaveBeenCalled();
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
