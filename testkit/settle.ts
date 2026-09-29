import { expect } from "bun:test";

export type SettleOutcome =
  | { kind: "resolved" }
  | { kind: "rejected"; err: unknown }
  | { kind: "timeout" };

/**
 * Race a promise against a timeout so a hung settle reports "timeout" instead
 * of stalling the test. Used by dispose/shutdown tests where the expectation
 * is that the promise rejects even though one teardown leg never returns.
 */
export function settleOrTimeout(
  pending: Promise<unknown>,
  timeoutMs = 200,
): Promise<SettleOutcome> {
  return Promise.race([
    pending.then(
      () => ({ kind: "resolved" as const }),
      (err: unknown) => ({ kind: "rejected" as const, err }),
    ),
    new Promise<{ kind: "timeout" }>((resolve) => {
      setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
    }),
  ]);
}

/** Assert the settle outcome is a rejection whose message matches `pattern`. */
export function expectRejectedSettle(
  result: SettleOutcome,
  pattern: RegExp,
): void {
  expect(result.kind).toBe("rejected");
  if (result.kind !== "rejected") throw new Error("expected leftover reject");
  expect(result.err).toBeInstanceOf(Error);
  expect((result.err as Error).message).toMatch(pattern);
}
