import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as codexSession from "../auth/codex/session.js";
import * as xaiSession from "../auth/xai/session.js";
import * as oauthStores from "../config/oauth-stores.js";

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

  describe("expiry-aware ensure", () => {
    afterEach(() => {
      spyOn(oauthStores, "loadCodexProfile").mockRestore();
      spyOn(oauthStores, "loadXaiProfile").mockRestore();
    });

    function stageCodexProfile(tokens: {
      access: string;
      refresh: string;
      expiresAt: number;
    }) {
      spyOn(oauthStores, "loadCodexProfile").mockResolvedValue({
        name: "default",
        createdAt: 0,
        tokens,
      });
    }

    test("fresh staged Codex tokens skip the token session", async () => {
      const getValid = spyOn(codexSession, "getValidCodexToken");
      stageCodexProfile({
        access: "live-token",
        refresh: "refresh-1",
        expiresAt: Date.now() + 3_600_000,
      });
      const { ensureFreshInferenceSource } =
        await import("./refresh-inference-source.js");
      const source = baseSource("codex/fresh");
      registerSourceCredentialRecord(source.credentialId, {
        provenance: { kind: "oauth", provider: "codex", profile: "default" },
        material: { secret: "live-token" },
      });
      const out = await ensureFreshInferenceSource(source, []);
      expect(out).toBe(source);
      expect(getValid).not.toHaveBeenCalled();
      expect(peekSourceCredentialSecret(source.credentialId)).toBe(
        "live-token",
      );
    });

    test("expiring staged Codex tokens refresh exactly once", async () => {
      const getValid = spyOn(
        codexSession,
        "getValidCodexToken",
      ).mockResolvedValue({ access: "fresh-token" });
      stageCodexProfile({
        access: "stale-token",
        refresh: "refresh-1",
        expiresAt: Date.now() - 1_000,
      });
      const { ensureFreshInferenceSource } =
        await import("./refresh-inference-source.js");
      const source = baseSource("codex/expiring");
      registerSourceCredentialRecord(source.credentialId, {
        provenance: { kind: "oauth", provider: "codex", profile: "default" },
        material: { secret: "stale-token" },
      });
      const out = await ensureFreshInferenceSource(source, []);
      expect(out).toBe(source);
      expect(getValid).toHaveBeenCalledTimes(1);
      expect(peekSourceCredentialSecret(source.credentialId)).toBe(
        "fresh-token",
      );
    });

    test("missing staged Codex profile falls back to refresh", async () => {
      const getValid = spyOn(
        codexSession,
        "getValidCodexToken",
      ).mockResolvedValue({ access: "fresh-token" });
      spyOn(oauthStores, "loadCodexProfile").mockResolvedValue(undefined);
      const { ensureFreshInferenceSource } =
        await import("./refresh-inference-source.js");
      const source = baseSource("codex/missing");
      registerSourceCredentialRecord(source.credentialId, {
        provenance: { kind: "oauth", provider: "codex", profile: "default" },
        material: { secret: "stale-token" },
      });
      await ensureFreshInferenceSource(source, []);
      expect(getValid).toHaveBeenCalledTimes(1);
      expect(peekSourceCredentialSecret(source.credentialId)).toBe(
        "fresh-token",
      );
    });

    test("unreadable staged Codex store falls back to refresh", async () => {
      const getValid = spyOn(
        codexSession,
        "getValidCodexToken",
      ).mockResolvedValue({ access: "fresh-token" });
      spyOn(oauthStores, "loadCodexProfile").mockRejectedValue(
        new Error("disk gone"),
      );
      const { ensureFreshInferenceSource } =
        await import("./refresh-inference-source.js");
      const source = baseSource("codex/unreadable");
      registerSourceCredentialRecord(source.credentialId, {
        provenance: { kind: "oauth", provider: "codex", profile: "default" },
        material: { secret: "stale-token" },
      });
      await ensureFreshInferenceSource(source, []);
      expect(getValid).toHaveBeenCalledTimes(1);
    });

    test("fresh staged tokens with a rotated cell secret refresh to heal", async () => {
      const getValid = spyOn(
        codexSession,
        "getValidCodexToken",
      ).mockResolvedValue({ access: "rotated-token" });
      stageCodexProfile({
        access: "staged-token",
        refresh: "refresh-1",
        expiresAt: Date.now() + 3_600_000,
      });
      const { ensureFreshInferenceSource } =
        await import("./refresh-inference-source.js");
      const source = baseSource("codex/rotated");
      registerSourceCredentialRecord(source.credentialId, {
        provenance: { kind: "oauth", provider: "codex", profile: "default" },
        material: { secret: "cell-token" },
      });
      await ensureFreshInferenceSource(source, []);
      expect(getValid).toHaveBeenCalledTimes(1);
      expect(peekSourceCredentialSecret(source.credentialId)).toBe(
        "rotated-token",
      );
    });

    test("concurrent ensures share one in-flight refresh", async () => {
      let resolveRefresh!: (value: { access: string }) => void;
      const getValid = spyOn(
        codexSession,
        "getValidCodexToken",
      ).mockReturnValue(
        new Promise((resolve) => {
          resolveRefresh = resolve;
        }),
      );
      spyOn(oauthStores, "loadCodexProfile").mockResolvedValue(undefined);
      const { ensureFreshInferenceSource } =
        await import("./refresh-inference-source.js");
      const source = baseSource("codex/concurrent");
      registerSourceCredentialRecord(source.credentialId, {
        provenance: { kind: "oauth", provider: "codex", profile: "default" },
        material: { secret: "stale-token" },
      });
      const pending = [
        ensureFreshInferenceSource(source, []),
        ensureFreshInferenceSource(source, []),
        ensureFreshInferenceSource(source, []),
      ];
      resolveRefresh({ access: "fresh-token" });
      const outs = await Promise.all(pending);
      expect(getValid).toHaveBeenCalledTimes(1);
      expect(outs.every((out) => out === source)).toBe(true);
      expect(peekSourceCredentialSecret(source.credentialId)).toBe(
        "fresh-token",
      );
    });

    test("fresh staged xAI tokens skip the token session", async () => {
      const getValid = spyOn(xaiSession, "getValidXaiToken");
      spyOn(oauthStores, "loadXaiProfile").mockResolvedValue({
        name: "default",
        createdAt: 0,
        tokens: {
          access: "live-token",
          refresh: "refresh-1",
          expiresAt: Date.now() + 3_600_000,
        },
      });
      const { ensureFreshInferenceSource } =
        await import("./refresh-inference-source.js");
      const source = baseSource("xai/fresh");
      registerSourceCredentialRecord(source.credentialId, {
        provenance: { kind: "oauth", provider: "xai", profile: "default" },
        material: { secret: "live-token" },
      });
      const out = await ensureFreshInferenceSource(source, []);
      expect(out).toBe(source);
      expect(getValid).not.toHaveBeenCalled();
    });
  });
});
