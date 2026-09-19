import { describe, expect, spyOn, test } from "bun:test";

import {
  formatResumeHint,
  printResumeHint,
  resetResumeHintForTests,
} from "./resume-hint.js";

describe("resume hint", () => {
  test("formats the resume command with the exited session id", () => {
    expect(formatResumeHint("123e4567-e89b-12d3-a456-426614174000")).toBe(
      "Run corbits resume 123e4567-e89b-12d3-a456-426614174000",
    );
  });

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
      // First call wins (e.g. the signal handler); the finalize tail's call
      // for the same session is a no-op so the line emits exactly once.
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
