import { describe, expect, test } from "bun:test";
import { attachSessionBridge, createRecordingPort } from "../runtime-bridge.js";
import { createAppShell } from "../shell/index.js";
import { withTestRenderer } from "../harness.js";
import { createFleetStallPollTick } from "./wiring.js";

function settleToollessTurn(
  bridge: ReturnType<typeof attachSessionBridge>,
): void {
  bridge.handle({ type: "inference.start", data: {} });
  bridge.handle({ type: "inference.done", data: {} });
}

describe("fleet stall poll tick (CL-7676)", () => {
  test("tick runs the fleet report and re-flushes mailbox mail", () => {
    const order: string[] = [];
    const tick = createFleetStallPollTick(
      () => {
        order.push("report");
      },
      () => {
        order.push("flush");
      },
    );
    tick();
    expect(order).toEqual(["report", "flush"]);
  });

  test("missed edge (driver throws once) self-heals on the next poll without duplicates", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "busy",
        });
        const port = createRecordingPort();
        const bridge = attachSessionBridge(shell, port);
        try {
          let reports = 0;
          let drives = 0;
          let taken = false;
          let failNext = true;
          bridge.handle({ type: "fleet", running: 1 });
          settleToollessTurn(bridge);
          bridge.setMailboxMailDriver(() => {
            if (failNext) {
              failNext = false;
              throw new Error("send failed");
            }
            if (taken) return false;
            taken = true;
            drives += 1;
            return true;
          });
          // The subscribe-time edge misses: the driver failure is swallowed as
          // retryable, with no later edge while the fleet stays quiet.
          bridge.flushMailboxMail();
          expect(drives).toBe(0);

          const tick = createFleetStallPollTick(
            () => {
              reports += 1;
            },
            () => bridge.flushMailboxMail(),
          );
          tick();
          expect(reports).toBe(1);
          expect(drives).toBe(1);
          // The report is taken: a second poll must not re-send.
          tick();
          expect(reports).toBe(2);
          expect(drives).toBe(1);
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("terminal landing mid-turn is delivered on the next poll after settle", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        });
        const port = createRecordingPort();
        const bridge = attachSessionBridge(shell, port);
        try {
          let drives = 0;
          let taken = false;
          let failSettleFlush = true;
          bridge.setMailboxMailDriver(() => {
            if (failSettleFlush) {
              failSettleFlush = false;
              throw new Error("settle send failed");
            }
            if (taken) return false;
            taken = true;
            drives += 1;
            return true;
          });
          bridge.submit("dispatch workers", "immediate");
          bridge.handle({ type: "fleet", running: 1 });
          // Terminal lands while the parent is mid-turn: flush no-ops.
          bridge.flushMailboxMail();
          expect(drives).toBe(0);
          // Settle-time flush also misses (send fails, swallowed). No later
          // store edge fires while the fleet stays quiet.
          settleToollessTurn(bridge);
          expect(drives).toBe(0);

          const tick = createFleetStallPollTick(
            () => undefined,
            () => bridge.flushMailboxMail(),
          );
          tick();
          expect(drives).toBe(1);
          tick();
          expect(drives).toBe(1);
        } finally {
          bridge.dispose();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });
});
