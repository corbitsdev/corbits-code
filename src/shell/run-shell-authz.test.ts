import { describe, expect, test } from "bun:test";

import {
  commandHasRecursiveRm,
  runShellAuthzBlockReason,
  segmentHasRecursiveRm,
} from "./run-shell-authz.js";

describe("recursive rm detection", () => {
  test("segmentHasRecursiveRm matches recursive flags only", () => {
    expect(segmentHasRecursiveRm("rm -rf build")).toBe(true);
    expect(segmentHasRecursiveRm("rm -r dist")).toBe(true);
    expect(segmentHasRecursiveRm("rm --recursive --force out")).toBe(true);
    expect(segmentHasRecursiveRm("rm -f stale.log")).toBe(false);
    expect(segmentHasRecursiveRm("git rm -rf file")).toBe(false);
  });

  test("commandHasRecursiveRm splits on chain boundaries", () => {
    expect(commandHasRecursiveRm("bun test && rm -rf ./tmp")).toBe(true);
    expect(commandHasRecursiveRm("ls; rm -rf node_modules")).toBe(true);
    expect(commandHasRecursiveRm("npm test")).toBe(false);
  });

  test("commandHasRecursiveRm peels shell -c and xargs wrappers", () => {
    expect(commandHasRecursiveRm("bash -c 'rm -rf build'")).toBe(true);
    expect(commandHasRecursiveRm('sh -c "rm -rf ./tmp"')).toBe(true);
    expect(commandHasRecursiveRm("zsh -c 'rm -rf node_modules'")).toBe(true);
    expect(commandHasRecursiveRm("/bin/bash -lc 'rm -rf dist'")).toBe(true);
    expect(commandHasRecursiveRm("echo build | xargs rm -rf")).toBe(true);
    expect(commandHasRecursiveRm("printf '%s\\n' tmp | xargs -n1 rm -rf")).toBe(true);
    expect(commandHasRecursiveRm("env bash -c 'rm -rf out'")).toBe(true);
    expect(commandHasRecursiveRm("bash -c 'echo hello'")).toBe(false);
    expect(commandHasRecursiveRm("bash -c 'rm -f stale.log'")).toBe(false);
  });

  test("commandHasRecursiveRm survives xargs feeding a shell -c payload", () => {
    // The quoted payload must survive the xargs peel intact: rejoining
    // dequoted tokens once re-split `-c 'rm -rf {}'` into fragments and lost
    // the classification.
    expect(commandHasRecursiveRm("xargs -I{} bash -c 'rm -rf {}'")).toBe(true);
    expect(commandHasRecursiveRm("echo x | xargs -I {} sh -c 'sudo rm -rf {}'")).toBe(true);
    expect(commandHasRecursiveRm("echo build | xargs -I{} bash -c 'rm -rf {}'")).toBe(true);
    expect(commandHasRecursiveRm("find . -name tmp | xargs -n1 sh -c 'rm -rf \"$0\"'")).toBe(true);
    expect(commandHasRecursiveRm("echo hi | xargs -I{} bash -c 'echo {}'")).toBe(false);
  });

  test("authz hard-blocks catastrophic rm behind xargs + shell -c", () => {
    expect(runShellAuthzBlockReason("echo / | xargs -I{} bash -c 'rm -rf {}'")).toBeUndefined();
    expect(runShellAuthzBlockReason("xargs -I{} bash -c 'rm -rf /'")).toMatch(
      /Destructive command blocked/,
    );
  });

  test("an embedded apostrophe in the payload does not drop the dangerous tail", () => {
    // The rejoin must round-trip through tokenize() (no backslash escapes), so a
    // payload token containing a literal quote is re-wrapped in the other quote
    // character rather than the POSIX '\'' idiom, which would re-split it.
    const cmd = "echo x | xargs -I{} sh -c \"don't stop; rm -rf /\"";
    expect(commandHasRecursiveRm(cmd)).toBe(true);
    expect(runShellAuthzBlockReason(cmd)).toMatch(/Destructive command blocked/);
  });

  test("authz still hard-blocks catastrophic recursive rm", () => {
    expect(runShellAuthzBlockReason("rm -rf /")).toMatch(/Destructive command blocked/);
    expect(runShellAuthzBlockReason("rm -rf node_modules")).toBeUndefined();
  });

  test("authz hard-blocks catastrophic recursive rm inside shell -c wrappers", () => {
    expect(runShellAuthzBlockReason("bash -c 'rm -rf /'")).toMatch(/Destructive command blocked/);
    expect(runShellAuthzBlockReason("sh -c \"rm -rf ~\"")).toMatch(/Destructive command blocked/);
    expect(runShellAuthzBlockReason("bash -c 'rm -rf $HOME'")).toMatch(/Destructive command blocked/);
    // Non-catastrophic recursive rm remains for the permission gate, not authz hard-deny.
    expect(runShellAuthzBlockReason("bash -c 'rm -rf node_modules'")).toBeUndefined();
  });
});

describe("stdin-blocking with quote-aware tokenizeSegment", () => {
  test("unquoted readers with no file operand are blocked", () => {
    expect(runShellAuthzBlockReason("cat")).toMatch(/standard input/);
    expect(runShellAuthzBlockReason("grep pattern")).toMatch(/standard input/);
    expect(runShellAuthzBlockReason("tail -n 50")).toMatch(/standard input/);
  });

  test("unquoted readers with a file operand are allowed", () => {
    expect(runShellAuthzBlockReason("cat foo")).toBeUndefined();
    expect(runShellAuthzBlockReason("grep pat file")).toBeUndefined();
    expect(runShellAuthzBlockReason("tail -n 50 file.log")).toBeUndefined();
  });

  test("quoted path with spaces counts as one file operand", () => {
    // Naive whitespace split would see `"my` and `file.txt"` as two tokens and
    // still allow; quote-aware tokenize keeps one operand either way. The
    // important case is the single-file form must not hang.
    expect(runShellAuthzBlockReason('cat "my file.txt"')).toBeUndefined();
    expect(runShellAuthzBlockReason("cat 'my file.txt'")).toBeUndefined();
  });

  test("quoted grep pattern with spaces is one operand (still needs a file)", () => {
    // Naive split of `grep 'a b'` yields tokens ["grep", "'a", "b'"] — two
    // operands — and wrongly allows a command that would hang on stdin.
    expect(runShellAuthzBlockReason("grep 'a b'")).toMatch(/standard input/);
    expect(runShellAuthzBlockReason('grep "a b"')).toMatch(/standard input/);
    expect(runShellAuthzBlockReason("grep 'a b' file")).toBeUndefined();
    expect(runShellAuthzBlockReason('grep "a b" file')).toBeUndefined();
  });

  test("env assignment prefixes still strip before operand counting", () => {
    expect(runShellAuthzBlockReason('FOO=1 cat "x y"')).toBeUndefined();
    expect(runShellAuthzBlockReason("FOO=1 cat")).toMatch(/standard input/);
    expect(runShellAuthzBlockReason("FOO=1 BAR=2 grep 'a b'")).toMatch(/standard input/);
    expect(runShellAuthzBlockReason("FOO=1 grep 'a b' file")).toBeUndefined();
  });

  test("pipeline heads still apply; downstream stages do not", () => {
    expect(runShellAuthzBlockReason("echo hi | cat")).toBeUndefined();
    expect(runShellAuthzBlockReason("git log --oneline | tail -20")).toBeUndefined();
  });
});