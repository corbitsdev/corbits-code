import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadGlobalApprovals,
  loadProjectApprovals,
  loadProviderModelApprovals,
  saveGlobalApproval,
  saveProjectApproval,
  saveProviderModelApproval,
} from "./store.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "perm-store-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("project store", () => {
  test("round-trips approvals at <cwd>/.interchange/permissions.json", async () => {
    expect(await loadProjectApprovals(dir)).toEqual([]);
    await saveProjectApproval(dir, { tool: "run_shell", pattern: "npm *" });
    await saveProjectApproval(dir, { tool: "write_file", pattern: "src/*" });
    expect(await loadProjectApprovals(dir)).toEqual([
      { tool: "run_shell", pattern: "npm *" },
      { tool: "write_file", pattern: "src/*" },
    ]);
  });
});

describe("global store", () => {
  test("round-trips approvals under the home permissions file", async () => {
    expect(await loadGlobalApprovals(dir)).toEqual([]);
    await saveGlobalApproval({ tool: "run_shell", pattern: "git *" }, dir);
    expect(await loadGlobalApprovals(dir)).toEqual([{ tool: "run_shell", pattern: "git *" }]);
  });
});

describe("provider-model store", () => {
  test("keys approvals by providerModel and tags them on load", async () => {
    expect(await loadProviderModelApprovals(dir)).toEqual([]);
    await saveProviderModelApproval("openai:gpt-5", { tool: "run_shell", pattern: "npm *" }, dir);
    await saveProviderModelApproval("anthropic:opus", { tool: "run_shell", pattern: "ls *" }, dir);
    const loaded = await loadProviderModelApprovals(dir);
    expect(loaded).toContainEqual({ tool: "run_shell", pattern: "npm *", providerModel: "openai:gpt-5" });
    expect(loaded).toContainEqual({ tool: "run_shell", pattern: "ls *", providerModel: "anthropic:opus" });
  });

  test("global and provider-model grants share one file without clobbering", async () => {
    await saveGlobalApproval({ tool: "run_shell", pattern: "git *" }, dir);
    await saveProviderModelApproval("openai:gpt-5", { tool: "run_shell", pattern: "npm *" }, dir);
    expect(await loadGlobalApprovals(dir)).toEqual([{ tool: "run_shell", pattern: "git *" }]);
    expect(await loadProviderModelApprovals(dir)).toEqual([
      { tool: "run_shell", pattern: "npm *", providerModel: "openai:gpt-5" },
    ]);
  });
});
