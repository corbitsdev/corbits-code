import { describe, expect, test } from "bun:test";
import { retryAfterInteractiveAuth } from "./client.js";

describe("retryAfterInteractiveAuth", () => {
  test("notifies only after the retried operation succeeds", async () => {
    let notified = false;
    await expect(
      retryAfterInteractiveAuth(
        async () => undefined,
        async () => {
          throw new Error("still unauthorized");
        },
        () => {
          notified = true;
        },
      ),
    ).rejects.toThrow("still unauthorized");
    expect(notified).toBe(false);

    const value = await retryAfterInteractiveAuth(
      async () => undefined,
      async () => "ok",
      () => {
        notified = true;
      },
    );
    expect(value).toBe("ok");
    expect(notified).toBe(true);
  });

  test("propagates auth completion failures without notifying", async () => {
    let notified = false;
    let operationRan = false;
    await expect(
      retryAfterInteractiveAuth(
        async () => {
          throw new Error("auth aborted");
        },
        async () => {
          operationRan = true;
          return "ok";
        },
        () => {
          notified = true;
        },
      ),
    ).rejects.toThrow("auth aborted");
    expect(operationRan).toBe(false);
    expect(notified).toBe(false);
  });
});
