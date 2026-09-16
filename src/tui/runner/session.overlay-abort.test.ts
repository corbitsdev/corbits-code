import { describe, expect, test } from "bun:test";
import type { PermissionRequest } from "../../permission/types.js";
import type { PermissionGateEvent } from "../gate-events.js";
import { createGateRequestApproval } from "../request-approval.js";
import { createParkedOverlayAbortBinding } from "./parked-overlay-abort.js";
import { assembleTUISession } from "./session.js";

const request: PermissionRequest = {
  tool: "run_shell",
  action: "Run shell command",
  subject: "true",
  scopes: [],
};

function noTimeout(): undefined {
  return undefined;
}

describe("parked overlay abort binding", () => {
  test("aborting the registered controller aborts the merged identity signal", () => {
    const binding = createParkedOverlayAbortBinding();
    const identity = new AbortController();
    const overlay = new AbortController();
    binding.registerOverlayAbort(overlay);
    const merged = binding.identitySignal(identity.signal);
    expect(merged.aborted).toBe(false);
    overlay.abort("approval timed out");
    expect(merged.aborted).toBe(true);
    expect(merged.reason).toBe("approval timed out");
    expect(identity.signal.aborted).toBe(false);
  });

  test("without a registered controller the identity signal is unchanged", () => {
    const binding = createParkedOverlayAbortBinding();
    const identity = new AbortController();
    expect(binding.identitySignal(identity.signal)).toBe(identity.signal);
  });

  test("clearing the registration drops the overlay from later identity signals", () => {
    const binding = createParkedOverlayAbortBinding();
    const identity = new AbortController();
    const overlay = new AbortController();
    binding.registerOverlayAbort(overlay);
    binding.registerOverlayAbort(undefined);
    const merged = binding.identitySignal(identity.signal);
    overlay.abort("approval timed out");
    expect(merged.aborted).toBe(false);
  });
});

describe("assembleTUISession overlay abort wiring", () => {
  test("registers the parked overlay abort on approval resume and merges it into the gate identity signal", () => {
    const src = assembleTUISession.toString();
    expect(src).toContain("createParkedOverlayAbortBinding");
    expect(src).toContain("registerOverlayAbort");
    expect(src).toContain("parkedOverlay.identitySignal");
    expect(src).toContain("parkedOverlay.registerOverlayAbort");
  });

  test("a registered overlay abort dismisses the gate event the session identity signal feeds", async () => {
    const binding = createParkedOverlayAbortBinding();
    const identity = new AbortController();
    let captured: PermissionGateEvent | undefined;
    const requestApproval = createGateRequestApproval({
      emitGate: (event) => {
        captured = event;
        return true;
      },
      approvalTimeout: noTimeout,
      identitySignal: () => binding.identitySignal(identity.signal),
    });
    const overlay = new AbortController();
    binding.registerOverlayAbort(overlay);
    const pending = requestApproval(request);
    expect(captured?.signal?.aborted).toBe(false);
    overlay.abort("approval timed out");
    expect(captured?.signal?.aborted).toBe(true);
    expect(captured?.signal?.reason).toBe("approval timed out");
    captured?.resolve({ allow: false, message: "approval timed out" });
    expect((await pending).allow).toBe(false);
  });
});
