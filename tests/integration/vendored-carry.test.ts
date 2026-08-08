import { describe, expect, test } from "bun:test";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAgent,
  createDirectorRegistry,
  defineAgent,
  defineDirector,
} from "@intx/agent";
import { noopAuditStore, permissiveAuthorize } from "@intx/agent/testing";
import type { ExtendedInferenceOptions } from "@intx/inference";
import { setupHarness } from "@intx/inference-testing";
import type { ContextTransform } from "@intx/types/runtime";
import { type } from "arktype";

import { ID_PREFIX } from "../../src/branding.js";
import { createPermissionGate } from "../../src/permission/gate.js";
import { createOptimizedContextStore } from "../../src/session/optimized-context-store.js";
import {
  closeIntegrationSession,
  INTEGRATION_SOURCE,
  openIntegrationSession,
  runUntilDone,
} from "./harness.js";

// Pins the two surfaces the published @intx packages do not carry, exercised
// through the real createAgent path: contextTransforms must survive the
// deps-riding channel into the vendored reactor assembly, and ephemeralTurns
// must reach the wire without entering durable history. A regression in
// either is invisible to typecheck (the published agent ignores unknown env
// fields), so these tests are the gate.

const TRANSFORM_MARKER = "VENDORED-CARRY-TRANSFORM-MARKER";
const NUDGE_MARKER = "VENDORED-CARRY-EPHEMERAL-NUDGE";

function markerTransform(): ContextTransform {
  return {
    name: "vendored-carry-marker",
    version: "1",
    async apply(turns, _ctx) {
      const output = [
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: TRANSFORM_MARKER }],
          timestamp: 0,
        },
        ...turns,
      ];
      return {
        output,
        record: {
          strategy: "vendored-carry-marker",
          version: "1",
          parameters: {},
          reason: "test-marker",
          decisions: {},
        },
      };
    },
  };
}

describe("integration — vendored feature carry", () => {
  test.serial("contextTransforms riding deps reach the materialized prompt", async () => {
    const session = await openIntegrationSession({
      permissionGate: createPermissionGate({
        approvals: [],
        interactive: false,
        skipPermissions: true,
      }),
      contextTransforms: [markerTransform()],
    });

    try {
      session.harness.scenario.replyOnce("anthropic", { text: "ok" });
      await runUntilDone(session, "hello");

      const requests = session.harness.scenario.matchedRequests();
      expect(requests.length).toBeGreaterThan(0);
      const bodies = await Promise.all(requests.map((r) => r.clone().text()));
      expect(bodies.some((b) => b.includes(TRANSFORM_MARKER))).toBe(true);
    } finally {
      await closeIntegrationSession(session);
    }
  });

  test.serial("ephemeralTurns reach the wire but never durable history", async () => {
    const harness = setupHarness();
    const cwd = mkdtempSync(join(tmpdir(), "corbits-vendored-carry-"));
    const workdir = join(cwd, ".agent-state", "carry-session");

    // Minimal director: every user message infers with an ephemeral nudge
    // attached, exactly the shape the chat director's terminal rewrites emit.
    const nudgeDirectorDef = defineDirector({
      id: `${ID_PREFIX}/carry-nudge`,
      configSchema: type({}),
      factory: () => ({
        async decide(event, _state, caps) {
          if (event.type === "message.received") {
            const options: ExtendedInferenceOptions = {
              ephemeralTurns: [
                {
                  role: "user",
                  content: [{ type: "text", text: NUDGE_MARKER }],
                  timestamp: 0,
                },
              ],
            };
            return caps.infer(options);
          }
          if (event.type === "inference.done") {
            const text = event.turn.content.find((b) => b.type === "text");
            return caps.reply(text?.type === "text" ? text.text : "done");
          }
          return caps.wait();
        },
      }),
    });

    const def = defineAgent({
      id: `${ID_PREFIX}/carry-agent`,
      systemPrompt: "Test agent.",
      tools: [],
      capabilities: [],
      director: nudgeDirectorDef.build({}),
      inference: {
        sources: [{ provider: INTEGRATION_SOURCE.provider, model: INTEGRATION_SOURCE.model }],
      },
    });

    const storage = await createOptimizedContextStore(workdir);
    const agent = await createAgent(def, {
      sources: [INTEGRATION_SOURCE],
      defaultSource: INTEGRATION_SOURCE.id,
      storage,
      workdir,
      deps: harness.deps,
      audit: noopAuditStore(),
      authorize: permissiveAuthorize(),
      directors: createDirectorRegistry({
        factories: [nudgeDirectorDef.factory],
        defaultId: `${ID_PREFIX}/carry-nudge`,
      }),
      closeTimeoutMs: 0,
    });

    try {
      harness.scenario.replyOnce("anthropic", { text: "ok" });
      await Promise.all([
        agent.send("hello"),
        harness.run({ wallClockBudgetMs: Infinity }),
      ]);

      const requests = harness.scenario.matchedRequests();
      expect(requests.length).toBeGreaterThan(0);
      const bodies = await Promise.all(requests.map((r) => r.clone().text()));
      expect(bodies.some((b) => b.includes(NUDGE_MARKER))).toBe(true);

      // Prompt-only: the nudge must not be persisted.
      const history = await agent.history();
      expect(JSON.stringify(history).includes(NUDGE_MARKER)).toBe(false);
    } finally {
      await agent.close();
      harness.dispose();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
