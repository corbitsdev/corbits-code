import { afterEach, describe, expect, test } from "bun:test";

import type { ProviderCatalogEntry } from "../config/index.js";
import { clearSourceCredentials } from "../config/source-credentials.js";
import { createSpawnAgentTool } from "./agent-fleet.js";
import {
  callFleetToolRaw,
  createFleetDeps,
  fleetTools,
} from "./fleet-test-harness.js";
import type { RunSubAgentParams } from "./types.js";

afterEach(clearSourceCredentials);

const primary: ProviderCatalogEntry = {
  name: "primary",
  baseURL: "https://primary.example/v1",
  keyless: true,
  models: ["parent-model", "other-model"],
};

const secondary: ProviderCatalogEntry = {
  name: "secondary",
  baseURL: "https://secondary.example/v1",
  keyless: true,
  models: ["other-model"],
};

function parentProvider() {
  return {
    providerName: "primary",
    baseURL: primary.baseURL,
    model: "parent-model",
  };
}

describe("named inference profiles at spawn (CL-9880)", () => {
  test("worker inherits the parent default when no profile matches", async () => {
    let worker: RunSubAgentParams | undefined;
    const deps = createFleetDeps(
      async (params) => {
        worker = params;
        return { report: "done" };
      },
      {
        settings: { providers: { primary } },
        catalog: [primary],
      },
    );
    deps.provider = parentProvider();
    const result = await callFleetToolRaw(createSpawnAgentTool(deps), {
      agent: "coder",
      description: "build",
      prompt: "build the thing",
      success_criteria: ["done"],
    });
    expect(result.isError).not.toBe(true);
    await callFleetToolRaw(fleetTools(deps).wait, { timeout_ms: 2000 });
    expect(worker?.provider.providerName).toBe("primary");
    expect(worker?.provider.model).toBe("parent-model");
  });

  test("per-director override wins over the parent pair", async () => {
    let worker: RunSubAgentParams | undefined;
    const deps = createFleetDeps(
      async (params) => {
        worker = params;
        return { report: "done" };
      },
      {
        settings: {
          providers: { primary, secondary },
          inferenceProfiles: {
            coder: { provider: "secondary", model: "other-model" },
          },
        },
        catalog: [primary, secondary],
      },
    );
    deps.provider = parentProvider();
    const result = await callFleetToolRaw(createSpawnAgentTool(deps), {
      agent: "coder",
      description: "build",
      prompt: "build the thing",
      success_criteria: ["done"],
    });
    expect(result.isError).not.toBe(true);
    await callFleetToolRaw(fleetTools(deps).wait, { timeout_ms: 2000 });
    expect(worker?.provider.providerName).toBe("secondary");
    expect(worker?.provider.model).toBe("other-model");
  });

  test("model-only override keeps the parent provider", async () => {
    let worker: RunSubAgentParams | undefined;
    const deps = createFleetDeps(
      async (params) => {
        worker = params;
        return { report: "done" };
      },
      {
        settings: {
          providers: { primary },
          inferenceProfiles: { coder: { model: "other-model" } },
        },
        catalog: [primary],
      },
    );
    deps.provider = parentProvider();
    const result = await callFleetToolRaw(createSpawnAgentTool(deps), {
      agent: "coder",
      description: "build",
      prompt: "build the thing",
      success_criteria: ["done"],
    });
    expect(result.isError).not.toBe(true);
    await callFleetToolRaw(fleetTools(deps).wait, { timeout_ms: 2000 });
    expect(worker?.provider.providerName).toBe("primary");
    expect(worker?.provider.model).toBe("other-model");
  });

  test("effort-only profile keeps the parent pair and pins effort", async () => {
    let worker: RunSubAgentParams | undefined;
    const deps = createFleetDeps(
      async (params) => {
        worker = params;
        return { report: "done" };
      },
      {
        settings: {
          providers: { primary },
          inferenceProfiles: { coder: { reasoningEffort: "high" } },
        },
        catalog: [primary],
      },
    );
    deps.provider = parentProvider();
    const result = await callFleetToolRaw(createSpawnAgentTool(deps), {
      agent: "coder",
      description: "build",
      prompt: "build the thing",
      success_criteria: ["done"],
    });
    expect(result.isError).not.toBe(true);
    await callFleetToolRaw(fleetTools(deps).wait, { timeout_ms: 2000 });
    expect(worker?.provider.providerName).toBe("primary");
    expect(worker?.provider.model).toBe("parent-model");
    expect(worker?.provider.reasoningEffort).toBe("high");
  });

  test("intent path honors the modelRole fallback key", async () => {
    let worker: RunSubAgentParams | undefined;
    const deps = createFleetDeps(
      async (params) => {
        worker = params;
        return { report: "done" };
      },
      {
        settings: {
          providers: { primary },
          inferenceProfiles: { implement: { model: "other-model" } },
        },
        catalog: [primary],
      },
    );
    deps.provider = parentProvider();
    const result = await callFleetToolRaw(createSpawnAgentTool(deps), {
      intent: "implement",
      description: "build",
      prompt: "build the thing",
      success_criteria: ["done"],
    });
    expect(result.isError).not.toBe(true);
    await callFleetToolRaw(fleetTools(deps).wait, { timeout_ms: 2000 });
    expect(worker?.provider.providerName).toBe("primary");
    expect(worker?.provider.model).toBe("other-model");
  });

  test("unknown provider in a named profile fails closed before starting", async () => {
    let started = false;
    const deps = createFleetDeps(
      async () => {
        started = true;
        return { report: "done" };
      },
      {
        settings: {
          providers: { primary },
          inferenceProfiles: {
            coder: { provider: "missing", model: "other-model" },
          },
        },
        catalog: [primary],
      },
    );
    deps.provider = parentProvider();
    const result = await callFleetToolRaw(createSpawnAgentTool(deps), {
      agent: "coder",
      description: "build",
      prompt: "build the thing",
      success_criteria: ["done"],
    });
    expect(result.isError).toBe(true);
    expect(started).toBe(false);
  });

  test("unknown model in a named profile fails closed before starting", async () => {
    let started = false;
    const deps = createFleetDeps(
      async () => {
        started = true;
        return { report: "done" };
      },
      {
        settings: {
          providers: { primary },
          inferenceProfiles: {
            coder: { model: "no-such-model" },
          },
        },
        catalog: [primary],
      },
    );
    deps.provider = parentProvider();
    const result = await callFleetToolRaw(createSpawnAgentTool(deps), {
      agent: "coder",
      description: "build",
      prompt: "build the thing",
      success_criteria: ["done"],
    });
    expect(result.isError).toBe(true);
    expect(started).toBe(false);
  });
});
