import { describe, expect, test } from "bun:test";

import { createPermissionGate } from "../../src/permission/gate.js";
import { closeIntegrationSession, openIntegrationSession, runUntilDone } from "./harness.js";

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe("integration — reactor empty turn", () => {
  test.serial("empty model output settles the send without a reactor error", async () => {
    const session = await openIntegrationSession({
      permissionGate: createPermissionGate({
        approvals: [],
        interactive: false,
        skipPermissions: true,
      }),
    });

    try {
      session.harness.scenario.replyOnce("anthropic", { text: "" });

      const { events, reply } = await withTimeout(runUntilDone(session, "Reply if needed."), 5_000);

      expect(reply).toBe("");
      expect(events.some((event) => event.type === "connector.reply")).toBe(true);
      expect(events.some((event) => event.type === "reactor.error")).toBe(false);
    } finally {
      await closeIntegrationSession(session);
    }
  });
});
