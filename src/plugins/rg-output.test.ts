import { test, expect } from "bun:test";

import { createRgCollector } from "./rg-output.js";

const line = "big.txt:1:match line here\n";

test("the cap fires on the chunk that breaches it", () => {
  const collector = createRgCollector(200);
  expect(collector.push(line.repeat(4))).toBeUndefined();
  expect(collector.push(line.repeat(20))).toMatchObject({
    kind: "partial",
    notice: expect.stringContaining("exceeded 200 bytes"),
  });
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
