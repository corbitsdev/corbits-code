import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { EventEmitter } from "node:events";
import { Text } from "ink";
import { useInput } from "ink";
import type { ReactNode } from "react";
import { useMouseScroll } from "../../../src/tui/hooks/use-mouse-scroll.js";
import { useScroll } from "../../../src/tui/hooks/use-scroll.js";

function Harness({ maxOffset }: { maxOffset: number }): ReactNode {
  const scroll = useScroll({ maxOffset });
  useInput((input) => {
    if (input === "u") scroll.scrollUp();
    if (input === "d") scroll.scrollDown();
    if (input === "b") scroll.scrollToBottom();
  });
  return <Text>{`offset=${scroll.scrollOffset} bottom=${scroll.atBottom ? "1" : "0"}`}</Text>;
}

function MouseHarness({ mouseEvents }: { mouseEvents: EventEmitter }): ReactNode {
  const scroll = useScroll({ maxOffset: 50 });
  useMouseScroll(
    mouseEvents,
    (ticks) => scroll.scrollUp(ticks * 3),
    (ticks) => scroll.scrollDown(ticks * 3),
  );
  return <Text>{`offset=${scroll.scrollOffset} bottom=${scroll.atBottom ? "1" : "0"}`}</Text>;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

test("auto-pins to the bottom as content grows", async () => {
  const { lastFrame, rerender } = render(<Harness maxOffset={2} />);
  await tick();
  expect(lastFrame()).toContain("offset=2 bottom=1");

  rerender(<Harness maxOffset={19} />);
  await tick();
  expect(lastFrame()).toContain("offset=19 bottom=1");
});

test("scrollUp unpins and clamps at zero", async () => {
  const { lastFrame, stdin } = render(<Harness maxOffset={19} />);
  await tick();
  expect(lastFrame()).toContain("offset=19 bottom=1");

  for (let i = 0; i < 25; i++) {
    stdin.write("u");
    await tick();
  }
  expect(lastFrame()).toContain("offset=0 bottom=0");
});

test("scrollDown clamps at maxOffset and re-pins at the bottom", async () => {
  const { lastFrame, stdin } = render(<Harness maxOffset={19} />);
  await tick();
  stdin.write("u");
  await tick();
  stdin.write("u");
  await tick();
  expect(lastFrame()).toContain("bottom=0");

  for (let i = 0; i < 10; i++) {
    stdin.write("d");
    await tick();
  }
  expect(lastFrame()).toContain("offset=19 bottom=1");
});

test("a pinned-to-bottom offset that exceeds shrunken content stays at the new bottom", async () => {
  const { lastFrame, rerender, stdin } = render(<Harness maxOffset={19} />);
  await tick();
  stdin.write("u");
  await tick();
  stdin.write("u");
  await tick();
  expect(lastFrame()).toContain("offset=17 bottom=0");

  rerender(<Harness maxOffset={2} />);
  await tick();
  expect(lastFrame()).toContain("offset=2 bottom=1");
});

test("scrollToBottom re-pins after scrolling up", async () => {
  const { lastFrame, stdin } = render(<Harness maxOffset={19} />);
  await tick();
  stdin.write("u");
  await tick();
  stdin.write("u");
  await tick();
  expect(lastFrame()).toContain("bottom=0");
  stdin.write("b");
  await tick();
  expect(lastFrame()).toContain("offset=19 bottom=1");
});

test("mouse wheel bursts coalesce into one scroll update", async () => {
  const mouseEvents = new EventEmitter();
  const { lastFrame } = render(<MouseHarness mouseEvents={mouseEvents} />);
  await tick();
  expect(lastFrame()).toContain("offset=50 bottom=1");

  mouseEvents.emit("scrollUp");
  mouseEvents.emit("scrollUp");
  mouseEvents.emit("scrollUp");
  expect(lastFrame()).toContain("offset=50 bottom=1");

  await tick();
  expect(lastFrame()).toContain("offset=41 bottom=0");
});
