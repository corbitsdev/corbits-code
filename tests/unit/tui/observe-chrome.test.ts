import { describe, expect, test } from "bun:test";
import {
  enterObserveChrome,
  leaveObserveChrome,
} from "../../../src/tui/observe-chrome.js";

describe("observe chrome enter/leave teardown", () => {
  test("enterObserveChrome focuses the child and shows a Viewing toast", () => {
    const next = enterObserveChrome("sess-1", "explorer", "map callers");
    expect(next.enteredSessionId).toBe("sess-1");
    expect(next.commandMessage).toBe("Viewing explorer: map callers");
  });

  test("leaveObserveChrome clears focus and does not leave Back to parent session", () => {
    // Simulate the pre-fix sticky toast path: operator was viewing a child,
    // then Esc returns to parent. Chrome must fully tear down.
    const entered = enterObserveChrome("sess-1", "explorer", "map callers");
    expect(entered.enteredSessionId).not.toBeNull();
    expect(entered.commandMessage).not.toBeNull();

    const left = leaveObserveChrome();
    expect(left.enteredSessionId).toBeNull();
    expect(left.commandMessage).toBeNull();
    // Regression: never leave a sticky "Back to parent session" on parent.
    expect(left.commandMessage).not.toBe("Back to parent session");
  });

  test("round-trip enter → leave leaves no observe chrome on parent", () => {
    let chrome = { enteredSessionId: null as string | null, commandMessage: null as string | null };

    chrome = enterObserveChrome("s-a", "worker", "run tests");
    expect(chrome.enteredSessionId).toBe("s-a");
    expect(chrome.commandMessage).toContain("Viewing");

    chrome = leaveObserveChrome();
    expect(chrome).toEqual({ enteredSessionId: null, commandMessage: null });
  });
});
