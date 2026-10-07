import { describe, expect, test } from "bun:test";
import { createDefaultScheduler, runInference } from "@intx/inference";
import { createInferenceDependencies } from "../provider/inference-dependencies.js";
import type {
  ConversationTurn,
  InferenceEvent,
  InferenceSource,
} from "@intx/types/runtime";
import type { AdmissionQueue } from "../subagent/admission.js";
import {
  createCorbitsRetryPolicy,
  type CorbitsRetryPolicyOptions,
} from "./retry-policy.js";
import {
  clearSourceCredentials,
  registerSourceCredentialRecord,
} from "../config/source-credentials.js";

const HTML_503 = `<!DOCTYPE html><html><body>503 Service Unavailable Cloudflare</body></html>`;

const silentAdmission: AdmissionQueue = {
  enqueue: () => "running",
  release: () => undefined,
  setCapacity: () => undefined,
  notePressure: () => undefined,
  cancel: () => undefined,
  occupied: () => false,
};

function policy(opts: CorbitsRetryPolicyOptions = {}) {
  return createCorbitsRetryPolicy({ admission: silentAdmission, ...opts });
}

describe("createCorbitsRetryPolicy", () => {
  test("refreshes the first credential failure after a transient retry", async () => {
    registerSourceCredentialRecord("codex/work", {
      provenance: { kind: "oauth", provider: "codex", profile: "work" },
      material: {
        secret: "old",
        headers: { "chatgpt-account-id": "old-account" },
      },
    });
    try {
      let refreshes = 0;
      const decide = policy({
        refreshCredential: async () => {
          refreshes++;
        },
      });
      const source = {
        id: "codex/work",
        provider: "codex-responses",
        baseURL: "https://chatgpt.com/backend-api/codex",
        credentialId: "codex/work",
        model: "gpt-5",
      };

      expect(
        await decide({
          attempt: 1,
          elapsedMs: 0,
          source,
          credentialFailureOrdinal: 0,
          credentialFailureHistory: [],
          error: { category: "retryable", message: "gateway unavailable" },
        }),
      ).toEqual({ kind: "retry", delayMs: 500 });
      expect(
        await decide({
          attempt: 2,
          elapsedMs: 500,
          source,
          credentialFailureOrdinal: 1,
          credentialFailureHistory: [],
          error: { category: "credential_failure", message: "expired" },
        }),
      ).toEqual({ kind: "retry", delayMs: 0 });
      expect(refreshes).toBe(1);
    } finally {
      clearSourceCredentials();
    }
  });

  test("raw Codex 404 invalid_token refreshes once and surfaces normalized credential failure", async () => {
    const source: InferenceSource = {
      id: "codex/work",
      provider: "codex-responses",
      baseURL: "https://chatgpt.com/backend-api/codex",
      credentialId: "codex/work",
      model: "gpt-5",
    };
    registerSourceCredentialRecord(source.credentialId, {
      provenance: { kind: "oauth", provider: "codex", profile: "work" },
      material: { secret: "access-token" },
    });
    const oldSecret = "opaque old credential with spaces";
    const replacementSecret = "opaque replacement credential with spaces";
    let liveSecret = oldSecret;
    let sends = 0;
    let refreshes = 0;
    const retryPolicy = policy({
      providerId: () => "xai/previous",
      refreshCredential: async (refreshedSource, provenance) => {
        refreshes++;
        liveSecret = replacementSecret;
        expect(refreshedSource.id).toBe(source.id);
        expect(provenance).toEqual({
          kind: "oauth",
          provider: "codex",
          profile: "work",
        });
      },
    });
    const baseDeps = await createInferenceDependencies();
    const deps = {
      ...baseDeps,
      scheduler: createDefaultScheduler(),
      fetch: async (_input: string | URL | Request, init?: RequestInit) => {
        sends++;
        const authorization = new Headers(init?.headers).get("authorization");
        return Response.json(
          {
            error: {
              code: "invalid_token",
              message: `The access token ${authorization} has been revoked`,
              type: "invalid_request_error",
            },
          },
          { status: 404 },
        );
      },
    };
    const turns: ConversationTurn[] = [
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
        timestamp: 0,
      },
    ];
    const events: InferenceEvent[] = [];
    let seq = 0;
    try {
      for await (const event of runInference({
        turns,
        source,
        nextSeq: () => ++seq,
        deps,
        readMaterial: () => ({ secret: liveSecret }),
        inferenceOptions: { retryPolicy },
      }))
        events.push(event);

      expect(JSON.stringify(events)).not.toContain(oldSecret);
      expect(JSON.stringify(events)).not.toContain(replacementSecret);
      expect(sends).toBe(2);
      expect(refreshes).toBe(1);
      const retries = events.filter(
        (event) => event.type === "inference.retry",
      );
      expect(retries).toHaveLength(1);
      if (retries[0]?.type !== "inference.retry")
        throw new Error("expected inference.retry");
      expect(retries[0].data.previousError.category).toBe("credential_failure");
      const terminal = events.findLast(
        (event) => event.type === "inference.error",
      );
      if (terminal?.type !== "inference.error")
        throw new Error("expected terminal inference.error");
      expect(terminal.data.error.category).toBe("credential_failure");
      expect(terminal.data.error.message).toContain('Codex profile "work"');
      expect(terminal.data.error.message).toContain("/connect");
    } finally {
      clearSourceCredentials();
    }
  });

  test("does not recover namespaced API-key credentials", async () => {
    registerSourceCredentialRecord("xai/shadow", {
      provenance: { kind: "api-key" },
      material: { secret: "explicit-key" },
    });
    try {
      let refreshes = 0;
      const decision = await policy({
        refreshCredential: async () => {
          refreshes++;
        },
      })({
        attempt: 1,
        elapsedMs: 0,
        source: {
          id: "xai/shadow",
          provider: "openai-compatible",
          baseURL: "https://relay.example/v1",
          credentialId: "xai/shadow",
          model: "relay-model",
        },
        credentialFailureOrdinal: 1,
        credentialFailureHistory: [],
        error: { category: "credential_failure", message: "bad key" },
      });
      expect(decision).toEqual({ kind: "abort" });
      expect(refreshes).toBe(0);
    } finally {
      clearSourceCredentials();
    }
  });

  test("retries protocol_mismatch when the body is an HTML 503 gateway page", async () => {
    const decision = await policy()({
      attempt: 1,
      elapsedMs: 0,
      error: {
        category: "protocol_mismatch",
        message: "malformed JSON in SSE data payload",
        raw: HTML_503,
      },
    });
    expect(decision).toEqual({ kind: "retry", delayMs: 500 });
  });

  test("bounds attributable xAI capacity retries to three attempts", async () => {
    const decide = policy({ providerId: "xai/default" });
    const situation = (attempt: number) => ({
      attempt,
      elapsedMs: 0,
      error: {
        category: "protocol_mismatch" as const,
        message: "The model is currently at capacity",
      },
    });

    expect(await decide(situation(1))).toEqual({ kind: "retry", delayMs: 500 });
    expect(await decide(situation(2))).toEqual({
      kind: "retry",
      delayMs: 1000,
    });
    expect(await decide(situation(3))).toEqual({ kind: "abort" });
  });

  test("aborts attributable xAI quota exhaustion", async () => {
    const decision = await policy({ providerId: "xai/default" })({
      attempt: 1,
      elapsedMs: 0,
      error: {
        category: "quota_exhausted",
        message: "Service temporarily unavailable: quota exhausted",
        statusCode: 429,
        retryAfterMs: 86_400_000,
      },
    });
    expect(decision).toEqual({ kind: "abort" });
  });

  test("aborts an OpenCode Go malformed streamed SSE schema response", async () => {
    const decision = await policy({ providerId: "opencode-go/corbits" })({
      attempt: 1,
      elapsedMs: 0,
      error: {
        category: "protocol_mismatch",
        message:
          "openai parseResponse: SSE chunk failed schema validation: choices0.delta.role must be a string (was null)",
      },
    });
    expect(decision).toEqual({ kind: "abort" });
  });

  test("aborts a generic non-overload protocol mismatch", async () => {
    const decision = await policy()({
      attempt: 1,
      elapsedMs: 0,
      error: {
        category: "protocol_mismatch",
        message: "response did not match the provider protocol",
      },
    });
    expect(decision).toEqual({ kind: "abort" });
  });

  test("aborts long-window quota exhaustion", async () => {
    const decision = await policy()({
      attempt: 1,
      elapsedMs: 0,
      error: {
        category: "quota_exhausted",
        message: "monthly cap",
        retryAfterMs: 86_400_000,
      },
    });
    expect(decision).toEqual({ kind: "abort" });
  });

  test("aborts Codex usage_limit_reached when resets_in_seconds is a long window", async () => {
    const decision = await policy()({
      attempt: 1,
      elapsedMs: 0,
      error: {
        category: "quota_exhausted",
        message: "Too Many Requests",
        statusCode: 429,
        raw: {
          detail: {
            error: {
              code: "usage_limit_reached",
              message: "You have reached your usage limit.",
              plan_type: "workspace_member",
              resets_in_seconds: 3435,
            },
          },
        },
      },
    });
    expect(decision).toEqual({ kind: "abort" });
  });

  test("stamped xAI bare 429 retries as retryable, not long-quota abort", async () => {
    const decision = await policy({ providerId: "xai/alice" })({
      attempt: 1,
      elapsedMs: 0,
      error: {
        category: "quota_exhausted",
        message: "Too Many Requests",
        statusCode: 429,
        retryAfterMs: 45_000,
        raw: { error: { message: "Too Many Requests" } },
      },
    });
    // Remapped to retryable -> paced retry honors the server's Retry-After,
    // not abort on moderate Retry-After and not a capped 30s wait.
    expect(decision).toEqual({ kind: "retry", delayMs: 45_000 });
  });

  test("stamped Codex usage-limit 429 retries as retryable, not long-quota abort", async () => {
    const decision = await policy({ providerId: "codex/acme-labs" })({
      attempt: 1,
      elapsedMs: 0,
      error: {
        category: "quota_exhausted",
        message: "You have hit your ChatGPT usage limit",
        statusCode: 429,
        retryAfterMs: 45_000,
        raw: "You have hit your ChatGPT usage limit",
      },
    });
    expect(decision).toEqual({ kind: "retry", delayMs: 45_000 });
  });

  test("stamped xAI usage/quota body still aborts on long retryAfterMs", async () => {
    const decision = await policy({ providerId: "xai/alice" })({
      attempt: 1,
      elapsedMs: 0,
      error: {
        category: "quota_exhausted",
        message: "You exceeded your current quota",
        statusCode: 429,
        retryAfterMs: 86_400_000,
        raw: {
          error: {
            message: "You exceeded your current quota",
            code: "insufficient_quota",
          },
        },
      },
    });
    expect(decision).toEqual({ kind: "abort" });
  });

  test("unknown provider bare 429 with moderate Retry-After still aborts as quota", async () => {
    const decision = await policy({ providerId: "openai" })({
      attempt: 1,
      elapsedMs: 0,
      error: {
        category: "quota_exhausted",
        message: "Too Many Requests",
        statusCode: 429,
        retryAfterMs: 45_000,
        raw: { error: { message: "Too Many Requests" } },
      },
    });
    expect(decision).toEqual({ kind: "abort" });
  });

  test("live providerId getter: non-xAI → xAI starts remapping bare 429", async () => {
    let current: string | undefined = "openai";
    const decide = policy({ providerId: () => current });
    const bare429 = {
      attempt: 1,
      elapsedMs: 0,
      error: {
        category: "quota_exhausted" as const,
        message: "Too Many Requests",
        statusCode: 429,
        retryAfterMs: 45_000,
        raw: { error: { message: "Too Many Requests" } },
      },
    };
    expect(await decide(bare429)).toEqual({ kind: "abort" });
    current = "xai/alice";
    expect(await decide(bare429)).toEqual({ kind: "retry", delayMs: 45_000 });
  });

  // The harness only surfaces `inference.error` to the director once this
  // policy returns `abort`, so the attempt cap here IS the on-wire send cap
  // for these categories (the director no longer re-wraps them). Bound at 3
  // sends for each error class: rate limit (quota_exhausted), gateway error,
  // and malformed response (both normalized to retryable/protocol_mismatch).
  test("rate limit (quota_exhausted) aborts by the 3rd attempt — bounds harness sends to 3", async () => {
    const decide = policy();
    const situation = (attempt: number) => ({
      attempt,
      elapsedMs: 0,
      error: {
        category: "quota_exhausted" as const,
        message: "Too Many Requests",
        statusCode: 429,
        retryAfterMs: 10,
      },
    });
    expect(await decide(situation(1))).toEqual({ kind: "retry", delayMs: 10 });
    expect(await decide(situation(2))).toEqual({ kind: "retry", delayMs: 10 });
    expect(await decide(situation(3))).toEqual({ kind: "abort" });
  });

  test("gateway error (retryable) aborts by the 3rd attempt — bounds harness sends to 3", async () => {
    const decide = policy();
    const situation = (attempt: number) => ({
      attempt,
      elapsedMs: 0,
      error: { category: "retryable" as const, message: "gateway timeout" },
    });
    expect(await decide(situation(1))).toEqual({ kind: "retry", delayMs: 500 });
    expect(await decide(situation(2))).toEqual({
      kind: "retry",
      delayMs: 1000,
    });
    expect(await decide(situation(3))).toEqual({ kind: "abort" });
  });

  test("malformed response (HTML gateway page) aborts by the 3rd attempt — bounds harness sends to 3", async () => {
    const decide = policy();
    const situation = (attempt: number) => ({
      attempt,
      elapsedMs: 0,
      error: {
        category: "protocol_mismatch" as const,
        message: "malformed JSON in SSE data payload",
        raw: HTML_503,
      },
    });
    expect(await decide(situation(1))).toEqual({ kind: "retry", delayMs: 500 });
    expect(await decide(situation(2))).toEqual({
      kind: "retry",
      delayMs: 1000,
    });
    expect(await decide(situation(3))).toEqual({ kind: "abort" });
  });

  test("live providerId getter: xAI → non-xAI stops remapping bare 429", async () => {
    let current: string | undefined = "xai/alice";
    const decide = policy({ providerId: () => current });
    const bare429 = {
      attempt: 1,
      elapsedMs: 0,
      error: {
        category: "quota_exhausted" as const,
        message: "Too Many Requests",
        statusCode: 429,
        retryAfterMs: 45_000,
        raw: { error: { message: "Too Many Requests" } },
      },
    };
    expect(await decide(bare429)).toEqual({ kind: "retry", delayMs: 45_000 });
    current = "openai";
    expect(await decide(bare429)).toEqual({ kind: "abort" });
  });

  test("retryable 429 notes admission pressure; quota_exhausted and non-429 retryable do not", async () => {
    const notes: { provider: string; until: number }[] = [];
    const admission: AdmissionQueue = {
      enqueue: () => "running",
      release: () => undefined,
      setCapacity: () => undefined,
      notePressure: (provider: string, untilMs: number) => {
        notes.push({ provider, until: untilMs });
      },
      cancel: () => undefined,
      occupied: () => false,
    };
    const decide = policy({
      providerId: "xai/alice",
      admission,
      now: () => 10_000,
    });
    await decide({
      attempt: 1,
      elapsedMs: 0,
      error: {
        category: "retryable",
        message: "Too Many Requests",
        statusCode: 429,
        retryAfterMs: 2_000,
      },
    });
    expect(notes).toEqual([{ provider: "xai/alice", until: 12_000 }]);
    notes.length = 0;
    await decide({
      attempt: 1,
      elapsedMs: 0,
      error: {
        category: "retryable",
        message: "gateway timeout",
        statusCode: 502,
        retryAfterMs: 2_000,
      },
    });
    expect(notes).toHaveLength(0);
    await decide({
      attempt: 1,
      elapsedMs: 0,
      error: {
        category: "quota_exhausted",
        message: "monthly cap",
        retryAfterMs: 86_400_000,
      },
    });
    expect(notes).toHaveLength(0);
  });

  test("retryable 429 honors Retry-After instead of the fixed 500/1000ms backoff", async () => {
    const decide = policy({ providerId: "codex/acme-labs" });
    const situation = (attempt: number) => ({
      attempt,
      elapsedMs: 0,
      error: {
        category: "retryable" as const,
        message: "Too Many Requests",
        statusCode: 429,
        retryAfterMs: 5_000,
      },
    });
    expect(await decide(situation(1))).toEqual({
      kind: "retry",
      delayMs: 5_000,
    });
    expect(await decide(situation(2))).toEqual({
      kind: "retry",
      delayMs: 5_000,
    });
    expect(await decide(situation(3))).toEqual({ kind: "abort" });
  });

  test("retryable 429 honors a Retry-After above the blind-wait ceiling", async () => {
    const decide = policy({ providerId: "codex/acme-labs" });
    const decision = await decide({
      attempt: 1,
      elapsedMs: 0,
      error: {
        category: "retryable" as const,
        message: "Too Many Requests",
        statusCode: 429,
        retryAfterMs: 120_000,
      },
    });
    expect(decision).toEqual({ kind: "retry", delayMs: 120_000 });
  });

  test("retryable 429 with a day-long Retry-After aborts instead of hanging", async () => {
    const decide = policy({ providerId: "codex/acme-labs" });
    const decision = await decide({
      attempt: 1,
      elapsedMs: 0,
      error: {
        category: "retryable" as const,
        message: "Too Many Requests",
        statusCode: 429,
        retryAfterMs: 86_400_000,
      },
    });
    expect(decision).toEqual({ kind: "abort" });
  });

  test("retryable 429 without Retry-After keeps the fixed backoff", async () => {
    const decide = policy();
    const situation = (attempt: number) => ({
      attempt,
      elapsedMs: 0,
      error: {
        category: "retryable" as const,
        message: "boom",
        statusCode: 429,
      },
    });
    expect(await decide(situation(1))).toEqual({ kind: "retry", delayMs: 500 });
    expect(await decide(situation(2))).toEqual({
      kind: "retry",
      delayMs: 1000,
    });
    expect(await decide(situation(3))).toEqual({ kind: "abort" });
  });
});
