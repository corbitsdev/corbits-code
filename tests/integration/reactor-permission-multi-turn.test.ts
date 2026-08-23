import { describe, expect, test } from "bun:test";

import { createPermissionGate } from "../../src/permission/gate.js";
import {
  closeIntegrationSession,
  openIntegrationSession,
  runUntilDone,
  toolDoneEvents,
} from "./harness.js";

describe("integration — reactor permission + multi-turn", () => {
  test.serial(
    "declined run_shell surfaces permission denial and ends without reactor.error",
    async () => {
      let asked = 0;
      const session = await openIntegrationSession({
        permissionGate: createPermissionGate({
          approvals: [],
          interactive: true,
          skipPermissions: false,
          requestApproval: async () => {
            asked++;
            return { allow: false };
          },
        }),
      });

      try {
        session.harness.scenario.replyOnce("anthropic", {
          toolCalls: [
            {
              name: "run_shell",
              args: { command: "curl https://example.com" },
            },
          ],
        });
        session.harness.scenario.replyOnce("anthropic", {
          text: "Understood; I will not retry that command.",
        });

        const { events, reply } = await runUntilDone(
          session,
          "Please fetch example.com with curl.",
        );

        expect(asked).toBeGreaterThan(0);
        expect(events.some((e) => e.type === "reactor.error")).toBe(false);

        const toolDones = toolDoneEvents(events);
        expect(toolDones.length).toBeGreaterThanOrEqual(1);
        const denied = toolDones.find(
          (e) =>
            e.data.result.isError === true &&
            typeof e.data.result.content === "string" &&
            e.data.result.content.includes("Blocked by permission policy"),
        );
        expect(denied).toBeDefined();

        expect(
          reply.includes("Tool call rejected by operator.") || reply.includes("Understood"),
        ).toBe(true);
      } finally {
        await closeIntegrationSession(session);
      }
    },
  );

  test.serial(
    "approved run_shell executes after operator approval and second inference turn completes",
    async () => {
      let asked = 0;
      const session = await openIntegrationSession({
        permissionGate: createPermissionGate({
          approvals: [],
          interactive: true,
          skipPermissions: false,
          auto: false,
          requestApproval: async () => {
            asked++;
            return { allow: true };
          },
        }),
      });

      try {
        // Primary Skywalker does not mount write_file; permission multi-turn
        // still covers a consequential tool that remains on the primary surface.
        session.harness.scenario.replyOnce("anthropic", {
          toolCalls: [
            {
              name: "run_shell",
              args: { command: "curl -sS https://example.com" },
            },
          ],
        });
        session.harness.scenario.replyOnce("anthropic", {
          text: "Fetched.",
        });

        const { events } = await runUntilDone(session, "Please fetch example.com with curl.");

        expect(asked).toBeGreaterThan(0);
        expect(events.some((e) => e.type === "reactor.error")).toBe(false);

        const toolDones = toolDoneEvents(events);
        expect(toolDones.length).toBeGreaterThanOrEqual(1);
        const denied = toolDones.find(
          (e) =>
            e.data.result.isError === true &&
            typeof e.data.result.content === "string" &&
            e.data.result.content.includes("Blocked by permission policy"),
        );
        expect(denied).toBeUndefined();
      } finally {
        await closeIntegrationSession(session);
      }
    },
  );

  test.serial("two user sends on the same agent retain both turns in history", async () => {
    const session = await openIntegrationSession({
      permissionGate: createPermissionGate({
        approvals: [],
        interactive: false,
        skipPermissions: true,
      }),
    });

    try {
      session.harness.scenario.replyOnce("anthropic", { text: "First reply." });
      session.harness.scenario.replyOnce("anthropic", { text: "Second reply." });

      await runUntilDone(session, "First message.");
      await runUntilDone(session, "Second message.");

      const history = await session.agent.history();
      const userTexts = history
        .filter((t) => t.role === "user")
        .flatMap((t) => t.content)
        .filter((b) => b.type === "text")
        .map((b) => (b.type === "text" ? b.text : ""));

      expect(userTexts.some((t) => t.includes("First message"))).toBe(true);
      expect(userTexts.some((t) => t.includes("Second message"))).toBe(true);

      const assistantTexts = history
        .filter((t) => t.role === "assistant")
        .flatMap((t) => t.content)
        .filter((b) => b.type === "text")
        .map((b) => (b.type === "text" ? b.text : ""));

      expect(assistantTexts.some((t) => t.includes("First reply"))).toBe(true);
      expect(assistantTexts.some((t) => t.includes("Second reply"))).toBe(true);
    } finally {
      await closeIntegrationSession(session);
    }
  });
});
