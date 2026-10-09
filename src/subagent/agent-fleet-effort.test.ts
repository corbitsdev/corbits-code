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
});

describe("deepseek-v4-flash coder=low bake-in (CL-10242)", () => {
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

  test("coder pins low on the wire while reviewer/explorer keep their role defaults", async () => {
    expect(await captureEffort("coder")).toBe("low");
    expect(await captureEffort("reviewer")).toBe("high");
    expect(await captureEffort("explorer")).toBe("medium");
  });
});
