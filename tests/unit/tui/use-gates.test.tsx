import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { useInput } from "ink";
import { EventEmitter } from "node:events";
import type { ReactNode } from "react";
import { useGates, type PlanGateEvent, type OperatorGateEvent } from "../../../src/tui/hooks/use-gates.js";

function Harness({ emitter, onGate, onReset }: { emitter: EventEmitter; onGate: (pending: boolean) => void; onReset?: (resetFn: () => void) => void }): ReactNode {
  const gates = useGates({ eventEmitter: emitter, setGatePending: onGate });
  useInput((input) => {
    if (input === "a") gates.approve();
    if (input === "r") gates.reject();
    if (input === "0") gates.selectOperator({ kind: "option", index: 0 });
    if (input === "p") gates.resolvePermission({ allow: true });
    if (input === "q") gates.resolvePermission({ allow: false });
    if (input === "g") {
      gates.resolvePermission({
        allow: true,
        persist: { id: "session", label: "Allow bun install", pattern: "bun install", grant: "session" },
      });
    }
    if (input === "x") gates.resetGates();
  });
  // Expose resetGates to the test once on first render.
  onReset?.(gates.resetGates);
  const plan = gates.pendingPlan === null ? "none" : `plan:${gates.pendingPlan.length}`;
  const op = gates.pendingOperator === null ? "none" : `op:${gates.pendingOperator.question}`;
  const perm = gates.pendingPermission === null ? "none" : `perm:${gates.pendingPermission.subject}`;
  return <Text>{`${plan} ${op} ${perm} open=${gates.gateOpen ? "1" : "0"} batch=${gates.permissionBatchSize}`}</Text>;
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
    resolve: (result) => { chosen = result.kind === "option" ? result.index : -1; },
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

// Parallel duplicate tool calls enqueue identical permission gates. One
// operator decision resolves every queued request with the same tool and
// subject — and nothing else.
test("one permission decision resolves all queued identical requests", async () => {
  const emitter = new EventEmitter();
  const gateCalls: boolean[] = [];
  const outcomes: Array<{ allow: boolean }> = [];
  const { lastFrame, stdin } = render(
    <Harness emitter={emitter} onGate={(p) => gateCalls.push(p)} />,
  );
  await tick();

  emitter.emit("permission.gate", {
    request: { tool: "run_shell", action: "Run", subject: "bun install", scopes: [] },
    resolve: (o: { allow: boolean }) => { outcomes.push(o); },
  });
  emitter.emit("permission.gate", {
    request: { tool: "run_shell", action: "Run", subject: "bun install", scopes: [] },
    resolve: (o: { allow: boolean }) => { outcomes.push(o); },
  });
  await tick();

  expect(lastFrame()).toContain("perm:bun install");
  expect(lastFrame()).toContain("batch=2");
  expect(gateCalls).toEqual([true, true]);

  stdin.write("p");
  await tick();

  expect(outcomes).toEqual([{ allow: true }, { allow: true }]);
  expect(gateCalls).toEqual([true, true, false, false]);
  expect(lastFrame()).toContain("none none none open=0");
});

// A queue mixing tools must never be resolved by one decision: only requests
// identical to the visible one are covered; the rest prompt on their own.
test("a decision on the head leaves queued requests for other tools pending", async () => {
  const emitter = new EventEmitter();
  const outcomes: Array<{ tool: string; allow: boolean }> = [];
  const { lastFrame, stdin } = render(<Harness emitter={emitter} onGate={() => {}} />);
  await tick();

  emitter.emit("permission.gate", {
    request: { tool: "run_shell", action: "Run", subject: "bun install", scopes: [] },
    resolve: (o: { allow: boolean }) => { outcomes.push({ tool: "run_shell", allow: o.allow }); },
  });
  emitter.emit("permission.gate", {
    request: { tool: "write_file", action: "Write", subject: "/etc/hosts", scopes: [] },
    resolve: (o: { allow: boolean }) => { outcomes.push({ tool: "write_file", allow: o.allow }); },
  });
  await tick();
  expect(lastFrame()).toContain("perm:bun install");
  expect(lastFrame()).toContain("batch=1");

  stdin.write("p");
  await tick();

  expect(outcomes).toEqual([{ tool: "run_shell", allow: true }]);
  expect(lastFrame()).toContain("perm:/etc/hosts");
  expect(lastFrame()).toContain("open=1");

  stdin.write("q");
  await tick();
  expect(outcomes).toEqual([
    { tool: "run_shell", allow: true },
    { tool: "write_file", allow: false },
  ]);
  expect(lastFrame()).toContain("none none none open=0");
});

test("one rejection resolves all queued identical requests as denied", async () => {
  const emitter = new EventEmitter();
  const outcomes: Array<{ allow: boolean }> = [];
  const { lastFrame, stdin } = render(<Harness emitter={emitter} onGate={() => {}} />);
  await tick();

  emitter.emit("permission.gate", {
    request: { tool: "run_shell", action: "Run", subject: "bun install", scopes: [] },
    resolve: (o: { allow: boolean }) => { outcomes.push(o); },
  });
  emitter.emit("permission.gate", {
    request: { tool: "run_shell", action: "Run", subject: "bun install", scopes: [] },
    resolve: (o: { allow: boolean }) => { outcomes.push(o); },
  });
  await tick();

  stdin.write("q");
  await tick();

  expect(outcomes).toEqual([{ allow: false }, { allow: false }]);
  expect(lastFrame()).toContain("none none none open=0");
});

// A persistent grant chosen while duplicates are queued must be written once:
// the head carries the persist payload, duplicates resolve allow-once.
test("a persistent grant in batch mode applies to the head request only", async () => {
  const emitter = new EventEmitter();
  const outcomes: Array<{ allow: boolean; persist?: unknown }> = [];
  const { stdin } = render(<Harness emitter={emitter} onGate={() => {}} />);
  await tick();

  emitter.emit("permission.gate", {
    request: { tool: "run_shell", action: "Run", subject: "bun install", scopes: [] },
    resolve: (o: { allow: boolean; persist?: unknown }) => { outcomes.push(o); },
  });
  emitter.emit("permission.gate", {
    request: { tool: "run_shell", action: "Run", subject: "bun install", scopes: [] },
    resolve: (o: { allow: boolean; persist?: unknown }) => { outcomes.push(o); },
  });
  await tick();

  stdin.write("g");
  await tick();

  expect(outcomes).toHaveLength(2);
  expect(outcomes[0]?.allow).toBe(true);
  expect(outcomes[0]?.persist).toEqual({
    id: "session",
    label: "Allow bun install",
    pattern: "bun install",
    grant: "session",
  });
  expect(outcomes[1]?.allow).toBe(true);
  expect(outcomes[1]?.persist).toBeUndefined();
});

// A request that arrives while the decision modal is already open is only
// covered when it is identical to what the modal shows; anything else waits
// for its own prompt.
test("a different request arriving while the modal is open is not covered by the decision", async () => {
  const emitter = new EventEmitter();
  const outcomes: Array<{ subject: string; allow: boolean }> = [];
  const { lastFrame, stdin } = render(<Harness emitter={emitter} onGate={() => {}} />);
  await tick();

  emitter.emit("permission.gate", {
    request: { tool: "run_shell", action: "Run", subject: "bun install", scopes: [] },
    resolve: (o: { allow: boolean }) => { outcomes.push({ subject: "bun install", allow: o.allow }); },
  });
  await tick();
  expect(lastFrame()).toContain("perm:bun install");

  // Arrives while the modal is open: identical, so the decision covers it.
  emitter.emit("permission.gate", {
    request: { tool: "run_shell", action: "Run", subject: "bun install", scopes: [] },
    resolve: (o: { allow: boolean }) => { outcomes.push({ subject: "bun install", allow: o.allow }); },
  });
  // Arrives while the modal is open: different subject, must not be covered.
  emitter.emit("permission.gate", {
    request: { tool: "run_shell", action: "Run", subject: "rm -rf /tmp/x", scopes: [] },
    resolve: (o: { allow: boolean }) => { outcomes.push({ subject: "rm -rf /tmp/x", allow: o.allow }); },
  });
  await tick();
  expect(lastFrame()).toContain("batch=2");

  stdin.write("p");
  await tick();

  expect(outcomes).toEqual([
    { subject: "bun install", allow: true },
    { subject: "bun install", allow: true },
  ]);
  expect(lastFrame()).toContain("perm:rm -rf /tmp/x");
  expect(lastFrame()).toContain("open=1");

  stdin.write("q");
  await tick();
  expect(outcomes[2]).toEqual({ subject: "rm -rf /tmp/x", allow: false });
  expect(lastFrame()).toContain("none none none open=0");
});

// resetGates drains all queues, resolves each with safe defaults, and clears
// visible state — simulating a /clear rotation that fires while gates are open.
test("resetGates resolves all pending gates and clears visible state", async () => {
  const emitter = new EventEmitter();
  const gateCalls: boolean[] = [];
  let planResolved: boolean | null = null;
  let opResolved: string | null = null;
  let permResolved: { allow: boolean } | null = null;

  const { lastFrame, stdin } = render(
    <Harness emitter={emitter} onGate={(p) => gateCalls.push(p)} />,
  );
  await tick();

  // Open one of each gate type.
  emitter.emit("plan.gate", {
    plan: [{ file: "a.ts", action: "write" }],
    resolve: (v: boolean) => { planResolved = v; },
  } satisfies PlanGateEvent);

  emitter.emit("operator.gate", {
    question: "continue?",
    options: ["yes"],
    resolve: (result) => { opResolved = result.kind; },
  } satisfies OperatorGateEvent);

  emitter.emit("permission.gate", {
    request: { tool: "run_shell", action: "Run shell command", subject: "rm -rf", scopes: [] },
    resolve: (o: { allow: boolean }) => { permResolved = o; },
  });
  await tick();

  expect(lastFrame()).toContain("open=1");

  // Trigger reset via keystroke.
  stdin.write("x");
  await tick();

  // All gates resolved with safe defaults.
  expect(planResolved).toBe(false);
  expect(opResolved).toBe("cancel");
  expect(permResolved).toEqual({ allow: false });

  // UI reflects cleared state.
  expect(lastFrame()).toContain("none none none open=0");
  // Each enqueued gate must balance its setGatePending(true) on reset.
  expect(gateCalls).toEqual([true, true, true, false, false, false]);
});

test("resetGates balances refcount when multiple permission gates are queued", async () => {
  const emitter = new EventEmitter();
  const gateCalls: boolean[] = [];
  const { stdin } = render(<Harness emitter={emitter} onGate={(p) => gateCalls.push(p)} />);
  await tick();

  emitter.emit("permission.gate", {
    request: { tool: "run_shell", action: "Run", subject: "a", scopes: [] },
    resolve: () => {},
  });
  emitter.emit("permission.gate", {
    request: { tool: "run_shell", action: "Run", subject: "b", scopes: [] },
    resolve: () => {},
  });
  await tick();

  expect(gateCalls).toEqual([true, true]);

  stdin.write("x");
  await tick();

  expect(gateCalls).toEqual([true, true, false, false]);
});

test("goal-mode permission timeout auto-denies with a message for the agent", async () => {
  const emitter = new EventEmitter();
  let outcome: { allow: boolean; message?: string } | null = null;
  const { lastFrame } = render(<Harness emitter={emitter} onGate={() => {}} />);
  await tick();

  emitter.emit("permission.gate", {
    request: { tool: "run_shell", action: "Run", subject: "bun install", scopes: [] },
    resolve: (o: { allow: boolean; message?: string }) => {
      outcome = o;
    },
    timeoutMs: 40,
    timeoutMessage: "Goal mode: skipped (test)",
  });
  await tick();
  expect(lastFrame()).toContain("perm:bun install");
  expect(outcome).toBeNull();

  await new Promise((r) => setTimeout(r, 80));
  expect(outcome).toEqual({ allow: false, message: "Goal mode: skipped (test)" });
  expect(lastFrame()).toContain("none none none open=0");
});

test("operator answer before goal timeout cancels the timer", async () => {
  const emitter = new EventEmitter();
  let outcome: { allow: boolean } | null = null;
  const { stdin, lastFrame } = render(<Harness emitter={emitter} onGate={() => {}} />);
  await tick();

  emitter.emit("permission.gate", {
    request: { tool: "run_shell", action: "Run", subject: "ls", scopes: [] },
    resolve: (o: { allow: boolean }) => {
      outcome = o;
    },
    timeoutMs: 200,
    timeoutMessage: "should not fire",
  });
  await tick();
  stdin.write("p");
  await tick();
  expect(outcome).toEqual({ allow: true });
  expect(lastFrame()).toContain("open=0");

  // Wait past the original timeout — must not double-resolve or flip outcome.
  await new Promise((r) => setTimeout(r, 250));
  expect(outcome).toEqual({ allow: true });
});

test("queued permission timeout starts only when the request becomes visible head", async () => {
  const emitter = new EventEmitter();
  let first: { allow: boolean; message?: string } | null = null;
  let second: { allow: boolean; message?: string } | null = null;
  const { stdin, lastFrame } = render(<Harness emitter={emitter} onGate={() => {}} />);
  await tick();

  emitter.emit("permission.gate", {
    request: { tool: "run_shell", action: "Run", subject: "first", scopes: [] },
    resolve: (o: { allow: boolean; message?: string }) => {
      first = o;
    },
    timeoutMs: 500,
    timeoutMessage: "first timed out",
  });
  emitter.emit("permission.gate", {
    request: { tool: "run_shell", action: "Run", subject: "second", scopes: [] },
    resolve: (o: { allow: boolean; message?: string }) => {
      second = o;
    },
    timeoutMs: 80,
    timeoutMessage: "second timed out",
  });
  await tick();
  expect(lastFrame()).toContain("perm:first");
  expect(first).toBeNull();
  expect(second).toBeNull();

  // Hold the first modal longer than the second entry's timeout budget. The
  // second must not auto-deny while still queued (timer arms only when head).
  await new Promise((r) => setTimeout(r, 120));
  expect(first).toBeNull();
  expect(second).toBeNull();
  expect(lastFrame()).toContain("perm:first");

  // Approve first — second becomes head and only then starts its 80ms clock.
  stdin.write("p");
  await tick();
  expect(first).toEqual({ allow: true });
  expect(second).toBeNull();
  expect(lastFrame()).toContain("perm:second");

  await new Promise((r) => setTimeout(r, 40));
  expect(second).toBeNull();

  await new Promise((r) => setTimeout(r, 80));
  expect(second).toEqual({ allow: false, message: "second timed out" });
  expect(lastFrame()).toContain("none none none open=0");
});
