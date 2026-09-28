/**
 * CL-6291: soft steer / follow-up must keep workers alive; only hard stop
 * (Ctrl+C → doInterrupt → port.interrupt) tears the fleet down via agent close.
 *
 * Owned separately from runtime-bridge.test.ts so gesture remaps (sibling)
 * do not collide with these invariants.
 */
import { describe, expect, test } from "bun:test";
import { attachSessionBridge, createRecordingPort } from "./runtime-bridge";
import { createAppShell } from "./shell/index";
import { type Harness, withTestRenderer } from "./harness";
import { badgeCount } from "./delivery-queue";

interface BridgeFixture {
  readonly shell: ReturnType<typeof createAppShell>;
  readonly port: ReturnType<typeof createRecordingPort>;
  readonly bridge: ReturnType<typeof attachSessionBridge>;
}

async function withBridge(
  options: { wireKeys: boolean; run?: "idle" | "busy" },
  fn: (fixture: BridgeFixture, h: Harness) => Promise<void> | void,
): Promise<void> {
  await withTestRenderer(
    async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: options.wireKeys,
        run: options.run ?? "busy",
      });
      const port = createRecordingPort();
      const bridge = attachSessionBridge(shell, port);
      try {
        await fn({ shell, port, bridge }, h);
      } finally {
        bridge.dispose();
        shell.dispose();
      }
    },
    { width: 80, height: 24 },
  );
}

describe("CL-6291 worker-alive invariants", () => {
  test("busy Enter soft-steers: enqueue steer, never port.interrupt", async () => {
    await withBridge({ wireKeys: true }, async ({ shell, port }, h) => {
      shell.prompt.value = "steer please";
      shell.prompt.submit();
      await h.renderOnce();
      expect(port.calls.some((c) => c.op === "interrupt")).toBe(false);
      expect(port.calls.some((c) => c.op === "enqueue")).toBe(true);
      const enq = port.calls.find((c) => c.op === "enqueue");
      expect(enq).toEqual({
        op: "enqueue",
        text: "steer please",
        kind: "steer",
      });
      expect(badgeCount(shell.session)).toBe(1);
    });
  });

  test("bridge submit steer / queue (follow-up) never calls interrupt", async () => {
    await withBridge(
      { wireKeys: false },
      async ({ shell, port, bridge }, h) => {
        bridge.submit("redirect soft", "steer");
        bridge.submit("follow up later", "queue");
        await h.renderOnce();
        expect(port.calls.some((c) => c.op === "interrupt")).toBe(false);
        expect(
          port.calls
            .filter((c) => c.op === "enqueue")
            .map((c) =>
              c.op === "enqueue" ? { text: c.text, kind: c.kind } : null,
            ),
        ).toEqual([
          { text: "redirect soft", kind: "steer" },
          { text: "follow up later", kind: "queue" },
        ]);
        expect(badgeCount(shell.session)).toBe(2);
      },
    );
  });

  test("tool.boundary deliver does not interrupt", async () => {
    await withBridge(
      { wireKeys: false },
      async ({ shell, port, bridge }, h) => {
        bridge.submit("at next boundary", "steer");
        expect(badgeCount(shell.session)).toBe(1);
        port.clear();
        bridge.handle({ type: "tool.boundary" });
        await h.renderOnce();
        expect(port.calls.some((c) => c.op === "interrupt")).toBe(false);
        expect(port.calls.some((c) => c.op === "deliver")).toBe(true);
        const delivered = port.calls.find((c) => c.op === "deliver");
        expect(delivered?.op === "deliver" ? delivered.item.text : null).toBe(
          "at next boundary",
        );
        expect(badgeCount(shell.session)).toBe(0);
      },
    );
  });

  test("busy Enter boundary uses deliver, not sendImmediate", async () => {
    await withBridge(
      { wireKeys: false },
      async ({ shell, port, bridge }, h) => {
        bridge.submit("steer into the live turn", "steer");
        expect(badgeCount(shell.session)).toBe(1);
        port.clear();
        bridge.handle({ type: "tool.boundary" });
        await h.renderOnce();
        expect(port.calls.some((c) => c.op === "deliver")).toBe(true);
        expect(port.calls.some((c) => c.op === "sendImmediate")).toBe(false);
        expect(port.calls.some((c) => c.op === "interrupt")).toBe(false);
      },
    );
  });

  test("clearQueuedDelivery drops pending steers instead of draining them", async () => {
    await withBridge(
      { wireKeys: false },
      async ({ shell, port, bridge }, h) => {
        bridge.submit("old steer", "steer");
        expect(badgeCount(shell.session)).toBe(1);
        port.clear();
        bridge.clearQueuedDelivery();
        expect(badgeCount(shell.session)).toBe(0);
        expect(shell.session.run).toBe("idle");
        bridge.handle({ type: "tool.boundary" });
        await h.renderOnce();
        expect(port.calls.some((c) => c.op === "deliver")).toBe(false);
        expect(port.calls.some((c) => c.op === "sendImmediate")).toBe(false);
      },
    );
  });

  test("clearQueuedDelivery forgets pending echoes so inbound user rows paint", async () => {
    await withBridge(
      { wireKeys: false, run: "idle" },
      async ({ shell, bridge }, h) => {
        bridge.submit("hello there", "immediate");
        const before = shell.streamLog.filter(
          (r) => r.role === "user" && r.text === "hello there",
        ).length;
        expect(before).toBe(1);
        bridge.clearQueuedDelivery();
        bridge.handle({ type: "user", text: "hello there" });
        await h.renderOnce();
        expect(
          shell.streamLog.filter(
            (r) => r.role === "user" && r.text === "hello there",
          ),
        ).toHaveLength(2);
      },
    );
  });

  test("Ctrl+C / doInterrupt still calls port.interrupt", async () => {
    await withBridge({ wireKeys: true }, async ({ shell, port, bridge }, h) => {
      bridge.submit("kept", "steer");
      expect(badgeCount(shell.session)).toBe(1);
      port.clear();
      h.pressKey("c", { ctrl: true });
      await h.renderOnce();
      expect(port.calls.some((c) => c.op === "interrupt")).toBe(true);
      // Hard stop still hands pending over rather than discarding them.
      expect(
        port.calls.flatMap((c) => (c.op === "deliver" ? [c.item.text] : [])),
      ).toEqual(["kept"]);
    });
  });

  test("bridge.interrupt() hits port.interrupt (hard-stop API)", async () => {
    await withBridge({ wireKeys: false }, async ({ port, bridge }, h) => {
      bridge.interrupt();
      await h.renderOnce();
      expect(port.calls.map((c) => c.op)).toContain("interrupt");
    });
  });
});
