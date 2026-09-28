import { describe, expect, test } from "bun:test";

import {
  composeNoticeLine,
  resolveWaitingOn,
  type NoticeState,
} from "./notice-line";

const state = (over: Partial<NoticeState> = {}): NoticeState => ({
  waitingOn: null,
  interrupt: false,
  pinned: false,
  flash: null,
  attachments: 0,
  ...over,
});

describe("composeNoticeLine", () => {
  test("an idle shell has nothing to say and takes no row", () => {
    expect(composeNoticeLine(state())).toBe("");
  });

  test("waitingOn names the in-flight command", () => {
    const line = composeNoticeLine(state({ waitingOn: "run_shell" }));
    expect(line).toContain("run_shell");
  });

  test("a flash is carried verbatim so paths keep their case", () => {
    expect(composeNoticeLine(state({ flash: "attached Screenshot.png" }))).toBe(
      "attached Screenshot.png",
    );
  });
});

describe("resolveWaitingOn", () => {
  const inFlight = { name: "run_shell", startedAt: 0 };

  test("stays silent below STEER_WAIT_NOTICE_MS", () => {
    expect(resolveWaitingOn(1, inFlight, 2999)).toBe(null);
  });

  test("names the tool at STEER_WAIT_NOTICE_MS", () => {
    expect(resolveWaitingOn(1, inFlight, 3000)).toBe("run_shell");
  });

  test("stays silent with no pending steer", () => {
    expect(resolveWaitingOn(0, inFlight, 5000)).toBe(null);
  });

  test("stays silent with no in-flight tool", () => {
    expect(resolveWaitingOn(1, null, 5000)).toBe(null);
  });
});
