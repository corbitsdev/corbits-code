import { describe, expect, test } from "bun:test";

import { createCloseAgentTool, createResumeAgentTool } from "./lifecycle-tools.js";
import { createSubAgentSessionStore } from "./session-store.js";

async function callTool(
  tool: ReturnType<typeof createCloseAgentTool> | ReturnType<typeof createResumeAgentTool>,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (tool.kind !== "full") throw new Error(`expected full tool, got ${tool.kind}`);
  const result = await tool.handler(
    { id: `call-${Math.random()}`, name: tool.definition.name, arguments: args },
    new AbortController().signal,
  );
  const content =
    typeof result.content === "string" ? result.content : JSON.stringify(result.content);
  return JSON.parse(content);
}

describe("close_agent", () => {
  test("closes descendants before the parent, and reports not_found for an unknown target", async () => {
    const sessions = createSubAgentSessionStore();
    const parent = sessions.start({ description: "parent", agentId: "a", brief: "b" });
    const child = sessions.start({
      description: "child",
      agentId: "a",
      brief: "b",
      parentSessionId: parent.id,
    });
    const grandchild = sessions.start({
      description: "grandchild",
      agentId: "a",
      brief: "b",
      parentSessionId: child.id,
    });

    const closedOrder: string[] = [];
    for (const id of [parent.id, child.id, grandchild.id]) {
      sessions.registerClose(id, async () => {
        closedOrder.push(id);
      });
    }

    const closeAgent = createCloseAgentTool({ sessions });
    const result = await callTool(closeAgent, { target: parent.id });

    expect(result.status).toBe("shutdown");
    // Descendants close before their ancestor: grandchild, then child, then parent.
    expect(closedOrder).toEqual([grandchild.id, child.id, parent.id]);
    expect(sessions.get(parent.id)?.lifecycleStatus).toBe("shutdown");
    expect(sessions.get(child.id)?.lifecycleStatus).toBe("shutdown");
    expect(sessions.get(grandchild.id)?.lifecycleStatus).toBe("shutdown");

    const missing = await callTool(closeAgent, { target: "does-not-exist" });
    expect(missing.status).toBe("not_found");
  });

  test("a wedged descendant hits its own deadline instead of hanging the whole close", async () => {
    const sessions = createSubAgentSessionStore();
    const parent = sessions.start({ description: "parent", agentId: "a", brief: "b" });
    const wedgedChild = sessions.start({
      description: "child",
      agentId: "a",
      brief: "b",
      parentSessionId: parent.id,
    });
    sessions.registerClose(wedgedChild.id, () => new Promise<void>(() => {}));
    sessions.registerClose(parent.id, async () => {});

    // Exercise the store directly with a short deadline (the tool itself
    // uses the real ~30s bound, which would make this test slow).
    const started = Date.now();
    const childStatus = await sessions.closeOne(wedgedChild.id, 25);
    expect(Date.now() - started).toBeLessThan(500);
    expect(childStatus).toBe("shutdown");
  });
});

describe("resume_agent", () => {
  test("resumes a retained completed session and rejects a non-retained one", async () => {
    const sessions = createSubAgentSessionStore();
    const retained = sessions.start({ description: "d", agentId: "a", brief: "b", retained: true });
    sessions.complete(retained.id, "## Summary\nDone.");

    const notRetained = sessions.start({ description: "d2", agentId: "a", brief: "b" });
    sessions.complete(notRetained.id, "## Summary\nDone.");

    const resumeAgent = createResumeAgentTool({ sessions });

    const ok = await callTool(resumeAgent, { target: retained.id });
    expect(ok.status).toBe("running");
    expect(sessions.get(retained.id)?.lifecycleStatus).toBe("running");

    const rawResult = await (async () => {
      if (resumeAgent.kind !== "full") throw new Error("expected full tool");
      return resumeAgent.handler(
        { id: "call-x", name: "resume_agent", arguments: { target: notRetained.id } },
        new AbortController().signal,
      );
    })();
    expect(rawResult.isError).toBe(true);
  });
});
