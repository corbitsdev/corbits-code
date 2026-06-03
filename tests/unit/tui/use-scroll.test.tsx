import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { useInput } from "ink";
import type { ReactNode } from "react";
import { useScroll } from "../../../src/tui/hooks/use-scroll.js";

function Harness({ renderableCount, visibleRows }: { renderableCount: number; visibleRows: number }): ReactNode {
  const scroll = useScroll({ renderableCount, visibleRows });
  useInput((input) => {
    if (input === "u") scroll.scrollUp();
    if (input === "d") scroll.scrollDown();
  });
  return <Text>{`offset=${scroll.scrollOffset} bottom=${scroll.atBottom ? "1" : "0"}`}</Text>;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

test("auto-pins to the bottom as content grows", async () => {
  const { lastFrame, rerender } = render(<Harness renderableCount={3} visibleRows={5} />);
  await tick();
  expect(lastFrame()).toContain("offset=0 bottom=1");

  rerender(<Harness renderableCount={20} visibleRows={5} />);
  await tick();
  expect(lastFrame()).toContain("offset=15 bottom=1");
});

test("scrollUp unpins and clamps at zero", async () => {
  const { lastFrame, stdin } = render(<Harness renderableCount={20} visibleRows={5} />);
  await tick();
  expect(lastFrame()).toContain("offset=15 bottom=1");

  for (let i = 0; i < 20; i++) {
    stdin.write("u");
    await tick();
  }
  expect(lastFrame()).toContain("offset=0 bottom=0");
});

test("scrollDown clamps at maxOffset and re-pins at the bottom", async () => {
  const { lastFrame, stdin } = render(<Harness renderableCount={20} visibleRows={5} />);
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
  expect(lastFrame()).toContain("offset=15 bottom=1");
});
