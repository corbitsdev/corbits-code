import { describe, expect, test } from "bun:test";

import { composeNoticeLine, resolveWaitingOn, type NoticeState } from "./notice-line";

const state = (over: Partial<NoticeState> = {}): NoticeState => ({
  steer: 0,
  followUp: 0,
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

  test("default state segments stay off the row", () => {
    const line = composeNoticeLine(state({ steer: 0, followUp: 0, pinned: false }));
    expect(line).not.toContain("steer");
    expect(line).not.toContain("follow-up");
    expect(line).not.toContain("queue");
    expect(line).not.toContain("pinned");
  });

  test("steer and follow-up are distinct segments", () => {
    const line = composeNoticeLine(
      state({ steer: 2, followUp: 1, pinned: true, interrupt: true, attachments: 1 }),
    );
    expect(line).toContain("steer 2");
    expect(line).toContain("follow-up 1");
    expect(line).not.toContain("queue 2");
    expect(line).toContain("pinned");
    expect(line).not.toContain("interrupt");
    expect(line).toContain("1 image");
  });

  test("waitingOn + steer names the in-flight command", () => {
    const line = composeNoticeLine(state({ steer: 1, waitingOn: "run_shell" }));
    expect(line).toContain("waiting on run_shell");
  });

  test("follow-up only does not wait on a tool", () => {
    const line = composeNoticeLine(state({ followUp: 1, waitingOn: null }));
    expect(line).not.toContain("waiting on");
  });

  test("a flash is carried verbatim so paths keep their case", () => {
    expect(composeNoticeLine(state({ flash: "attached Screenshot.png" }))).toBe(
      "attached Screenshot.png",
    );
  });

  test("no keys strip survives anywhere in the composition", () => {
    const line = composeNoticeLine(state({ followUp: 1, interrupt: true }));
    expect(line).not.toContain("commands");
    expect(line).not.toContain("files");
    expect(line).not.toContain("^C");
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
