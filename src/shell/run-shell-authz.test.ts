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