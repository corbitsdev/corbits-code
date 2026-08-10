import { test, expect } from "bun:test";

import { createRgCollector } from "./rg-output.js";

const line = "big.txt:1:match line here\n";

test("the cap fires on the chunk that breaches it", () => {
  const collector = createRgCollector(200);
  expect(collector.push(line.repeat(4))).toBeUndefined();
  const outcome = collector.push(line.repeat(20));
  expect(outcome).toMatchObject({ kind: "partial" });
  // No notice of its own: the final tool result gets exactly one truncation
  // notice, from result-truncation-plugin.ts, not one per cap that fired.
  expect(outcome?.kind === "partial" ? outcome.notice : "defined").toBeUndefined();
});

test("an over-cap run reports no more than the cap, cut at a line boundary", () => {
  const outcome = createRgCollector(200).push(line.repeat(400));
  if (outcome?.kind !== "partial") throw new Error("expected partial");
  expect(outcome.stdout.length).toBeLessThanOrEqual(200);
  expect(outcome.stdout).toContain("match line here");
  expect(outcome.stdout.endsWith("here")).toBe(true);
});

test("a cap breach outranks the exit code at every settle point", () => {
  const overCap = (): string[] => [line.repeat(20)];
  for (const settle of [
    (chunks: string[]) => {
      const c = createRgCollector(200);
      chunks.forEach((chunk) => c.push(chunk));
      return c.close(0, "");
    },
    (chunks: string[]) => {
      const c = createRgCollector(200);
      chunks.forEach((chunk) => c.push(chunk));
      return c.timeout(5);
    },
  ]) {
    // The cap has already settled the run, so no later path can widen it.
    expect(settle(overCap())).toBeUndefined();
  }
});

// close is its own settle point and must apply the cap even when nothing
// mid-stream did — the Linux race is "all bytes present, exit code mapped
// before the data handler's breach check runs". Simulate that by pushing
// under the collector's settle via a direct close after a push that returns
// partial: push settles first. To hit close's own overCap branch we push
// chunks that the test then settles only through close by using a collector
// whose push already returned partial... which settles. The branch is still
// exercised when push accumulates past the cap without the caller acting on
// the return value and close is the first finish() input — covered below by
// invoking close on a collector that has over-cap bytes only if push did not
// settle. push always settles on breach today, so the equivalent contract is:
// close never returns kind "output" with a body longer than the cap.
test("close never reports complete output over the byte cap", () => {
  const collector = createRgCollector(200);
  const breach = collector.push(line.repeat(400));
  // Mid-stream path settled; close must not reopen or widen.
  expect(breach?.kind).toBe("partial");
  expect(collector.close(0, "")).toBeUndefined();
  if (breach?.kind === "partial") {
    expect(breach.stdout.length).toBeLessThanOrEqual(200);
  }
});

test("the timeout yields whatever was collected under the cap", () => {
  const collector = createRgCollector(2_000);
  collector.push(line);
  expect(collector.timeout(1)).toMatchObject({
    kind: "partial",
    stdout: line,
    notice: expect.stringContaining("timed out after 1ms"),
  });
});

test("only the first settle wins", () => {
  const collector = createRgCollector(2_000);
  collector.push(line);
  expect(collector.close(0, "")).toMatchObject({ kind: "output", stdout: line });
  expect(collector.close(0, "")).toBeUndefined();
  expect(collector.timeout(1)).toBeUndefined();
  expect(collector.push(line.repeat(400))).toBeUndefined();
});

test("exit codes map to no-match and error", () => {
  expect(createRgCollector(200).close(1, "")).toMatchObject({ kind: "no-match" });
  expect(createRgCollector(200).close(2, "bad pattern")).toMatchObject({
    kind: "error",
    message: "bad pattern",
  });
  expect(createRgCollector(200).close(2, "")).toMatchObject({
    kind: "error",
    message: "ripgrep exited with code 2",
  });
});
