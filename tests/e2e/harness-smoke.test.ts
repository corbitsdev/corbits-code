import { describe, expect, test } from "bun:test";

import {
  closeE2ESession,
  e2ePermissionGate,
  openE2ESession,
  runUntilDone,
  scriptReplies,
  seedFile,
  toolDoneEvents,
} from "./harness.js";

describe("e2e harness smoke", () => {
  test("a scripted read call round-trips through the production toolset", async () => {
    const session = await openE2ESession({
      permissionGate: e2ePermissionGate(),
    });
    try {
      seedFile(session, "notes/hello.txt", "e2e says hi\n");
      scriptReplies(session, [
        {
          text: "Reading the file.",
          toolCalls: [{ name: "read", args: { path: "notes/hello.txt" } }],
        },
        { text: "The file says hi." },
      ]);
      const { events, reply } = await runUntilDone(session, "Read hello.txt");
      const reads = toolDoneEvents(events).filter(
        (e) => e.data.result.callId !== undefined,
      );
      expect(reads.length).toBe(1);
      expect(String(reads[0]?.data.result.content)).toContain("e2e says hi");
      expect(reply).toContain("hi");
    } finally {
      await closeE2ESession(session);
    }
  });
});
