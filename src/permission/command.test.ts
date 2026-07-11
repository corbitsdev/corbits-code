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
