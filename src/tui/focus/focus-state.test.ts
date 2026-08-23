import { describe, expect, test } from "bun:test";
import {
  canPopFocus,
  createFocusState,
  focusOwner,
  focusPrompt,
  focusTranscript,
  openObserve,
  openOverlay,
  popFocus,
  scrollLease,
} from "./index.js";

describe("createFocusState", () => {
  test("shell default: prompt focus, transcript scroll lease", () => {
    const s = createFocusState();
    expect(focusOwner(s)).toBe("prompt");
    expect(scrollLease(s)).toBe("transcript");
    expect(s.frames).toHaveLength(1);
    expect(s.frames[0]!.id).toBe("shell");
  });
});

describe("one focus owner + one scroll lease", () => {
  test("exactly one focus owner and one lease at every step", () => {
    let s = createFocusState();
    const steps = [
      () => openObserve(s, "child-1"),
      () => openOverlay(s, "perm-1"),
      () => openOverlay(s, "palette-1", { target: "palette" }),
      () => popFocus(s),
      () => popFocus(s),
      () => popFocus(s),
    ];
    for (const step of steps) {
      s = step();
      expect(typeof focusOwner(s)).toBe("string");
      expect(focusOwner(s).length).toBeGreaterThan(0);
      expect(scrollLease(s)).not.toBeNull();
      // Single top frame owns both; stack never empty.
      expect(s.frames.length).toBeGreaterThanOrEqual(1);
      expect(scrollLease(s)).toBe(s.frames[s.frames.length - 1]!.scrollOwner);
    }
  });

  test("wheel owner always equals scrollLease(state)", () => {
    let s = createFocusState();
    expect(scrollLease(s)).toBe("transcript");

    s = openOverlay(s, "settings");
    expect(scrollLease(s)).toBe("overlay");

    s = popFocus(s);
    s = openObserve(s, "obs");
    expect(scrollLease(s)).toBe("observe");

    s = openOverlay(s, "help", { target: "overlay", scrollOwner: "overlay" });
    expect(scrollLease(s)).toBe("overlay");
  });
});

describe("priority: overlay > observe > shell", () => {
  test("overlay wins over shell", () => {
    let s = createFocusState();
    s = openOverlay(s, "perm");
    expect(focusOwner(s)).toBe("overlay");
    expect(scrollLease(s)).toBe("overlay");
  });

  test("observe wins over shell", () => {
    let s = createFocusState();
    s = openObserve(s, "child-a");
    expect(focusOwner(s)).toBe("observe");
    expect(scrollLease(s)).toBe("observe");
  });

  test("overlay wins over observe", () => {
    let s = createFocusState();
    s = openObserve(s, "child-a");
    s = openOverlay(s, "perm");
    expect(focusOwner(s)).toBe("overlay");
    expect(scrollLease(s)).toBe("overlay");
    // Observe remains under the overlay.
    expect(s.frames.map((f) => f.target)).toEqual(["prompt", "observe", "overlay"]);
  });

  test("openObserve while overlay open keeps overlay on top", () => {
    let s = createFocusState();
    s = openOverlay(s, "perm");
    s = openObserve(s, "child-b");
    expect(focusOwner(s)).toBe("overlay");
    expect(scrollLease(s)).toBe("overlay");
    expect(s.frames.map((f) => f.id)).toEqual(["shell", "child-b", "perm"]);
  });
});

describe("Esc / popFocus stack", () => {
  test("Esc from overlay restores shell prompt + transcript lease", () => {
    let s = createFocusState();
    s = openOverlay(s, "perm");
    s = popFocus(s);
    expect(focusOwner(s)).toBe("prompt");
    expect(scrollLease(s)).toBe("transcript");
    expect(s.frames).toHaveLength(1);
  });

  test("Esc from overlay restores observe when observe was under it", () => {
    let s = createFocusState();
    s = openObserve(s, "child-1");
    s = openOverlay(s, "perm");
    expect(focusOwner(s)).toBe("overlay");

    s = popFocus(s);
    expect(focusOwner(s)).toBe("observe");
    expect(scrollLease(s)).toBe("observe");
    expect(s.frames.map((f) => f.id)).toEqual(["shell", "child-1"]);
  });

  test("Esc from observe returns shell prompt + transcript lease", () => {
    let s = createFocusState();
    s = openObserve(s, "child-1");
    s = popFocus(s);
    expect(focusOwner(s)).toBe("prompt");
    expect(scrollLease(s)).toBe("transcript");
    expect(s.frames).toHaveLength(1);
  });

  test("Esc at shell prompt is a no-op (state identity for machine)", () => {
    const s = createFocusState();
    const next = popFocus(s);
    expect(next).toBe(s);
    expect(canPopFocus(s)).toBe(false);
  });

  test("Esc from shell transcript browse restores prompt", () => {
    let s = createFocusState();
    s = focusTranscript(s);
    expect(focusOwner(s)).toBe("transcript");
    expect(canPopFocus(s)).toBe(true);

    s = popFocus(s);
    expect(focusOwner(s)).toBe("prompt");
    expect(scrollLease(s)).toBe("transcript");
  });
});

