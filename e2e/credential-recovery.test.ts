import { describe, expect, test } from "bun:test";
import { createDefaultScheduler } from "@intx/inference";
import type { RequestPredicate } from "@intx/inference-testing";
import { type } from "arktype";

import { createCorbitsRetryPolicy } from "../src/agent/retry-policy.js";
import {
  applyCredentialRecoverySelection,
  buildCredentialRecoveryAlternatives,
  createCredentialRecoveryState,
} from "../src/tui/runner/credential-recovery.js";
import {
  closeE2ESession,
  e2ePermissionGate,
  openE2ESession,
  sendOperatorTurn,
} from "./harness.js";

function required<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(label);
  return value;
}

const RequestURL = type({ url: "string" });
const fromHost =
  (host: string): RequestPredicate =>
  (request) =>
    RequestURL.assert(request).url.includes(host);

const PRIMARY_HOST = "primary.invalid";
const PRIMARY = {
  id: "e2e-cred-primary",
  provider: "anthropic",
  baseURL: `https://${PRIMARY_HOST}`,
  credentialId: "e2e-cred-primary",
  model: "claude-primary",
};
const BACKUP_HOST = "backup.invalid";
const BACKUP = {
  id: "e2e-cred-backup",
  provider: "openai",
  baseURL: `https://${BACKUP_HOST}/v1`,
  credentialId: "e2e-cred-backup",
  model: "backup-model",
};

async function waitForEvent(
  events: readonly { type: string; data: unknown }[],
  predicate: (event: { type: string; data: unknown }) => boolean,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (events.some(predicate)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for the recovery turn to settle");
}

describe("e2e — credential recovery switches the live source", () => {
  test.serial(
    "a repeated credential failure arms recovery; the accepted backup serves the replay",
    async () => {
      const session = await openE2ESession({
        permissionGate: e2ePermissionGate(),
        sources: [PRIMARY],
        credentialRecords: {
          [PRIMARY.credentialId]: {
            provenance: { kind: "oauth", provider: "codex", profile: "work" },
            material: { secret: "expired-token" },
          },
          [BACKUP.credentialId]: {
            provenance: { kind: "api-key" },
            material: { secret: "backup-key" },
          },
        },
        // The production Corbits policy with a stubbed OAuth refresh —
        // the refresh succeeds, the retry is armed, the second 401 is
        // terminal. A real scheduler lets the zero-delay retry actually
        // elapse; the harness scheduler is inert.
        retryPolicy: createCorbitsRetryPolicy({
          providerId: PRIMARY.id,
          refreshCredential: async () => undefined,
        }),
        depsOverrides: { scheduler: createDefaultScheduler() },
      });
      try {
        const primary = fromHost(PRIMARY_HOST);
        const backup = fromHost(BACKUP_HOST);
        session.harness.scenario.replyOnce("anthropic", {
          predicate: primary,
          text: "unauthorized",
          responseOpts: { status: 401 },
        });
        session.harness.scenario.replyOnce("anthropic", {
          predicate: primary,
          text: "still unauthorized",
          responseOpts: { status: 401 },
        });
        session.harness.scenario.replyOnce("openai", {
          predicate: backup,
          text: "recovered on backup",
        });

        const { message, events } = await sendOperatorTurn(
          session,
          "recover me",
        );

        // Same event stream the TUI's streamSink feeds the state machine.
        const recovery = createCredentialRecoveryState();
        const attempt = recovery.begin(message, PRIMARY.provider);
        for (const event of events) recovery.observe(attempt, event);
        const pending = recovery.settle(
          attempt,
          buildCredentialRecoveryAlternatives(
            {
              providers: [
                {
                  name: PRIMARY.provider,
                  baseURL: PRIMARY.baseURL,
                  apiKey: "dead",
                  models: [PRIMARY.model],
                },
                {
                  name: BACKUP.provider,
                  baseURL: BACKUP.baseURL,
                  apiKey: "backup-key",
                  models: [BACKUP.model],
                },
              ],
              providerName: PRIMARY.provider,
              model: PRIMARY.model,
            } as never,
            "e2e-session",
            attempt.failedProvider,
          ),
        );
        expect(pending).not.toBeNull();
        const armed = required(pending, "recovery did not arm");
        const alternative = required(
          armed.alternatives.find(
            (candidate) => candidate.provider === BACKUP.provider,
          ),
          "no backup alternative offered",
        );

        // Phase 2: the real switch path — setSources on the live agent,
        // arm on the real director, deliver the continuation, then pump
        // the replayed turn through the backup provider.
        const pump = session.harness.run({ wallClockBudgetMs: Infinity });
        const acceptance = applyCredentialRecoverySelection({
          state: recovery,
          generation: armed.generation,
          alternativeId: alternative.id,
          switchAlternative: () => {
            session.agent.setSources([BACKUP], BACKUP.id);
          },
          armContinuation: (generation) =>
            session.chatDirector.armCredentialRecoveryContinuation(generation),
          cancelContinuation: (generation) =>
            session.chatDirector.cancelCredentialRecoveryContinuation(
              generation,
            ),
          deliverContinuation: (m) => session.agent.deliver(m),
        });
        expect(acceptance).toBe("continued");
        await pump;
        await waitForEvent(
          events,
          (event) =>
            event.type === "connector.reply" &&
            JSON.stringify(event.data).includes("recovered on backup"),
        );

        const requests = session.harness.scenario.matchedRequests();
        const primaryHits = requests.filter((r) =>
          RequestURL.assert(r).url.includes(PRIMARY_HOST),
        );
        const backupHits = requests.filter((r) =>
          RequestURL.assert(r).url.includes(BACKUP_HOST),
        );
        // Two primary hits prove the refresh→retry path ran: an inert or
        // api-key provenance would terminal-fail after the first 401.
        expect(primaryHits).toHaveLength(2);
        expect(backupHits).toHaveLength(1);
        // The replay carries the original operator message, not a synthetic
        // "recovered" prompt.
        const body = await (
          required(backupHits[0], "backup never served").clone() as Request
        ).text();
        expect(body).toContain("recover me");
      } finally {
        await closeE2ESession(session);
      }
    },
    60000,
  );
});
