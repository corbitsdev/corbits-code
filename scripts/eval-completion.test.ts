import { describe, expect, test } from "bun:test";
import { withTimeout } from "./eval-completion.js";

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
});
