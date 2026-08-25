import { describe, expect, test } from "bun:test";
import { createSkywalkerSystemPrompt, skywalkerPackage } from "./package.js";

describe("skywalkerPackage", () => {
  test("id matches directory", () => {
    expect(skywalkerPackage.id).toBe("skywalker");
  });

  test("systemPrompt is real, not placeholder", () => {
    expect(skywalkerPackage.systemPrompt.length).toBeGreaterThan(0);
    expect(skywalkerPackage.systemPrompt.startsWith("Placeholder")).toBe(false);
    expect(skywalkerPackage.systemPrompt).toContain("You are Skywalker");
    expect(skywalkerPackage.systemPrompt).toContain("When asked your name, answer: Skywalker");
    expect(skywalkerPackage.systemPrompt).toContain("PRIMARY INTENT");
    expect(skywalkerPackage.systemPrompt).toContain("write_file/edit_file/delete_file");
    expect(skywalkerPackage.systemPrompt).toContain("DIY tiny/single-file/one-route");
  });

  test("createSkywalkerSystemPrompt returns package systemPrompt", () => {
    expect(createSkywalkerSystemPrompt()).toBe(skywalkerPackage.systemPrompt);
  });

  test("maySpawn true with full closed allowlist", () => {
    expect(skywalkerPackage.spawn.maySpawn).toBe(true);
    expect(skywalkerPackage.spawn.allowlist).toHaveLength(15);
    expect(skywalkerPackage.spawn.allowlist).toEqual([
      "builder",
      "explorer",
      "counsel",
      "intern",
      "critic",
      "greybeard",
      "neckbeard",
      "bruckheimer",
      "gaasbot",
      "draper",
      "emil",
      "rand",
      "shakespeare",
      "testsmith",
      "tester",
    ]);
  });

  test("tools.allow mounts orchestrator surface plus product writes for DIY", () => {
    const allow = skywalkerPackage.tools?.allow ?? [];
    expect(allow).toContain("task");
    expect(allow).toContain("search_agents");
    expect(allow).toContain("write_file");
    expect(allow).toContain("edit_file");
    expect(allow).toContain("delete_file");
  });

  test("modelRole is orchestrator", () => {
    expect(skywalkerPackage.modelRole).toBe("orchestrator");
  });

  test("optionalSkills order", () => {
    expect(skywalkerPackage.optionalSkills).toEqual(["style", "philosophy", "interview"]);
  });

  test("primaryIntent and outOfLane", () => {
    expect(skywalkerPackage.primaryIntent).toBe(
      "Orchestrate; DIY tiny/bounded product edits; spawn for substantial work",
    );
    expect(skywalkerPackage.outOfLane).toContain(
      "substantial multi-file product work without spawning",
    );
    expect(skywalkerPackage.outOfLane).toContain("catch-all worker");
    expect(skywalkerPackage.outOfLane).toContain(
      "searching the repo yourself after a worker stops without finishing",
    );
    expect(skywalkerPackage.outOfLane).toContain("diagnostic fleets for why/how/stall questions");
  });

  test("systemPrompt parent tools tell the parent not to run long-blocking jobs", () => {
    const p = skywalkerPackage.systemPrompt;
    expect(p).toContain("Parent tools");
    expect(p).toContain("long-blocking");
    expect(p).toContain("tool.boundary");
    expect(p).toContain("Dispatch intern");
    expect(p).toContain("or builder (substantial code)");
  });

  test("systemPrompt has effort scaling / named non-overlapping lanes (no numeric soft ceiling)", () => {
    const p = skywalkerPackage.systemPrompt;
    expect(p).toContain("Effort scaling");
    expect(p).toContain("fan-out");
    expect(p).toContain("0–1 worker");
    expect(p).toContain("named, non-overlapping lanes");
    expect(p).not.toContain("2–4 workers");
  });

  test("systemPrompt prefers spawn_agent then wait_agents (idle-orchestrator)", () => {
    const p = skywalkerPackage.systemPrompt;
    expect(p).toContain("spawn_agent");
    expect(p).toContain("wait_agents");
    expect(p).toContain("Idle-orchestrator");
    expect(p).toContain("deprecated fused spawn+wait");
    expect(p).not.toContain("Present the plan when the change is large or ambiguous");
  });

  test("systemPrompt requires frequent operator updates and staying free for Enter", () => {
    const p = skywalkerPackage.systemPrompt;
    expect(p).toContain("Operator updates");
    expect(p).toContain("only surface that talks to the operator");
    expect(p).toContain("frequent short status updates");
    expect(p).toContain("reply to the operator");
    expect(p).toContain("before you block");
    expect(p).toContain("timeout_ms");
    expect(p).toContain("answer them first");
    expect(p).toContain("Enter can land");
  });

  test("systemPrompt anti-cascade keeps digs out of fleets", () => {
    const p = skywalkerPackage.systemPrompt;
    expect(p).toContain("Anti-cascade");
    expect(p).toContain("COMMUNICATION first");
    expect(p).toContain("Never spawn parallel");
    expect(p).toContain("one explorer worker");
    expect(p).toContain("search the repo yourself after a worker stops");
    expect(p).toContain("Do not reclassify COMMUNICATION as ORCHESTRATION");
  });

  test("systemPrompt simple path skips explorer+critic for tiny work", () => {
    const p = skywalkerPackage.systemPrompt;
    expect(p).toContain("DIY on the parent");
    expect(p).toContain("skip spawn, skip explorer, skip critic");
    expect(p).toContain("write_file/edit_file");
    expect(p).toContain("Do not always explorer→implement→critic");
  });

  test("systemPrompt routes URL reads through web_fetch on primary", () => {
    const p = skywalkerPackage.systemPrompt;
    expect(p).toContain("Fetch URLs");
    expect(p).toContain("web_fetch");
    expect(p).toContain("already mounted");
    expect(p).toContain("curl/wget");
  });

  test("systemPrompt requires brief completeness for multi-worker dispatch", () => {
    const p = skywalkerPackage.systemPrompt;
    expect(p).toContain("Brief completeness");
    expect(p).toContain("success_criteria");
    expect(p).toContain("do_not");
    expect(p).toContain("report_focus");
    expect(p).toContain("multi-worker");
  });

  test("systemPrompt does not use leaf jargon", () => {
    expect(skywalkerPackage.systemPrompt).not.toMatch(/\bleaf\b/i);
    expect(skywalkerPackage.systemPrompt).not.toMatch(/\bleaves\b/i);
  });

  test("systemPrompt puts API signatures into implement success_criteria", () => {
    const p = skywalkerPackage.systemPrompt;
    expect(p).toContain("function signature or return shape");
    expect(p).toContain("verbatim");
    expect(p).toContain("sync vs Promise");
    expect(p).toContain("implement success_criteria");
  });

  test("systemPrompt has critic-after-implement verify path", () => {
    const p = skywalkerPackage.systemPrompt;
    expect(p).toContain("Verify after ship");
    expect(p).toContain("public-API");
    expect(p).toContain("critic");
    expect(p).toContain("tester");
    expect(p).toContain("correctness/brief gaps");
  });

  test("systemPrompt spawn-target for substantial code is builder, not implement", () => {
    const p = skywalkerPackage.systemPrompt;
    expect(p).toContain("spawn builder");
    expect(p).toContain("spawn (builder for code");
    expect(p).toContain("builder = ship product code + tests");
    expect(p).not.toContain("implement = ship product code + tests");
    expect(p).not.toMatch(/\bspawn implement\b/);
    expect(p).toContain("explorer → implement → critic");
    expect(p).toContain("Do not always explorer→implement→critic");
  });

  test("systemPrompt re-dispatches builder on blocking critic", () => {
    const p = skywalkerPackage.systemPrompt;
    expect(p).toContain("blocking");
    expect(p).toContain("re-dispatch **builder**");
    expect(p).toContain("ship → verify → fix → re-verify");
    expect(p).toContain("Cap re-fix rounds");
  });
});
