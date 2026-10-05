import { describe, expect, test } from "bun:test";

import { DIRECTOR_REGISTRY } from "../registry.js";

const card = (): string => DIRECTOR_REGISTRY.dispatch.systemPrompt;

/**
 * CL-9920: mailbox turn yield vs task completion, plus midflight steering.
 * Instruction-only change, so the existing harness is the prompt contract:
 * each test scripts a staggered-worker scenario and asserts the dispatch
 * card carries the guidance that scenario requires. All fail before the
 * guidance lands.
 */
describe("dispatch yield/steering guidance (CL-9920)", () => {
  test("staggered completion: yield with pending workers is not task completion", () => {
    // Two workers spawned; one reports while the other still runs. The
    // resume turn must end as a yield, never as a completion claim.
    expect(card()).toMatch(/yield ends this turn/i);
    expect(card()).toMatch(/never .* completion .* pending/i);
  });

  test("completion requires acceptance assessment and blocker disposition", () => {
    // All workers reported but a check is unassessed and a blocker is open:
    // completion still needs report-vs-brief acceptance plus disposition.
    expect(card()).toMatch(/acceptance/i);
    expect(card()).toMatch(/blocker/i);
  });

  test("resumed steering reaches active workers through existing messaging only", () => {
    // Operator steers midflight; a worker is still running. The resumed
    // turn must incorporate the steering and forward it via send_input —
    // the existing channel — with no new scheduling/messaging invented.
    expect(card()).toMatch(/steering/i);
    expect(card()).toMatch(/send_input/);
    expect(card()).not.toMatch(/new channel|new tool|new messag/i);
  });

  test("superseded work is named; stale results are never approval", () => {
    // Steering supersedes one lane while its stale report lands anyway.
    // Dispatch must name the superseded work and refuse the stale result.
    expect(card()).toMatch(/superseded/i);
    expect(card()).toMatch(/stale/i);
  });

  test("unreachable steering is disclosed, acceptance withheld, stop preserved", () => {
    // Steering arrives but cannot reach active work: dispatch must say so,
    // withhold acceptance, and keep stop/cancel semantics unchanged.
    expect(card()).toMatch(/withhold acceptance/i);
    expect(card()).toMatch(/stop/i);
  });
});
