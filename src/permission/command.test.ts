import { test, expect, describe } from "bun:test";

import { splitChainedCommand } from "./command.js";

describe("splitChainedCommand heredocs", () => {
  // Regression: a heredoc marker followed by trailing text (a redirect) drove
  // an infinite loop in the opening-line scan, hanging the permission gate.
  test("terminates on a quoted marker followed by a redirect", () => {
    const command = "cat << 'EOF' > out.txt\nhello world\nEOF";
    expect(splitChainedCommand(command)).toEqual([command]);
  });

  test("does not treat separators inside the heredoc body as chain breaks", () => {
    const command = "cat <<EOF\na && b; c | d\nEOF";
    expect(splitChainedCommand(command)).toEqual([command]);
  });

  test("scopes a terminated heredoc and its following lines together", () => {
    // Newlines are not chain separators, so the whole multi-line script stays a
    // single approval subject; the point is that it terminates rather than hangs.
    const command = "cat <<EOF > out.txt\nhi\nEOF\necho done";
    expect(splitChainedCommand(command)).toEqual([command]);
  });

  test("still splits ordinary chained commands", () => {
    expect(splitChainedCommand("echo a && echo b")).toEqual(["echo a", "echo b"]);
  });
});

describe("splitChainedCommand redirect and background fragments", () => {
  // A chain operator can strand a redirect fd-duplication target as its own
  // segment. Each of these must stay attached to the command that owns it
  // rather than surfacing as a spurious "Run shell command: 1" approval.
  test("coalesces a stray fd target after a semicolon", () => {
    expect(splitChainedCommand("bun run build ; 1")).toEqual(["bun run build 1"]);
  });

  test("coalesces a stray ampersand-fd target after &&", () => {
    expect(splitChainedCommand("bun run build && &1")).toEqual(["bun run build &1"]);
  });

  test("keeps 2>&1 attached to its command, not split into a stray 1", () => {
    expect(splitChainedCommand("bun run build 2>&1")).toEqual(["bun run build 2>&1"]);
  });

  test("keeps &>file combined redirects intact", () => {
    expect(splitChainedCommand("bun run build &> out.log")).toEqual(["bun run build &> out.log"]);
    expect(splitChainedCommand("bun run build &>out.log")).toEqual(["bun run build &>out.log"]);
  });

  test("keeps <&- fd-close redirects intact", () => {
    expect(splitChainedCommand("echo hi <&-")).toEqual(["echo hi <&-"]);
  });

  test("splits on a genuine background operator without stranding a fragment", () => {
    expect(splitChainedCommand("bun run build & echo done")).toEqual(["bun run build", "echo done"]);
  });

  test("keeps a heredoc body intact rather than fragmenting it", () => {
    const command = "cat <<EOF\nhello\nEOF";
    expect(splitChainedCommand(command)).toEqual([command]);
  });

  test("leaves a non-command prose payload as a single segment", () => {
    const prose = "please run the build and check the output for errors";
    expect(splitChainedCommand(prose)).toEqual([prose]);
  });
});
