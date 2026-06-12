import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { useInput } from "ink";
import { EventEmitter } from "node:events";
import type { ReactNode } from "react";
import { useGates, type PlanGateEvent, type OperatorGateEvent } from "../../../src/tui/hooks/use-gates.js";

function Harness({ emitter, onGate }: { emitter: EventEmitter; onGate: (pending: boolean) => void }): ReactNode {
  const gates = useGates({ eventEmitter: emitter, setGatePending: onGate });
  useInput((input) => {
    if (input === "a") gates.approve();
    if (input === "r") gates.reject();
    if (input === "0") gates.selectOperator(0);
    if (input === "p") gates.resolvePermission({ allow: true });
  });
  const plan = gates.pendingPlan === null ? "none" : `plan:${gates.pendingPlan.length}`;
  const op = gates.pendingOperator === null ? "none" : `op:${gates.pendingOperator.question}`;
  const perm = gates.pendingPermission === null ? "none" : `perm:${gates.pendingPermission.subject}`;
  return <Text>{`${plan} ${op} ${perm} open=${gates.gateOpen ? "1" : "0"}`}</Text>;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

test("the plan gate surfaces for approval and resolves on approve", async () => {
  const emitter = new EventEmitter();
  let resolved: boolean | null = null;
  const gateCalls: boolean[] = [];
  const { lastFrame, stdin } = render(
    <Harness emitter={emitter} onGate={(p) => gateCalls.push(p)} />,
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
  expect(lastFrame()).toContain("none none none open=0");
  expect(gateCalls).toEqual([true, false]);
});

test("the plan gate resolves false on reject", async () => {
  const emitter = new EventEmitter();
  let resolved: boolean | null = null;
  const { stdin } = render(<Harness emitter={emitter} onGate={() => {}} />);
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
  const { lastFrame, stdin } = render(<Harness emitter={emitter} onGate={() => {}} />);
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
  expect(lastFrame()).toContain("none none none open=0");
});

// E1: two gates open concurrently — each gate independently calls setGatePending
// on open (true) and close (false). The caller (use-stream.ts) owns the refcount;
// use-gates.ts is responsible only for signalling its own gate transitions.
test("E1: each gate independently signals open and close to setGatePending", async () => {
  const emitter = new EventEmitter();
  const gateCalls: boolean[] = [];
  const { stdin } = render(<Harness emitter={emitter} onGate={(p) => gateCalls.push(p)} />);
  await tick();

  // Open the plan gate first.
  const planEvent: PlanGateEvent = {
    plan: [{ file: "a.ts", action: "x" }],
    resolve: () => {},
  };
  emitter.emit("plan.gate", planEvent);
  await tick();
  expect(gateCalls).toEqual([true]);

  // Open the operator gate while plan gate is still open.
  const opEvent: OperatorGateEvent = {
    question: "pick",
    options: ["yes"],
    resolve: () => {},
  };
  emitter.emit("operator.gate", opEvent);
  await tick();
  expect(gateCalls).toEqual([true, true]);

  // Resolve the plan gate — use-gates signals false for it; refcount in
  // use-stream.ts ensures status stays blocked until all gates close.
  stdin.write("a");
  await tick();
  expect(gateCalls).toEqual([true, true, false]);
});

// Two plan gates opened before the first resolves — the second must not
// overwrite the first. Both resolve callbacks must fire with the correct
// values and in FIFO order.
test("Q1: two same-type (plan) gates queued — both resolve in order without dropping", async () => {
  const emitter = new EventEmitter();
  const gateCalls: boolean[] = [];
  let resolved1: boolean | null = null;
  let resolved2: boolean | null = null;
  const { lastFrame, stdin } = render(
    <Harness emitter={emitter} onGate={(p) => gateCalls.push(p)} />,
  );
  await tick();

  emitter.emit("plan.gate", {
    plan: [{ file: "a.ts", action: "x" }],
    resolve: (v: boolean) => { resolved1 = v; },
  } satisfies PlanGateEvent);
  await tick();

  // Second gate arrives while first is still pending.
  emitter.emit("plan.gate", {
    plan: [{ file: "b.ts", action: "y" }],
    resolve: (v: boolean) => { resolved2 = v; },
  } satisfies PlanGateEvent);
  await tick();

  // Each enqueue fires setGatePending(true).
  expect(gateCalls).toEqual([true, true]);
  // Head of queue (first gate) is still showing.
  expect(lastFrame()).toContain("plan:1");

  // Resolve first gate — head advances to second gate.
  stdin.write("a");
  await tick();
  expect(resolved1).toBe(true);
  expect(resolved2).toBeNull(); // second not yet resolved
  expect(gateCalls).toEqual([true, true, false]);
  // Second gate is now the head.
  expect(lastFrame()).toContain("plan:1");
  expect(lastFrame()).toContain("open=1");

  // Resolve second gate.
  stdin.write("r");
  await tick();
  expect(resolved2).toBe(false);
  expect(gateCalls).toEqual([true, true, false, false]);
  expect(lastFrame()).toContain("none none none open=0");
});

// setGatePending refcount discipline: two gates enqueued, one resolved →
// net balance is +1 (still pending from use-stream.ts perspective).
test("Q2: setGatePending sequence for two-open-one-resolved is true,true,false", async () => {
  const emitter = new EventEmitter();
  const gateCalls: boolean[] = [];
  const { stdin } = render(
    <Harness emitter={emitter} onGate={(p) => gateCalls.push(p)} />,
  );
  await tick();

  emitter.emit("plan.gate", {
    plan: [],
    resolve: () => {},
  } satisfies PlanGateEvent);
  await tick();

  emitter.emit("plan.gate", {
    plan: [],
    resolve: () => {},
  } satisfies PlanGateEvent);
  await tick();

  expect(gateCalls).toEqual([true, true]);

  // Resolve the first (head) — one false, but one still in queue.
  stdin.write("a");
  await tick();
  expect(gateCalls).toEqual([true, true, false]);
});

test("permission gate surfaces a request and resolves the outcome", async () => {
  const emitter = new EventEmitter();
  let outcome: { allow: boolean } | null = null;
  const { lastFrame, stdin } = render(<Harness emitter={emitter} onGate={() => {}} />);
  await tick();

  emitter.emit("permission.gate", {
    request: { tool: "run_shell", action: "Run shell command", subject: "npm test", scopes: [] },
    resolve: (o: { allow: boolean }) => { outcome = o; },
  });
  await tick();
  expect(lastFrame()).toContain("perm:npm test");
  expect(lastFrame()).toContain("open=1");

  stdin.write("p");
  await tick();
  expect(outcome).toEqual({ allow: true });
  expect(lastFrame()).toContain("none none none open=0");
});
