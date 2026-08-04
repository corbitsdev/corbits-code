import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import type { ReactElement } from "react";
import { Text, useInput } from "ink";
import { useScrollWindow } from "./use-scroll-window.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

// A minimal harness component so the hook's state (useState-backed) is
// exercised the same way the modals use it: PageUp/PageDown drive offset,
// and above/below report what's scrolled out of view.
function Harness({ rowCount, visibleRows }: { rowCount: number; visibleRows: number }): ReactElement {
  const window = useScrollWindow(rowCount, visibleRows);
  useInput((_input, key) => {
    if (key.pageDown) window.pageDown();
    if (key.pageUp) window.pageUp();
  });
  return <Text>{`offset=${window.offset} above=${window.above} below=${window.below} max=${window.maxOffset}`}</Text>;
}

test("useScrollWindow starts at the top with everything below in view", () => {
  const { lastFrame } = render(<Harness rowCount={10} visibleRows={4} />);
  expect(lastFrame()).toBe("offset=0 above=0 below=6 max=6");
});

test("useScrollWindow pages down and clamps at maxOffset", async () => {
  const { stdin, lastFrame } = render(<Harness rowCount={10} visibleRows={4} />);
  stdin.write("\x1B[6~"); // PageDown
  await tick();
  expect(lastFrame()).toBe("offset=4 above=4 below=2 max=6");
  stdin.write("\x1B[6~"); // PageDown again — clamps instead of overshooting
  await tick();
  expect(lastFrame()).toBe("offset=6 above=6 below=0 max=6");
});

test("useScrollWindow pages back up and clamps at 0", async () => {
  const { stdin, lastFrame } = render(<Harness rowCount={10} visibleRows={4} />);
  stdin.write("\x1B[6~"); // PageDown
  await tick();
  stdin.write("\x1B[5~"); // PageUp back to the top
  await tick();
  expect(lastFrame()).toBe("offset=0 above=0 below=6 max=6");
  stdin.write("\x1B[5~"); // PageUp again — clamps instead of going negative
  await tick();
  expect(lastFrame()).toBe("offset=0 above=0 below=6 max=6");
});

test("useScrollWindow reports maxOffset 0 when content already fits", () => {
  const { lastFrame } = render(<Harness rowCount={3} visibleRows={4} />);
  expect(lastFrame()).toBe("offset=0 above=0 below=0 max=0");
});

test("useScrollWindow clamps a stale raw offset when content shrinks", async () => {
  // Start tall so paging can leave rawOffset past the later maxOffset.
  const { stdin, lastFrame, rerender } = render(<Harness rowCount={30} visibleRows={5} />);
  for (let i = 0; i < 6; i++) {
    stdin.write("\x1B[6~"); // PageDown
    await tick();
  }
  expect(lastFrame()).toBe("offset=25 above=25 below=0 max=25");
  // Content shrinks — displayed offset must clamp immediately without PageUp.
  rerender(<Harness rowCount={8} visibleRows={5} />);
  await tick();
  expect(lastFrame()).toBe("offset=3 above=3 below=0 max=3");
});
