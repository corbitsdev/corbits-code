import { test, expect } from "bun:test";
import type { ReactorEmittedEvent } from "@intx/inference";
import { createAgentStreamState } from "../../../src/tui/use-stream.js";

function ev(type: string, data: unknown): ReactorEmittedEvent {
  return { type, data } as unknown as ReactorEmittedEvent;
}

function submitPlan(s: ReturnType<typeof createAgentStreamState>, steps: Array<{ file: string; action: string }>): void {
  s.addEvent(ev("inference.tool_call.start", { name: "submit_plan", callId: "plan" }));
  s.addEvent(ev("inference.tool_call.delta", { argumentFragment: JSON.stringify({ steps }) }));
  s.addEvent(ev("tool.done", { result: { callId: "plan", content: "ok", isError: false } }));
}

function write(s: ReturnType<typeof createAgentStreamState>, callId: string, path: string): void {
  s.addEvent(ev("inference.tool_call.start", { name: "write_file", callId }));
  s.addEvent(ev("inference.tool_call.delta", { argumentFragment: JSON.stringify({ path, content: "z" }) }));
  s.addEvent(ev("tool.done", { result: { callId, content: `wrote 1 bytes to ${path}`, isError: false } }));
}

test("advances on matching write, deviates on mismatch", () => {
  const s = createAgentStreamState();
  submitPlan(s, [{ file: "a.ts", action: "x" }, { file: "b.ts", action: "y" }]);
  expect(s.currentPlanStep).toBe(0);
  expect(s.planTotal).toBe(2);

  write(s, "c1", "a.ts");
  expect(s.currentPlanStep).toBe(1);
  expect(s.planDeviated).toBe(false);

  write(s, "c2", "zzz.ts");
  expect(s.planDeviated).toBe(true);
  expect(s.currentPlanStep).toBe(1);
});

test("a correct write clears a prior deviation", () => {
  const s = createAgentStreamState();
  submitPlan(s, [{ file: "a.ts", action: "x" }, { file: "b.ts", action: "y" }]);
  write(s, "c1", "a.ts");
  write(s, "c2", "zzz.ts");
  expect(s.planDeviated).toBe(true);

  write(s, "c3", "b.ts");
  expect(s.planDeviated).toBe(false);
  expect(s.currentPlanStep).toBe(1);
});

test("fileless steps never trigger a deviation", () => {
  const s = createAgentStreamState();
  submitPlan(s, [{ file: "", action: "investigate" }, { file: "a.ts", action: "fix" }]);
  expect(s.currentPlanStep).toBe(0);

  write(s, "c1", "a.ts");
  expect(s.planDeviated).toBe(false);
  expect(s.currentPlanStep).toBe(1);
});

test("write with no plan does not advance or deviate", () => {
  const s = createAgentStreamState();
  write(s, "c1", "a.ts");
  expect(s.currentPlanStep).toBeNull();
  expect(s.planDeviated).toBe(false);
});
