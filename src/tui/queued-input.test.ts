import { expect, test } from "bun:test";
import {
  NO_QUEUED_INPUT,
  acceptQueuedInput,
  clearQueuedInput,
  composeQueuedInputLine,
  consumeQueuedInput,
  queuedInputCount,
} from "./queued-input.js";
import { stringWidth } from "./view/height.js";

test("accepted input ledger preserves first-acceptance order and consumes exact identities", () => {
  const one = acceptQueuedInput(NO_QUEUED_INPUT, "one");
  const two = acceptQueuedInput(one, "two");
  const three = acceptQueuedInput(two, "three");
  expect(acceptQueuedInput(two, "one")).toBe(two);
  expect(three.messageIds).toEqual(["one", "two", "three"]);
  const consumed = consumeQueuedInput(three, "two");
  expect(consumed.messageIds).toEqual(["one", "three"]);
  expect(consumeQueuedInput(consumed, "unknown")).toBe(consumed);
  expect(consumeQueuedInput(consumed, "two")).toBe(consumed);
  expect(queuedInputCount(clearQueuedInput(consumed))).toBe(0);
  expect(clearQueuedInput(NO_QUEUED_INPUT)).toBe(NO_QUEUED_INPUT);
  expect(acceptQueuedInput(NO_QUEUED_INPUT, "")).toBe(NO_QUEUED_INPUT);
});

test("queued input formatter remains meaningful and width safe at full and narrow widths", () => {
  const state = acceptQueuedInput(acceptQueuedInput(NO_QUEUED_INPUT, "a"), "b");
  for (const width of [0, 1, 5, 10, 24, 80]) {
    const text = composeQueuedInputLine(state, width)
      .map((part) => part.text)
      .join("");
    expect(stringWidth(text)).toBeLessThanOrEqual(width);
  }
  expect(
    composeQueuedInputLine(state, 80)
      .map((part) => part.text)
      .join(""),
  ).toContain("QUEUED INPUT");
  expect(
    composeQueuedInputLine(state, 10)
      .map((part) => part.text)
      .join(""),
  ).toContain("QUEUED");
  expect(composeQueuedInputLine(NO_QUEUED_INPUT, 80)).toEqual([]);
});
