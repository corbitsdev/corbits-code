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
    expect(allow).not.toContain("task");
    expect(allow).toContain("spawn_agent");
    expect(allow).toContain("wait_agents");
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
    expect(p).not.toContain("at most 4");
    expect(p).not.toContain("Prefer synthesizing early returns");
    expect(p).toContain("queues excess");
    expect(p).toContain("Do not invent a numeric cap");
  });

  test("systemPrompt prefers spawn_agent then wait_agents (idle-orchestrator)", () => {
    const p = skywalkerPackage.systemPrompt;
    expect(p).toContain("spawn_agent");
    expect(p).toContain("wait_agents");
    expect(p).toContain("Idle-orchestrator");
    expect(p).not.toContain("task()");
    expect(p).toContain('mode="all"');
    expect(p).toContain("uncollected spawns");
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
    expect(p).toContain("synthesize what returned");
    expect(p).toContain("do **not** re-fan-out another diagnostic wave");
    expect(p).not.toContain("Then start the next worker");
    expect(p).not.toContain("if the job still needs doing");
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

  test("systemPrompt teaches spawn handoff packet for dispatch", () => {
    const p = skywalkerPackage.systemPrompt;
    expect(p).toContain("Spawn handoff");
    expect(p).toContain("success_criteria");
    expect(p).toContain("do_not");
    expect(p).toContain("Child starts blank");
    expect(p).toContain("clean-room");
    expect(p).toContain("no fork");
    expect(p).toContain("required for implement/review");
    expect(p).not.toContain("Brief completeness");
    expect(p).not.toContain("Prefer typed spawn");
    expect(p.indexOf("Critic stays clean-room")).toBeGreaterThan(p.indexOf("# Verify after ship"));
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

  test("systemPrompt requires critic after every builder implementation", () => {
    const p = skywalkerPackage.systemPrompt;
    expect(p).toContain("Verify after ship");
    expect(p).toContain("tester");
    expect(p).toContain("correctness/brief gaps");
    expect(p).toMatch(/after every delegated \*\*builder\*\* implementation.*run \*\*critic\*\*/is);
    expect(p).toMatch(
      /substantial implementation limited to one internal file.*still requires Critic/is,
    );
    expect(p).toMatch(/Builder self-report.*never sufficient to skip/is);
    expect(p).toMatch(
      /After every delegated builder landing.*run a critic.*architecture.*add greybeard/is,
    );
    expect(p).not.toMatch(/critic \(or greybeard when architecture is in play\)/i);
    expect(p).toMatch(
      /Skip a new Critic dispatch only for parent-DIY work or when existing independent review evidence already covers both the resulting diff and its success criteria/i,
    );
    expect(p).not.toMatch(/Multi-file or public-API changes: after builder/i);
    expect(p).not.toMatch(/After multi-file builder landings/i);
    expect(p).not.toMatch(/self-report is thin/i);
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
    expect(p).toMatch(/narrowed or changed follow-up brief/i);
    expect(p).toContain("ship → verify → fix → re-verify");
    expect(p).toContain("Cap re-fix rounds");
  });
});
