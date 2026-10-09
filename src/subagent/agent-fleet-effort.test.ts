import { afterEach, describe, expect, test } from "bun:test";
import type { AgentProfile } from "../agent/profile-types.js";
import type { ReasoningEffort } from "../provider/reasoning-effort.js";
import type { ProviderCatalogEntry } from "../config/index.js";
import { buildSubagentSources } from "../config/inference-sources.js";
import { clearSourceCredentials } from "../config/source-credentials.js";
import { createSpawnAgentTool } from "./agent-fleet.js";
import {
  callFleetToolRaw,
  createFleetDeps,
  fleetTools,
} from "./fleet-test-harness.js";
import type { RunSubAgentParams } from "./types.js";

afterEach(clearSourceCredentials);

describe("custom worker efforts", () => {
  const provider: ProviderCatalogEntry = {
    name: "custom",
    baseURL: "https://custom.example/v1",
    keyless: true,
    models: ["custom-model"],
    reasoningEfforts: ["low", "max"],
    defaultReasoningEffort: "max",
  };

  test.each([
    { parent: undefined, pin: undefined, expected: "low" },
    { parent: "max" as const, pin: undefined, expected: "max" },
    { parent: "high" as const, pin: "max" as const, expected: "max" },
  ])(
    "role cascade respects the enabled set: %j",
    async ({ parent, pin, expected }) => {
      let worker: RunSubAgentParams | undefined;
      const profiles: AgentProfile[] =
        pin === undefined
          ? []
          : [
              {
                id: "custom-leaf",
                inference: {
                  mode: "pin",
                  order: [
                    {
                      provider: provider.name,
                      model: "custom-model",
                      reasoningEffort: pin,
                    },
                  ],
                },
              },
            ];
      const deps = createFleetDeps(
        async (params) => {
          worker = params;
          return { report: "done" };
        },
        {
          settings: { providers: { custom: provider } },
          catalog: [provider],
          profiles,
        },
      );
      deps.provider = {
        providerName: provider.name,
        baseURL: provider.baseURL,
        model: "custom-model",
        ...(parent === undefined ? {} : { reasoningEffort: parent }),
      };
      const result = await callFleetToolRaw(createSpawnAgentTool(deps), {
        description: "inspect",
        prompt: "inspect",
        ...(pin === undefined
          ? { intent: "explore" }
          : { agent: "custom-leaf" }),
      });
      expect(result.isError).not.toBe(true);
      await callFleetToolRaw(fleetTools(deps).wait, { timeout_ms: 2000 });
      expect(worker?.provider.reasoningEffort).toBe(expected);
      if (worker === undefined) throw new Error("worker did not start");
      const bundle = buildSubagentSources({
        settings: worker.settings,
        catalog: worker.catalog ?? [],
        head: {
          provider: worker.provider.providerName,
          model: worker.provider.model,
        },
        ...(worker.provider.reasoningEffort !== undefined
          ? { reasoningEffort: worker.provider.reasoningEffort }
          : {}),
        sessionId: "worker-session",
      });
      expect(
        bundle.sources[0]?.defaults?.providerOptions?.reasoning_effort,
      ).toBe(expected);
    },
  );

  test("a disabled profile pin fails before starting a worker", async () => {
    let started = false;
    const deps = createFleetDeps(
      async () => {
        started = true;
        return { report: "done" };
      },
      {
        settings: { providers: { custom: provider } },
        catalog: [provider],
        profiles: [
          {
            id: "custom-leaf",
            inference: {
              mode: "pin",
              order: [
                {
                  provider: "custom",
                  model: "custom-model",
                  reasoningEffort: "medium",
                },
              ],
            },
          },
        ],
      },
    );
    const result = await callFleetToolRaw(createSpawnAgentTool(deps), {
      agent: "custom-leaf",
      description: "inspect",
      prompt: "inspect",
    });
    expect(result.isError).toBe(true);
    expect(started).toBe(false);
  });

  test.each([
    { opencodeGo: false, levels: ["medium", "max"] as const },
    { opencodeGo: true, levels: ["max"] as const },
  ])(
    "role default outranks the parent and ignores noncustom declarations: %j",
    async ({ opencodeGo, levels }) => {
      const entry: ProviderCatalogEntry = {
        ...provider,
        opencodeGo,
        reasoningEfforts: [...levels],
      };
      let effort: unknown;
      const deps = createFleetDeps(
        async ({ provider: worker }) => {
          effort = worker.reasoningEffort;
          return { report: "done" };
        },
        { settings: { providers: { custom: entry } }, catalog: [entry] },
      );
      deps.provider = {
        providerName: "custom",
        baseURL: entry.baseURL,
        model: "custom-model",
        reasoningEffort: "max",
      };
      const result = await callFleetToolRaw(createSpawnAgentTool(deps), {
        description: "inspect",
        prompt: "inspect",
        intent: "explore",
      });
      expect(result.isError).not.toBe(true);
      await callFleetToolRaw(fleetTools(deps).wait, { timeout_ms: 2000 });
      expect(effort).toBe("medium");
    },
  );

  // CL-10227: an explicit (operator-chosen) primary effort is a fleet-wide pin
  // that overrides the role default for spawned workers.
  const explicitProvider: ProviderCatalogEntry = {
    ...provider,
    reasoningEfforts: ["none", "high", "max"],
  };
  test.each([
    { parent: "none" as const, expected: "none" },
    { parent: "high" as const, expected: "high" },
  ])(
    "explicit parent %j pins the worker effort",
    async ({ parent, expected }) => {
      let worker: RunSubAgentParams | undefined;
      const deps = createFleetDeps(
        async (params) => {
          worker = params;
          return { report: "done" };
        },
        {
          settings: { providers: { custom: explicitProvider } },
          catalog: [explicitProvider],
        },
      );
      deps.provider = {
        providerName: explicitProvider.name,
        baseURL: explicitProvider.baseURL,
        model: "custom-model",
        reasoningEffort: parent,
        explicitReasoningEffort: true,
      };
      const result = await callFleetToolRaw(createSpawnAgentTool(deps), {
        description: "inspect",
        prompt: "inspect",
        intent: "explore",
      });
      expect(result.isError).not.toBe(true);
      await callFleetToolRaw(fleetTools(deps).wait, { timeout_ms: 2000 });
      expect(worker?.provider.reasoningEffort).toBe(expected);
    },
  );

  test("clamped explicit parent drops the explicit marker (CL-10227)", async () => {
    // An explicit parent `none` on a model whose ladder rejects `none` is
    // clamped onto the supported set (low). The clamped value is derived, not
    // operator-chosen, so the explicit marker must not survive — otherwise the
    // worker would carry a fleet-wide explicit pin it never actually received.
    let worker: RunSubAgentParams | undefined;
    const noNoneProvider: ProviderCatalogEntry = {
      ...provider,
      reasoningEfforts: ["low", "high", "max"],
    };
    const deps = createFleetDeps(
      async (params) => {
        worker = params;
        return { report: "done" };
      },
      {
        settings: { providers: { custom: noNoneProvider } },
        catalog: [noNoneProvider],
      },
    );
    deps.provider = {
      providerName: noNoneProvider.name,
      baseURL: noNoneProvider.baseURL,
      model: "custom-model",
      reasoningEffort: "none",
      explicitReasoningEffort: true,
    };
    const result = await callFleetToolRaw(createSpawnAgentTool(deps), {
      description: "inspect",
      prompt: "inspect",
      intent: "explore",
    });
    expect(result.isError).not.toBe(true);
    await callFleetToolRaw(fleetTools(deps).wait, { timeout_ms: 2000 });
    expect(worker?.provider.reasoningEffort).toBe("low");
    // The clamped value is derived, so the flag is dropped (absent), not `true`.
    expect(worker?.provider.explicitReasoningEffort).toBeUndefined();
  });

  test("explicit parent pin survives the applyResolvedProvider rebuild (CL-10227)", async () => {
    // A profile/director spawn with a resolving inference rebuilds `provider`
    // from settings via applyResolvedProvider. That rebuild must not drop the
    // operator-explicit parent-effort marker — otherwise the operator pin is
    // demoted to a derived parent and the leaf role default (medium) wins,
    // violating the CL-10227 fleet-pin contract. Here the model ladder supports
    // both the parent ("none") and the role default ("medium"), so only the
    // surviving explicit flag can pick "none".
    let worker: RunSubAgentParams | undefined;
    const pinProvider: ProviderCatalogEntry = {
      ...provider,
      reasoningEfforts: ["none", "medium", "max"],
    };
    const deps = createFleetDeps(
      async (params) => {
        worker = params;
        return { report: "done" };
      },
      {
        settings: { providers: { custom: pinProvider } },
        catalog: [pinProvider],
        profiles: [
          {
            id: "custom-leaf",
            inference: {
              mode: "pin",
              order: [
                {
                  provider: pinProvider.name,
                  model: "custom-model",
                },
              ],
            },
          },
        ],
      },
    );
    deps.provider = {
      providerName: pinProvider.name,
      baseURL: pinProvider.baseURL,
      model: "custom-model",
      reasoningEffort: "none",
      explicitReasoningEffort: true,
    };
    const result = await callFleetToolRaw(createSpawnAgentTool(deps), {
      description: "inspect",
      prompt: "inspect",
      agent: "custom-leaf",
    });
    expect(result.isError).not.toBe(true);
    await callFleetToolRaw(fleetTools(deps).wait, { timeout_ms: 2000 });
    // The operator-explicit parent pin ("none") survives the rebuild and beats
    // the leaf role default ("medium").
    expect(worker?.provider.reasoningEffort).toBe("none");
    expect(worker?.provider.explicitReasoningEffort).toBe(true);
  });

  test("explicit effortPin still wins over an explicit parent", async () => {
    // An explicit parent is a fleet pin, but the cascade still lets an explicit
    // effortPin outrank it — the legacy pin-max case stays.
    let worker: RunSubAgentParams | undefined;
    const deps = createFleetDeps(
      async (params) => {
        worker = params;
        return { report: "done" };
      },
      {
        settings: { providers: { custom: explicitProvider } },
        catalog: [explicitProvider],
        profiles: [
          {
            id: "custom-leaf",
            inference: {
              mode: "pin",
              order: [
                {
                  provider: explicitProvider.name,
                  model: "custom-model",
                  reasoningEffort: "max",
                },
              ],
            },
          },
        ],
      },
    );
    deps.provider = {
      providerName: explicitProvider.name,
      baseURL: explicitProvider.baseURL,
      model: "custom-model",
      reasoningEffort: "none",
      explicitReasoningEffort: true,
    };
    const result = await callFleetToolRaw(createSpawnAgentTool(deps), {
      description: "inspect",
      prompt: "inspect",
      agent: "custom-leaf",
    });
    expect(result.isError).not.toBe(true);
    await callFleetToolRaw(fleetTools(deps).wait, { timeout_ms: 2000 });
    expect(worker?.provider.reasoningEffort).toBe("max");
  });
});

