import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as codexSession from "../auth/codex/session.js";
import * as xaiSession from "../auth/xai/session.js";

import type { InferenceSource } from "@intx/types/runtime";
import {
  clearSourceCredentials,
  peekSourceCredentialSecret,
  readSourceCredentialMaterial,
  registerSourceCredentialRecord,
} from "../config/source-credentials.js";

const baseSource = (id: string): InferenceSource => ({
  id,
  provider: "openai",
  baseURL: "https://api.openai.com/v1",
  credentialId: id,
  model: "gpt-4o",
});

describe("refresh-inference-source", () => {
  afterEach(() => {
    clearSourceCredentials();
    spyOn(codexSession, "getValidCodexToken").mockRestore();
    spyOn(xaiSession, "getValidXaiToken").mockRestore();
  });

  test("ensureFreshInferenceSource registers the fresh Codex token in the credential cell", async () => {
    spyOn(codexSession, "getValidCodexToken").mockResolvedValue({
      access: "fresh-codex-token",
    });
    const { ensureFreshInferenceSource } =
      await import("./refresh-inference-source.js");
    const source = baseSource("codex/default");
    registerSourceCredentialRecord(source.credentialId, {
      provenance: { kind: "oauth", provider: "codex", profile: "default" },
      material: { secret: "stale-codex-token" },
    });
    const out = await ensureFreshInferenceSource(source, []);
    expect(out).toBe(source);
    expect(peekSourceCredentialSecret(source.credentialId)).toBe(
      "fresh-codex-token",
    );
  });

  test("refresh replaces Codex identity and removes a missing identity", async () => {
    const refresh = spyOn(codexSession, "getValidCodexToken");
    refresh.mockResolvedValueOnce({
      access: "token-b",
      accountId: "account-b",
    });
    refresh.mockResolvedValueOnce({ access: "token-c" });
    const { ensureFreshInferenceSource } =
      await import("./refresh-inference-source.js");
    const source = baseSource("codex/work");
    registerSourceCredentialRecord(source.credentialId, {
      provenance: { kind: "oauth", provider: "codex", profile: "work" },
      material: {
        secret: "token-a",
        headers: { "chatgpt-account-id": "account-a" },
      },
    });

    await ensureFreshInferenceSource(source, []);
    expect(readSourceCredentialMaterial(source.credentialId)).toEqual({
      secret: "token-b",
      headers: { "chatgpt-account-id": "account-b" },
    });

    await ensureFreshInferenceSource(source, []);
    expect(readSourceCredentialMaterial(source.credentialId)).toEqual({
      secret: "token-c",
    });
  });

  test("refresh replaces xAI identity and removes a missing identity", async () => {
    const accessWithUser = "header.eyJzdWIiOiJ1c2VyLWIifQ.signature";
    const refresh = spyOn(xaiSession, "getValidXaiToken");
    refresh.mockResolvedValueOnce({ access: accessWithUser });
    refresh.mockResolvedValueOnce({ access: "opaque-token-without-user" });
    const { ensureFreshInferenceSource } =
      await import("./refresh-inference-source.js");
    const source = baseSource("xai/work");
    registerSourceCredentialRecord(source.credentialId, {
      provenance: { kind: "oauth", provider: "xai", profile: "work" },
      material: {
        secret: "token-a",
        headers: { "x-grok-user-id": "user-a" },
      },
    });

    await ensureFreshInferenceSource(source, []);
    expect(readSourceCredentialMaterial(source.credentialId)).toEqual({
      secret: accessWithUser,
      headers: { "x-grok-user-id": "user-b" },
    });

    await ensureFreshInferenceSource(source, []);
    expect(readSourceCredentialMaterial(source.credentialId)).toEqual({
      secret: "opaque-token-without-user",
    });
  });

  test("deferred refresh cannot overwrite a newer credential registration", async () => {
    let resolveRefresh!: (value: { access: string; accountId: string }) => void;
    spyOn(codexSession, "getValidCodexToken").mockReturnValue(
      new Promise((resolve) => {
        resolveRefresh = resolve;
      }),
    );
    const { ensureFreshInferenceSource } =
      await import("./refresh-inference-source.js");
    const source = baseSource("codex/work");
    registerSourceCredentialRecord(source.credentialId, {
      provenance: { kind: "oauth", provider: "codex", profile: "work" },
      material: { secret: "token-a" },
    });

    const pending = ensureFreshInferenceSource(source, []);
    registerSourceCredentialRecord(source.credentialId, {
      provenance: { kind: "oauth", provider: "codex", profile: "replacement" },
      material: {
        secret: "token-b",
        headers: { "chatgpt-account-id": "account-b" },
      },
    });
    resolveRefresh({ access: "stale-token", accountId: "stale-account" });
    await pending;

    expect(readSourceCredentialMaterial(source.credentialId)).toEqual({
      secret: "token-b",
      headers: { "chatgpt-account-id": "account-b" },
    });
  });

  test("refreshInferenceSourceBundle refreshes each leg", async () => {
    const { refreshInferenceSourceBundle } =
      await import("./refresh-inference-source.js");
    const bundle = await refreshInferenceSourceBundle(
      [baseSource("openai"), baseSource("other")],
      "openai",
      [],
    );
    expect(bundle.sources).toHaveLength(2);
    expect(bundle.defaultSource).toBe("openai");
  });

  test("ensureFreshInferenceSource leaves non-OAuth sources unchanged", async () => {
    const { ensureFreshInferenceSource } =
      await import("./refresh-inference-source.js");
    const source = baseSource("custom-gateway");
    const out = await ensureFreshInferenceSource(source, [
      {
        name: "custom-gateway",
        baseURL: "https://example.com/v1",
        models: ["gpt-4o"],
        apiKey: "key-abc",
      },
    ]);
    expect(out).toBe(source);
  });
});
