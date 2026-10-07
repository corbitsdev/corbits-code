import { describe, expect, spyOn, test } from "bun:test";

import { printResumeHint, resetResumeHintForTests } from "./resume-hint.js";

describe("resume hint", () => {
  test("prints the hint line to stderr, leaving stdout clean", () => {
    resetResumeHintForTests();
    const outWrites: string[] = [];
    const errWrites: string[] = [];
    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(((
      chunk: unknown,
    ) => {
      outWrites.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(((
      chunk: unknown,
    ) => {
      errWrites.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    try {
      printResumeHint("123e4567-e89b-12d3-a456-426614174000");
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
    expect(errWrites).toEqual([
      "Run corbits resume 123e4567-e89b-12d3-a456-426614174000\n",
    ]);
    expect(outWrites).toEqual([]);
  });

  test("prints at most once per process (signal racing finalize)", () => {
    resetResumeHintForTests();
    const errWrites: string[] = [];
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(((
      chunk: unknown,
    ) => {
      errWrites.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    try {
      // First call wins; the finalize tail's duplicate call is a no-op so the line emits once.
      printResumeHint("123e4567-e89b-12d3-a456-426614174000");
      printResumeHint("123e4567-e89b-12d3-a456-426614174000");
    } finally {
      stderrSpy.mockRestore();
    }
    expect(errWrites).toEqual([
      "Run corbits resume 123e4567-e89b-12d3-a456-426614174000\n",
    ]);
  });
});
