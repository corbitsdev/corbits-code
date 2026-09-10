import { describe, expect, test } from "bun:test";

import { defined } from "../../tests/helpers/defined.js";
import {
  createSentHistoryBrowse,
  stepSentHistoryDown,
  stepSentHistoryUp,
  sentHistoryOnEdit,
} from "./sent-message-history.js";

describe("sent-message-history", () => {
  const sent = ["first", "second", "third"];

  test("up from live stashes draft and shows newest sent", () => {
    const browse = createSentHistoryBrowse(sent);
    const step = stepSentHistoryUp(browse, "draft text");
    expect(step).toEqual({
      browse: { sent, draft: "draft text", browseIndex: 0 },
      value: "third",
      cursor: 5,
    });
  });

  test("up walks to older messages", () => {
    let browse = createSentHistoryBrowse(sent);
    browse = defined(stepSentHistoryUp(browse, "")).browse;
    const step = stepSentHistoryUp(browse, "third");
    expect(step?.value).toBe("second");
    browse = defined(step).browse;
    const oldest = stepSentHistoryUp(browse, "second");
    expect(oldest?.value).toBe("first");
    expect(stepSentHistoryUp(defined(oldest).browse, "first")).toBeNull();
  });

  test("down from oldest returns through newer to draft", () => {
    let browse = createSentHistoryBrowse(sent);
    browse = defined(stepSentHistoryUp(browse, "my draft")).browse;
    browse = defined(stepSentHistoryUp(browse, "third")).browse;
    browse = defined(stepSentHistoryUp(browse, "second")).browse;

    const toSecond = stepSentHistoryDown(browse, "first", 5);
    expect(toSecond?.value).toBe("second");

    const toThird = stepSentHistoryDown(defined(toSecond).browse, "second", 6);
    expect(toThird?.value).toBe("third");

    const toDraft = stepSentHistoryDown(defined(toThird).browse, "third", 5);
    expect(toDraft?.value).toBe("my draft");
    expect(toDraft?.browse.browseIndex).toBeNull();
  });

  test("editing exits browse mode", () => {
    const browse = defined(
      stepSentHistoryUp(createSentHistoryBrowse(sent), "x"),
    ).browse;
    expect(sentHistoryOnEdit(browse).browseIndex).toBeNull();
  });

  test("up from browse index with cursor at end still reaches older messages", () => {
    let browse = createSentHistoryBrowse(sent);
    browse = defined(stepSentHistoryUp(browse, "")).browse;
    expect(browse.browseIndex).toBe(0);
    const older = stepSentHistoryUp(browse, "third");
    expect(older?.value).toBe("second");
  });
});
