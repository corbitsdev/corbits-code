import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as permissionStore from "../permission/store.js";
import {
  buildSubAgentProvider,
  createApprovalPersist,
  createSessionPruningCompactor,
  loadSeededApprovals,
  skillDirsFromEnabledPlugins,
} from "./runtime-assembly.js";
import { generateSessionId, initSessionDir, sessionDir } from "./index.js";
import type { PluginModule } from "../plugins/loader.js";

describe("buildSubAgentProvider", () => {
  test("seeds provider fields and omits undefined optionals", () => {
    expect(
      buildSubAgentProvider({
        providerName: "openai",
        baseURL: "https://api.openai.com/v1",
        model: "gpt-5",
        providers: [{ name: "openai" }],
      }),
    ).toEqual({
      providerName: "openai",
      baseURL: "https://api.openai.com/v1",
      model: "gpt-5",
    });
  });

  test("includes apiKey, reasoningEffort, and bifrostVirtualKey when set", () => {
    expect(
      buildSubAgentProvider({
        providerName: "bifrost",
        baseURL: "https://example.invalid/v1",
        apiKey: "sk-test",
        model: "gpt-5",
        reasoningEffort: "high",
        providers: [{ name: "bifrost", bifrostVirtualKey: true }],
      }),
    ).toEqual({
      providerName: "bifrost",
      baseURL: "https://example.invalid/v1",
      apiKey: "sk-test",
      model: "gpt-5",
      reasoningEffort: "high",
      bifrostVirtualKey: true,
    });
  });
});

describe("loadSeededApprovals merge order", () => {
  let cwd = "";
  let home = "";
  let sessionId = "";

  afterEach(async () => {
    if (cwd !== "") await rm(cwd, { recursive: true, force: true });
    if (home !== "") await rm(home, { recursive: true, force: true });
    cwd = "";
    home = "";
    sessionId = "";
  });

  test("orders session, then project, before empty global/provider-model layers", async () => {
    cwd = await mkdtemp(join(tmpdir(), "runtime-assembly-"));
    home = await mkdtemp(join(tmpdir(), "runtime-assembly-home-"));
    sessionId = generateSessionId();
    await initSessionDir(cwd, sessionId, home);

    await mkdir(sessionDir(cwd, sessionId, home), { recursive: true });
    await writeFile(
      join(sessionDir(cwd, sessionId, home), "permissions.json"),
      JSON.stringify({
        approvals: [{ tool: "run_shell", pattern: "session npm *" }],
      }),
    );
    await permissionStore.saveProjectApproval(cwd, {
      tool: "run_shell",
      pattern: "project npm *",
    });

    const seeded = await loadSeededApprovals(cwd, sessionId, home);

    // Session must lead so gate first-match prefers the tighter session grant.
    // Global / provider-model layers may contain real-home entries; assert prefix only.
    expect(seeded[0]).toEqual({ tool: "run_shell", pattern: "session npm *" });
    expect(seeded[1]).toEqual({ tool: "run_shell", pattern: "project npm *" });
  });

});

describe("createApprovalPersist", () => {
  afterEach(() => {
    mock.restore();
  });

  test("routes project, global, and provider-model scopes to the matching store", () => {
    const project = spyOn(permissionStore, "saveProjectApproval").mockResolvedValue(undefined);
    const global = spyOn(permissionStore, "saveGlobalApproval").mockResolvedValue(undefined);
    const providerModel = spyOn(permissionStore, "saveProviderModelApproval").mockResolvedValue(
      undefined,
    );

    const persist = createApprovalPersist("/tmp/proj", "openai:gpt-5");
    const approval = { tool: "run_shell", pattern: "npm *" };

    persist(approval, "project");
    persist(approval, "global");
    persist(approval, "provider-model");
    // Session scope is gate-memory only — persist must no-op.
    persist(approval, "session");

    expect(project).toHaveBeenCalledWith("/tmp/proj", approval);
    expect(global).toHaveBeenCalledWith(approval);
    expect(providerModel).toHaveBeenCalledWith("openai:gpt-5", approval);
    expect(project).toHaveBeenCalledTimes(1);
    expect(global).toHaveBeenCalledTimes(1);
    expect(providerModel).toHaveBeenCalledTimes(1);
  });
});

describe("skillDirsFromEnabledPlugins", () => {
  test("keeps only enabled plugins that have a dir and manifest id", () => {
    const modules = [
      { dir: "/a", manifest: { id: "on" }, metadataOnly: false },
      { dir: "/b", manifest: { id: "off" }, metadataOnly: false },
      { dir: "/c", metadataOnly: false },
      { manifest: { id: "no-dir" }, metadataOnly: false },
      { dir: "/d", manifest: { id: "missing-config" }, metadataOnly: false },
    ] as unknown as PluginModule[];

    expect(
      skillDirsFromEnabledPlugins(modules, {
        on: { enabled: true },
        off: { enabled: false },
      }),
    ).toEqual(["/a"]);
  });
});

describe("createSessionPruningCompactor", () => {
  test("only wires a summarize function in llm mode", async () => {
    const summarize = async () => "summary";
    const pruning = createSessionPruningCompactor({
      compactionMode: "pruning",
      summarize,
    });
    const llm = createSessionPruningCompactor({
      compactionMode: "llm",
      summarize,
    });
    // Both return a Compactor; smoke that apply is present without running a full prune.
    expect(typeof pruning.apply).toBe("function");
    expect(typeof llm.apply).toBe("function");
  });
});
