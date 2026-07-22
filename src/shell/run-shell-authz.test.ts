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