describe("palette stacks over overlay (single Esc path)", () => {
  // Opening palette while overlay open: stack, not replace — one Esc closes
  // palette, the next closes the prior overlay (contract §5.2 rule 6).
  test("palette stacks; double Esc returns to shell", () => {
    let s = createFocusState();
    s = openOverlay(s, "settings");
    s = openOverlay(s, "palette", { target: "palette", scrollOwner: "palette" });

    expect(focusOwner(s)).toBe("palette");
    expect(scrollLease(s)).toBe("palette");
    expect(s.frames).toHaveLength(3);

    s = popFocus(s);
    expect(focusOwner(s)).toBe("overlay");
    expect(scrollLease(s)).toBe("overlay");
    expect(s.frames.map((f) => f.id)).toEqual(["shell", "settings"]);

    s = popFocus(s);
    expect(focusOwner(s)).toBe("prompt");
    expect(scrollLease(s)).toBe("transcript");
  });

  test("palette above observe restores observe on first Esc", () => {
    let s = createFocusState();
    s = openObserve(s, "child");
    s = openOverlay(s, "palette", { target: "palette" });
    s = popFocus(s);
    expect(focusOwner(s)).toBe("observe");
    expect(scrollLease(s)).toBe("observe");
  });
});

describe("lease handoff", () => {
  test("modal open moves lease off transcript", () => {
    let s = createFocusState();
    expect(scrollLease(s)).toBe("transcript");
    s = openOverlay(s, "perm");
    expect(scrollLease(s)).not.toBe("transcript");
    expect(scrollLease(s)).toBe("overlay");
  });

  test("Esc restores transcript lease after modal", () => {
    let s = createFocusState();
    s = openOverlay(s, "perm");
    s = popFocus(s);
    expect(scrollLease(s)).toBe("transcript");
  });

  test("observe Esc restores parent transcript lease", () => {
    let s = createFocusState();
    s = openObserve(s, "child");
    expect(scrollLease(s)).toBe("observe");
    s = popFocus(s);
    expect(scrollLease(s)).toBe("transcript");
  });

  test("custom scrollOwner on overlay list surface", () => {
    let s = createFocusState();
    s = openOverlay(s, "model-picker", {
      target: "overlay",
      scrollOwner: "model-list",
    });
    expect(focusOwner(s)).toBe("overlay");
    expect(scrollLease(s)).toBe("model-list");
  });
});

describe("focusPrompt / focusTranscript (shell only)", () => {
  test("focusTranscript then focusPrompt at shell", () => {
    let s = createFocusState();
    s = focusTranscript(s);
    expect(focusOwner(s)).toBe("transcript");
    expect(scrollLease(s)).toBe("transcript");

    s = focusPrompt(s);
    expect(focusOwner(s)).toBe("prompt");
    expect(scrollLease(s)).toBe("transcript");
  });

  test("focusPrompt / focusTranscript no-op under overlay", () => {
    let s = createFocusState();
    s = openOverlay(s, "perm");
    const frozen = s;
    expect(focusPrompt(s)).toBe(frozen);
    expect(focusTranscript(s)).toBe(frozen);
  });

  test("focusPrompt / focusTranscript no-op under observe", () => {
    let s = createFocusState();
    s = openObserve(s, "child");
    const frozen = s;
    expect(focusPrompt(s)).toBe(frozen);
    expect(focusTranscript(s)).toBe(frozen);
  });
});

describe("openObserve replaces prior observe", () => {
  test("second openObserve replaces the observe frame id", () => {
    let s = createFocusState();
    s = openObserve(s, "child-a");
    s = openObserve(s, "child-b");
    expect(s.frames.filter((f) => f.target === "observe")).toHaveLength(1);
    expect(s.frames.map((f) => f.id)).toEqual(["shell", "child-b"]);
  });
});

describe("immutability", () => {
  test("updates return new state objects", () => {
    const a = createFocusState();
    const b = openOverlay(a, "x");
    expect(b).not.toBe(a);
    expect(b.frames).not.toBe(a.frames);
    expect(a.frames).toHaveLength(1);
  });
});
