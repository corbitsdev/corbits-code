import { test, expect, mock } from "bun:test";
import { AgentClosedError } from "@intx/agent";
import { setAgentSourceUnlessClosed } from "../../../src/tui/agent-source-sync.js";

const SOURCE = { id: "openai", provider: "openai", model: "gpt-4o" } as const;

test("setAgentSourceUnlessClosed forwards to the agent when open", () => {
  const setSource = mock(() => undefined);
  setAgentSourceUnlessClosed({ setSource } as never, SOURCE as never);
  expect(setSource).toHaveBeenCalledWith(SOURCE);
});

test("setAgentSourceUnlessClosed swallows AgentClosedError", () => {
  const setSource = mock(() => {
    throw new AgentClosedError();
  });
  expect(() => setAgentSourceUnlessClosed({ setSource } as never, SOURCE as never)).not.toThrow();
});

test("setAgentSourceUnlessClosed rethrows unexpected errors", () => {
  const setSource = mock(() => {
    throw new Error("boom");
  });
  expect(() => setAgentSourceUnlessClosed({ setSource } as never, SOURCE as never)).toThrow("boom");
});
