import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { useInput } from "ink";
import { EventEmitter } from "node:events";
import type { ReactNode } from "react";
import { useGates, type PlanGateEvent, type OperatorGateEvent } from "../../../src/tui/hooks/use-gates.js";
import type { Mode } from "../../../src/config.js";

function Harness({ emitter, mode, onGate }: { emitter: EventEmitter; mode: Mode; onGate: (pending: boolean) => void }): ReactNode {
  const gates = useGates({ eventEmitter: emitter, mode, setGatePending: onGate });
  useInput((input) => {
    if (input === "a") gates.approve();
    if (input === "r") gates.reject();
    if (input === "0") gates.selectOperator(0);
  });
  const plan = gates.pendingPlan === null ? "none" : `plan:${gates.pendingPlan.length}`;
  const op = gates.pendingOperator === null ? "none" : `op:${gates.pendingOperator.question}`;
  return <Text>{`${plan} ${op} open=${gates.gateOpen ? "1" : "0"}`}</Text>;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

test("teammate mode auto-approves the plan gate without surfacing it", async () => {
  const emitter = new EventEmitter();
  let resolved: boolean | null = null;
  const { lastFrame } = render(<Harness emitter={emitter} mode="teammate" onGate={() => {}} />);
  await tick();

  const event: PlanGateEvent = { plan: [{ file: "a.ts", action: "x" }], resolve: (v) => { resolved = v; } };
  emitter.emit("plan.gate", event);
  await tick();

  expect(resolved).toBe(true);
  expect(lastFrame()).toContain("none none open=0");
});

test("manager mode surfaces the plan gate and resolves on approve", async () => {
  const emitter = new EventEmitter();
  let resolved: boolean | null = null;
  const gateCalls: boolean[] = [];
  const { lastFrame, stdin } = render(
    <Harness emitter={emitter} mode="manager" onGate={(p) => gateCalls.push(p)} />,
  );
  await tick();

  const event: PlanGateEvent = { plan: [{ file: "a.ts", action: "x" }], resolve: (v) => { resolved = v; } };
  emitter.emit("plan.gate", event);
  await tick();
  expect(lastFrame()).toContain("plan:1");
  expect(lastFrame()).toContain("open=1");
  expect(gateCalls).toEqual([true]);

  stdin.write("a");
  await tick();
  expect(resolved).toBe(true);
  expect(lastFrame()).toContain("none none open=0");
  expect(gateCalls).toEqual([true, false]);
});

test("manager mode resolves false on reject", async () => {
  const emitter = new EventEmitter();
  let resolved: boolean | null = null;
  const { stdin } = render(<Harness emitter={emitter} mode="manager" onGate={() => {}} />);
  await tick();
  emitter.emit("plan.gate", { plan: [], resolve: (v: boolean) => { resolved = v; } } satisfies PlanGateEvent);
  await tick();
  stdin.write("r");
  await tick();
  expect(resolved).toBe(false);
});

test("operator gate surfaces and resolves the selected index", async () => {
  const emitter = new EventEmitter();
  let chosen: number | null = null;
  const { lastFrame, stdin } = render(<Harness emitter={emitter} mode="teammate" onGate={() => {}} />);
  await tick();

  const event: OperatorGateEvent = {
    question: "pick",
    options: ["one", "two"],
    resolve: (i) => { chosen = i; },
  };
  emitter.emit("operator.gate", event);
  await tick();
  expect(lastFrame()).toContain("op:pick");
  expect(lastFrame()).toContain("open=1");

  stdin.write("0");
  await tick();
  expect(chosen).toBe(0);
  expect(lastFrame()).toContain("none none open=0");
});
