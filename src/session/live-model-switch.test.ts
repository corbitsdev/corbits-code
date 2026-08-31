import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { ToolCall, ToolDefinition } from "@intx/types/runtime";

import { presentDefinition } from "../agent/director.js";
import { normalizeToolDefinitionsForProvider } from "../agent/tool-schema-normalize.js";
import { createPermissionGate } from "../permission/gate.js";
import * as permissionStore from "../permission/store.js";
import type { Approval } from "../permission/types.js";
import { createApprovalPersist } from "./runtime-assembly.js";
import { applyLiveModelSwitch, providerModelKey, type LiveModelRef } from "./live-model-switch.js";

const MODEL_A: LiveModelRef = { providerName: "openai", model: "gpt-5" };
const MODEL_B: LiveModelRef = { providerName: "anthropic", model: "claude-opus" };
const MODEL_KIMI: LiveModelRef = { providerName: "moonshot", model: "kimi-k2" };

const canonicalDefs: readonly ToolDefinition[] = [presentDefinition];

function schemaHasRef(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(schemaHasRef);
  const obj = value as Record<string, unknown>;
  if ("$ref" in obj) return true;
  return Object.values(obj).some(schemaHasRef);
}

const shellCall = (command: string): ToolCall => ({
  id: "c",
  name: "run_shell",
  arguments: { command },
});

const providerModelScope = {
  id: "provider-model",
  label: "",
  pattern: "npm *",
  grant: "provider-model" as const,
};

function presentSchema(defs: readonly ToolDefinition[]): unknown {
  return defs.find((d) => d.name === "present")?.inputSchema;
}

/**
 * Same collaborators the TUI `/model` handler wires through
 * `applyLiveModelSwitch`: live identity (persist reads it), permission gate,
 * inference rebuild, and canonical-then-family-gate advertise.
 */
function createProductionSwitch() {
  let identity: LiveModelRef = MODEL_A;
  let inference: LiveModelRef = MODEL_A;
  let advertised = normalizeToolDefinitionsForProvider(canonicalDefs, MODEL_A);

  const persist = createApprovalPersist("/tmp/proj", () => providerModelKey(identity));
  const gate = createPermissionGate({
    approvals: [],
    requestApproval: async () => ({ allow: true, persist: providerModelScope }),
    persist,
    interactive: true,
    skipPermissions: false,
    auto: false,
    providerName: identity.providerName,
    model: identity.model,
  });

  const switchTo = (next: LiveModelRef): void => {
    applyLiveModelSwitch(next, {
      applyIdentity: (ref) => {
        identity = ref;
      },
      setPermissionIdentity: (providerName, model) => {
        gate.setProviderIdentity(providerName, model);
      },
      rebuildInference: (ref) => {
        inference = ref;
      },
      refreshAdvertisedSchemas: (ref) => {
        advertised = normalizeToolDefinitionsForProvider(canonicalDefs, ref);
      },
    });
  };

  return {
    gate,
    switchTo,
    identity: () => identity,
    inference: () => inference,
    advertised: () => advertised,
  };
}

describe("applyLiveModelSwitch", () => {
  afterEach(() => {
    mock.restore();
  });

  test("refreshes identity, permission, inference, and schemas as one operation", () => {
    const order: string[] = [];
    applyLiveModelSwitch(MODEL_B, {
      applyIdentity: () => {
        order.push("identity");
      },
      setPermissionIdentity: () => {
        order.push("permission");
      },
      rebuildInference: () => {
        order.push("inference");
      },
      refreshAdvertisedSchemas: () => {
        order.push("schemas");
      },
    });
    expect(order).toEqual(["identity", "permission", "inference", "schemas"]);
  });

  test("a grant scoped to A does not cover the action after switching to B; new grants store under B", async () => {
    const saved: string[] = [];
    spyOn(permissionStore, "saveProviderModelApproval").mockImplementation(async (key: string) => {
      saved.push(key);
    });
    spyOn(permissionStore, "saveProjectApproval").mockResolvedValue(undefined);
    spyOn(permissionStore, "saveGlobalApproval").mockResolvedValue(undefined);

    const session = createProductionSwitch();

    expect((await session.gate.evaluate(shellCall("npm test"))).allowed).toBe(true);
    expect(saved).toEqual([providerModelKey(MODEL_A)]);
    const grantA = session.gate
      .getApprovals()
      .find((a: Approval) => a.providerModel === providerModelKey(MODEL_A));
    expect(grantA).toBeDefined();

    session.switchTo(MODEL_B);

    expect(session.identity()).toEqual(MODEL_B);
    expect(session.inference()).toEqual(MODEL_B);

    expect((await session.gate.evaluate(shellCall("npm test"))).allowed).toBe(true);
    expect(saved).toEqual([providerModelKey(MODEL_A), providerModelKey(MODEL_B)]);
    expect(
      session.gate.getApprovals().some((a) => a.providerModel === providerModelKey(MODEL_B)),
    ).toBe(true);
  });

  test("non-kimi to kimi rewrites advertised present; switching away restores canonical", () => {
    const session = createProductionSwitch();
    expect(schemaHasRef(presentSchema(session.advertised()))).toBe(true);
    expect(presentSchema(session.advertised())).toBe(presentDefinition.inputSchema);

    session.switchTo(MODEL_KIMI);

    expect(session.inference()).toEqual(MODEL_KIMI);
    expect(schemaHasRef(presentSchema(session.advertised()))).toBe(false);
    expect(presentSchema(session.advertised())).not.toBe(presentDefinition.inputSchema);

    session.switchTo(MODEL_A);

    expect(session.inference()).toEqual(MODEL_A);
    expect(schemaHasRef(presentSchema(session.advertised()))).toBe(true);
    expect(presentSchema(session.advertised())).toBe(presentDefinition.inputSchema);
  });
});