describe("deepseek-v4 per-role effort policy (CL-10294)", () => {
  const dsv4: ProviderCatalogEntry = {
    name: "dsv4",
    baseURL: "https://dsv4.example/v1",
    keyless: true,
    models: ["deepseek-v4-flash"],
  };

  async function captureEffort(agent: string): Promise<ReasoningEffort> {
    let worker: RunSubAgentParams | undefined;
    const deps = createFleetDeps(
      async (params) => {
        worker = params;
        return { report: "done" };
      },
      { settings: { providers: { dsv4 } }, catalog: [dsv4] },
    );
    deps.provider = {
      providerName: dsv4.name,
      baseURL: dsv4.baseURL,
      model: "deepseek-v4-flash",
    };
    const spawn = createSpawnAgentTool(deps);
    const args: Record<string, unknown> = {
      description: "inspect",
      prompt: "inspect",
      agent,
    };
    if (agent === "coder" || agent === "reviewer") {
      args.success_criteria = ["done"];
    }
    const result = await callFleetToolRaw(spawn, args);
    expect(result.isError).not.toBe(true);
    await callFleetToolRaw(fleetTools(deps).wait, { timeout_ms: 2000 });
    if (worker === undefined) throw new Error("worker did not start");
    return worker.provider.reasoningEffort as ReasoningEffort;
  }

  test("planner/reviewer/coder max, other leaves xhigh", async () => {
    // V4's native ladder is ["none","xhigh","max"]. coder defaults to max
    // (operator-confirmed, PR #1377); planner/reviewer resolve max. dispatch is
    // the primary session (not a spawned worker) and already defaults to max for
    // V4 via defaultEffortForModel.
    expect(await captureEffort("planner")).toBe("max");
    expect(await captureEffort("reviewer")).toBe("max");
    expect(await captureEffort("coder")).toBe("max");
    expect(await captureEffort("explorer")).toBe("xhigh");
    expect(await captureEffort("artist")).toBe("xhigh");
    expect(await captureEffort("qa-lead")).toBe("xhigh");
    expect(await captureEffort("prober")).toBe("xhigh");
    expect(await captureEffort("designer")).toBe("xhigh");
    expect(await captureEffort("shakespeare")).toBe("xhigh");
    expect(await captureEffort("warden")).toBe("xhigh");
  });

  test("an explicit profile effortPin outranks the V4 role table", async () => {
    let worker: RunSubAgentParams | undefined;
    const deps = createFleetDeps(
      async (params) => {
        worker = params;
        return { report: "done" };
      },
      {
        settings: { providers: { dsv4 } },
        catalog: [dsv4],
        profiles: [
          {
            id: "pinned-coder",
            inference: {
              mode: "pin",
              order: [
                {
                  provider: dsv4.name,
                  model: "deepseek-v4-flash",
                  reasoningEffort: "max",
                },
              ],
            },
          },
        ],
      },
    );
    deps.provider = {
      providerName: dsv4.name,
      baseURL: dsv4.baseURL,
      model: "deepseek-v4-flash",
    };
    const result = await callFleetToolRaw(createSpawnAgentTool(deps), {
      description: "inspect",
      prompt: "inspect",
      agent: "pinned-coder",
    });
    expect(result.isError).not.toBe(true);
    await callFleetToolRaw(fleetTools(deps).wait, { timeout_ms: 2000 });
    if (worker === undefined) throw new Error("worker did not start");
    expect(worker.provider.reasoningEffort).toBe("max");
  });

  test("non-V4 roles are untouched by the V4 table", async () => {
    // A non-V4 model spawns the same director without any V4 role pin — the
    // leaf role default (medium, here clamped to the custom ladder's low) wins.
    let worker: RunSubAgentParams | undefined;
    const nonV4: ProviderCatalogEntry = {
      name: "plain",
      baseURL: "https://plain.example/v1",
      keyless: true,
      models: ["plain-model"],
      reasoningEfforts: ["low", "max"],
    };
    const deps = createFleetDeps(
      async (params) => {
        worker = params;
        return { report: "done" };
      },
      { settings: { providers: { plain: nonV4 } }, catalog: [nonV4] },
    );
    deps.provider = {
      providerName: nonV4.name,
      baseURL: nonV4.baseURL,
      model: "plain-model",
    };
    const result = await callFleetToolRaw(createSpawnAgentTool(deps), {
      description: "inspect",
      prompt: "inspect",
      intent: "explore",
    });
    expect(result.isError).not.toBe(true);
    await callFleetToolRaw(fleetTools(deps).wait, { timeout_ms: 2000 });
    if (worker === undefined) throw new Error("worker did not start");
    expect(worker.provider.reasoningEffort).toBe("low");
  });
});
