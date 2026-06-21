import { describe, expect, test } from "bun:test";

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
    browse = stepSentHistoryUp(browse, "")!.browse;
    const step = stepSentHistoryUp(browse, "third");
    expect(step?.value).toBe("second");
    browse = step!.browse;
    const oldest = stepSentHistoryUp(browse, "second");
    expect(oldest?.value).toBe("first");
    expect(stepSentHistoryUp(oldest!.browse, "first")).toBeNull();
  });

  test("down from oldest returns through newer to draft", () => {
    let browse = createSentHistoryBrowse(sent);
    browse = stepSentHistoryUp(browse, "my draft")!.browse;
    browse = stepSentHistoryUp(browse, "third")!.browse;
    browse = stepSentHistoryUp(browse, "second")!.browse;

    const toSecond = stepSentHistoryDown(browse, "first", 5);
    expect(toSecond?.value).toBe("second");

    const toThird = stepSentHistoryDown(toSecond!.browse, "second", 6);
    expect(toThird?.value).toBe("third");

    const toDraft = stepSentHistoryDown(toThird!.browse, "third", 5);
    expect(toDraft?.value).toBe("my draft");
    expect(toDraft?.browse.browseIndex).toBeNull();
  });

  test("editing exits browse mode", () => {
    const browse = stepSentHistoryUp(createSentHistoryBrowse(sent), "x")!.browse;
    expect(sentHistoryOnEdit(browse).browseIndex).toBeNull();
  });
});