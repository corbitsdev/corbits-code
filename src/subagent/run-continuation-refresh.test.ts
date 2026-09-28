import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as codexSession from "../auth/codex/session.js";
import * as oauthStores from "../config/oauth-stores.js";

import type {
  InferenceSource,
  ReactorAction,
  ReactorCapabilities,
  ReactorDirector,
  ReactorInboundEvent,
  ReactorState,
} from "@intx/types/runtime";
import {
  clearSourceCredentials,
  peekSourceCredentialSecret,
  registerSourceCredentialRecord,
} from "../config/source-credentials.js";
import { createTestCapabilities } from "./director-test-harness.js";
import { SubAgentDirector } from "./nudge-director.js";
import type { ContinuationRefreshOptions } from "./refresh-inference-source.js";
import { withContinuationOAuthRefresh } from "./refresh-inference-source.js";

const state = { turns: [] } as unknown as ReactorState;
const retryPolicyStub = { id: "test-retry-policy" } as never;

function inferenceDone(callIds: string[]): ReactorInboundEvent {
  return {
    type: "inference.done",
    turn: {
      role: "assistant",
      model: "test",
      timestamp: 0,
      content: callIds.map((id) => ({
        type: "tool_call",
        id,
        name: "read_file",
        arguments: { path: `${id}.ts` },
      })),
    },
    usage: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, thinking: 0 },
    source: { model: "test-model" },
  } as unknown as ReactorInboundEvent;
}

function toolDone(callId: string): ReactorInboundEvent {
  return {
    type: "tool.done",
    result: { callId, content: "ok", isError: false },
  } as unknown as ReactorInboundEvent;
}

function actions(result: ReactorAction | ReactorAction[]): ReactorAction[] {
  return Array.isArray(result) ? result : [result];
}

function inferOptions(result: ReactorAction | ReactorAction[]) {
  const infer = actions(result).find((action) => action.type === "infer");
  if (infer?.type !== "infer") throw new Error("expected infer action");
  return infer.options as Record<string, unknown> | undefined;
}

const bundleSource = (id: string): InferenceSource => ({
  id,
  provider: "openai",
  baseURL: "https://api.openai.com/v1",
  credentialId: id,
  model: "test",
});

