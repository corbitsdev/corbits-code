import { describe, expect, spyOn, test } from "bun:test";

import { formatResumeHint, printResumeHint } from "./resume-hint.js";

describe("resume hint", () => {
  test("formats the resume command with the exited session id", () => {
    expect(formatResumeHint("123e4567-e89b-12d3-a456-426614174000")).toBe(
      "Run corbits --resume 123e4567-e89b-12d3-a456-426614174000",
    );
  });

  test("prints the hint line to stdout", () => {
    const writes: string[] = [];
    const spy = spyOn(process.stdout, "write").mockImplementation(((
      chunk: unknown,
    ) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      printResumeHint("123e4567-e89b-12d3-a456-426614174000");
    } finally {
      spy.mockRestore();
    }
    expect(writes).toEqual([
      "Run corbits --resume 123e4567-e89b-12d3-a456-426614174000\n",
    ]);
  });
});
