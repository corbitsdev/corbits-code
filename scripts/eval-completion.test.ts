import { describe, expect, test } from "bun:test";
import { resolveRunStatus, withTimeout } from "./eval-completion.js";

describe("withTimeout", () => {
  test("rejects a hung run after the timeout", async () => {
    const hung = new Promise<never>(() => undefined);
    const start = Date.now();
    const error = await withTimeout(hung, 50, "task stall-read").catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "task stall-read timed out after 50ms",
    );
    // Fires near the deadline instead of hanging (bun test's own 5s
    // timeout would fail this test if withTimeout never settled).
    expect(Date.now() - start).toBeLessThan(2000);
  });

  test("resolves the inner value before the timeout", async () => {
    await expect(
      withTimeout(Promise.resolve("done"), 50, "task"),
    ).resolves.toBe("done");
  });

  test("propagates an inner rejection that wins the race", async () => {
    await expect(
      withTimeout(Promise.reject(new Error("boom")), 1000, "task"),
    ).rejects.toThrow("boom");
  });

  test("invokes onTimeout when the deadline fires", async () => {
    const hung = new Promise<never>(() => undefined);
    let calls = 0;
    const onTimeout = () => {
      calls += 1;
    };
    const error = await withTimeout(hung, 50, "task", { onTimeout }).catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(Error);
    expect(calls).toBe(1);
  });

  test("skips onTimeout when the inner promise settles first", async () => {
    let calls = 0;
    const onTimeout = () => {
      calls += 1;
    };
    await expect(
      withTimeout(Promise.resolve("done"), 50, "task", { onTimeout }),
    ).resolves.toBe("done");
    const failing = Promise.reject(new Error("boom"));
    const rejected = withTimeout(failing, 50, "task", { onTimeout });
    await expect(rejected).rejects.toThrow("boom");
    expect(calls).toBe(0);
  });
});

describe("resolveRunStatus", () => {
  test("timeout keeps status over a failure signal", () => {
    const status = resolveRunStatus({ timedOut: true, failed: true });
    expect(status).toBe("timeout");
  });

  test("resolves the remaining outcomes", () => {
    const timeoutOnly = resolveRunStatus({ timedOut: true, failed: false });
    const failedOnly = resolveRunStatus({ timedOut: false, failed: true });
    const clean = resolveRunStatus({ timedOut: false, failed: false });
    expect(timeoutOnly).toBe("timeout");
    expect(failedOnly).toBe("failed");
    expect(clean).toBe("completed");
  });
});