describe("run continuation OAuth refresh", () => {
  afterEach(() => {
    clearSourceCredentials();
    spyOn(codexSession, "getValidCodexToken").mockRestore();
    spyOn(oauthStores, "loadCodexProfile").mockRestore();
  });

  async function setup(expiring: boolean) {
    const now = Date.now();
    spyOn(oauthStores, "loadCodexProfile").mockResolvedValue({
      name: "default",
      createdAt: 0,
      tokens: {
        access: "staged-token",
        refresh: "refresh-1",
        expiresAt: expiring ? now - 1_000 : now + 3_600_000,
      },
    });
    const getValid = spyOn(
      codexSession,
      "getValidCodexToken",
    ).mockResolvedValue({ access: "fresh-token" });
    const source = bundleSource("codex/default");
    registerSourceCredentialRecord(source.credentialId, {
      provenance: { kind: "oauth", provider: "codex", profile: "default" },
      material: { secret: expiring ? "stale-token" : "staged-token" },
    });
    const setSourcesCalls: {
      sources: InferenceSource[];
      defaultSource: string;
    }[] = [];
    const agent = {
      setSources(sources: InferenceSource[], defaultSource: string) {
        setSourcesCalls.push({ sources, defaultSource });
      },
    };
    const options: ContinuationRefreshOptions = {
      getAgent: () => agent,
      sources: [source],
      defaultSource: source.id,
      catalog: [],
    };
    const inner = new SubAgentDirector(
      "system",
      [],
      undefined,
      30,
      Date.now,
      false,
      false,
      retryPolicyStub,
    );
    const wrapped = withContinuationOAuthRefresh(inner, options);
    const caps = createTestCapabilities();
    return { getValid, setSourcesCalls, wrapped, caps, source };
  }

  test("post-tool continuation refreshes when expiring", async () => {
    const { getValid, setSourcesCalls, wrapped, caps, source } =
      await setup(true);
    const first = await wrapped.decide(inferenceDone(["call-1"]), state, caps);
    expect(actions(first).some((action) => action.type === "infer")).toBe(
      false,
    );
    expect(getValid).not.toHaveBeenCalled();
    expect(setSourcesCalls).toHaveLength(0);

    const result = await wrapped.decide(toolDone("call-1"), state, caps);
    const options = inferOptions(result);
    expect(getValid).toHaveBeenCalledTimes(1);
    expect(peekSourceCredentialSecret(source.credentialId)).toBe("fresh-token");
    expect(setSourcesCalls).toHaveLength(1);
    expect(setSourcesCalls[0]?.defaultSource).toBe(source.id);
    expect(setSourcesCalls[0]?.sources.map((entry) => entry.id)).toEqual([
      source.id,
    ]);
    // The inner policy stamping composes untouched through the wrapper.
    expect(options?.retryPolicy).toBe(retryPolicyStub);
    expect(options?.systemPrompt).toBeDefined();
  });

  test("post-tool continuation skips the session when fresh", async () => {
    const { getValid, setSourcesCalls, wrapped, caps } = await setup(false);
    await wrapped.decide(inferenceDone(["call-1"]), state, caps);
    const result = await wrapped.decide(toolDone("call-1"), state, caps);
    expect(inferOptions(result)?.retryPolicy).toBe(retryPolicyStub);
    expect(getValid).not.toHaveBeenCalled();
    expect(setSourcesCalls).toHaveLength(1);
  });

  test("infer passes through untouched when the agent is not running yet", async () => {
    const getValid = spyOn(codexSession, "getValidCodexToken");
    const inner = new SubAgentDirector(
      "system",
      [],
      undefined,
      30,
      Date.now,
      false,
      false,
      retryPolicyStub,
    );
    const wrapped = withContinuationOAuthRefresh(inner, {
      getAgent: () => null,
      sources: [bundleSource("codex/default")],
      defaultSource: "codex/default",
      catalog: [],
    });
    const caps = createTestCapabilities();
    await wrapped.decide(inferenceDone(["call-1"]), state, caps);
    const result = await wrapped.decide(toolDone("call-1"), state, caps);
    expect(actions(result).some((action) => action.type === "infer")).toBe(
      true,
    );
    expect(getValid).not.toHaveBeenCalled();
  });

  test("wrapping an already-wrapped director is a no-op", async () => {
    const getValid = spyOn(
      codexSession,
      "getValidCodexToken",
    ).mockResolvedValue({ access: "fresh-token" });
    spyOn(oauthStores, "loadCodexProfile").mockResolvedValue(undefined);
    const source = bundleSource("codex/double");
    registerSourceCredentialRecord(source.credentialId, {
      provenance: { kind: "oauth", provider: "codex", profile: "default" },
      material: { secret: "stale-token" },
    });
    let setSources = 0;
    const options: ContinuationRefreshOptions = {
      getAgent: () => ({
        setSources: () => {
          setSources += 1;
        },
      }),
      sources: [source],
      defaultSource: source.id,
      catalog: [],
    };
    const fakeInner: ReactorDirector = {
      decide: async (
        _event: ReactorInboundEvent,
        _state: ReactorState,
        capabilities: ReactorCapabilities,
      ) => capabilities.infer(),
    };
    const wrapped = withContinuationOAuthRefresh(fakeInner, options);
    expect(withContinuationOAuthRefresh(wrapped, options)).toBe(wrapped);
    await wrapped.decide(toolDone("call-1"), state, createTestCapabilities());
    expect(getValid).toHaveBeenCalledTimes(1);
    expect(setSources).toBe(1);
  });

  test("concurrent continuation decides share one refresh", async () => {
    let resolveRefresh!: (value: { access: string }) => void;
    const getValid = spyOn(codexSession, "getValidCodexToken").mockReturnValue(
      new Promise((resolve) => {
        resolveRefresh = resolve;
      }),
    );
    spyOn(oauthStores, "loadCodexProfile").mockResolvedValue(undefined);
    const source = bundleSource("codex/race");
    registerSourceCredentialRecord(source.credentialId, {
      provenance: { kind: "oauth", provider: "codex", profile: "default" },
      material: { secret: "stale-token" },
    });
    const setSourcesCalls: { sources: unknown; defaultSource: string }[] = [];
    const options: ContinuationRefreshOptions = {
      getAgent: () => ({
        setSources: (sources: InferenceSource[], defaultSource: string) => {
          setSourcesCalls.push({ sources, defaultSource });
        },
      }),
      sources: [source],
      defaultSource: source.id,
      catalog: [],
    };
    const fakeInner: ReactorDirector = {
      decide: async (
        _event: ReactorInboundEvent,
        _state: ReactorState,
        capabilities: ReactorCapabilities,
      ) => capabilities.infer(),
    };
    const caps = createTestCapabilities();
    const first = withContinuationOAuthRefresh(fakeInner, options);
    const second = withContinuationOAuthRefresh(fakeInner, options);
    const pending = [
      first.decide(toolDone("call-1"), state, caps),
      second.decide(toolDone("call-1"), state, caps),
    ];
    resolveRefresh({ access: "fresh-token" });
    const results = await Promise.all(pending);
    expect(results).toHaveLength(2);
    expect(getValid).toHaveBeenCalledTimes(1);
    expect(setSourcesCalls).toHaveLength(2);
    expect(peekSourceCredentialSecret(source.credentialId)).toBe("fresh-token");
  });
});
