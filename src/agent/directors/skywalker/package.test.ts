import { describe, expect, test } from "bun:test";
import { createSkywalkerSystemPrompt, skywalkerPackage } from "./package.js";

describe("skywalkerPackage", () => {
  test("systemPrompt names Skywalker and the DIY lane", () => {
    expect(skywalkerPackage.systemPrompt).toContain("You are Skywalker");
    expect(skywalkerPackage.systemPrompt).toContain(
      "When asked your name, answer: Skywalker",
    );
    expect(skywalkerPackage.systemPrompt).toContain(
      "write_file/edit_file/delete_file",
    );
    expect(skywalkerPackage.systemPrompt).toContain(
      "DIY tiny/single-file/one-route",
    );
  });

  test("createSkywalkerSystemPrompt returns package systemPrompt", () => {
    expect(createSkywalkerSystemPrompt()).toBe(skywalkerPackage.systemPrompt);
  });

  test("dispatcher card stays in the 3–5k band", () => {
    const p = skywalkerPackage.systemPrompt;
    expect(p.length).toBeGreaterThanOrEqual(3000);
    expect(p.length).toBeLessThanOrEqual(5000);
  });

  test("idle, mailbox, and poll stay out of the card", () => {
    const p = skywalkerPackage.systemPrompt;
    expect(p).not.toMatch(/idle/i);
    expect(p).not.toMatch(/mailbox/i);
    expect(p).not.toMatch(/\bpoll\b/i);
    expect(p).not.toContain("wait_agents");
  });

  test("card is not a Karen clone", () => {
    const p = skywalkerPackage.systemPrompt;
    expect(p).not.toMatch(/karen/i);
    expect(p).not.toContain("section 9");
    expect(p).not.toContain("You orchestrate.");
  });

  test("spawn allowlist is the full closed set", () => {
    expect(skywalkerPackage.spawn.allowlist).toHaveLength(19);
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
      "gauntlet",
      "prober",
      "migrator",
      "warden",
    ]);
  });

  test("tools.allow mounts agent search for DIY delegation", () => {
    const allow = skywalkerPackage.tools?.allow ?? [];
    expect(allow).toContain("search_agents");
  });

  test("modelRole is orchestrator", () => {
    expect(skywalkerPackage.modelRole).toBe("orchestrator");
  });

  test("optionalSkills order", () => {
    expect(skywalkerPackage.optionalSkills).toEqual([
      "style",
      "philosophy",
      "native-integration",
      "interview",
    ]);
  });

  test("systemPrompt has no Ponytail routing or mode internals", () => {
    const p = skywalkerPackage.systemPrompt;
    expect(p).not.toMatch(/ponytail/i);
    expect(p).not.toContain("Default to `lite`");
    expect(p).not.toContain("Escalation ladder");
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
    expect(skywalkerPackage.outOfLane).toContain(
      "diagnostic fleets for why/how/stall questions",
    );
  });

  test("systemPrompt classifies, DIY in Builder neighborhood, and routes named specialists", () => {
    const p = skywalkerPackage.systemPrompt;
    expect(p).toContain("# Classify");
    expect(p).toContain("COMMUNICATION");
    expect(p).toContain("IMPLEMENTATION");
    expect(p).toContain("ORCHESTRATION");
    expect(p).toContain("Builder neighborhood");
    expect(p).toContain("operator surface");
    expect(p).toContain("# Routing");
    expect(p).toContain("builder = ship product code + tests");
    expect(p).toContain("No catch-all worker");
    expect(p).not.toContain("one-agent-per-task");
    expect(p).not.toContain("one agent per task");
  });

  test("systemPrompt gives each worker one focused task", () => {
    const p = skywalkerPackage.systemPrompt;
    expect(p).toContain("one focused task");
    expect(p).toContain("one lane per PR/path/ownership");
    expect(p).toContain("Do not pack a multi-step workflow into one worker");
    expect(p).toContain("keep it tight");
    expect(p).toContain("One job per spawn");
    expect(p).not.toContain("2–4 workers");
    expect(p).not.toContain("at most 4");
    expect(p).not.toContain("Prefer synthesizing early returns");
    expect(p).not.toContain("queues excess");
  });

  test("systemPrompt parent tools tell the parent not to run long-blocking jobs", () => {
    const p = skywalkerPackage.systemPrompt;
    expect(p).toContain("long-blocking");
    expect(p).toContain("dispatch intern");
    expect(p).toContain("tester");
    expect(p).toContain("builder");
  });

  test("systemPrompt requires frequent operator updates", () => {
    const p = skywalkerPackage.systemPrompt;
    expect(p).toContain("# Operator surface");
    expect(p).toContain("only surface that talks to the operator");
    expect(p).toContain("frequent short status updates");
    expect(p).toContain("send_input");
  });

  test("systemPrompt does not forbid steering workers when the operator messages mid-run", () => {
    const p = skywalkerPackage.systemPrompt;
    expect(p).not.toContain("answer them first");
    expect(p).not.toContain("Do not hold the reply on fleet collection");
  });

  test("systemPrompt simple path skips explorer+critic for tiny work", () => {
    const p = skywalkerPackage.systemPrompt;
    expect(p).toContain("Skip spawn, skip explorer, skip plan, skip critic");
    expect(p).toContain("write_file/edit_file");
  });

  test("systemPrompt routes URL reads through web_fetch on primary", () => {
    const p = skywalkerPackage.systemPrompt;
    expect(p).toContain("web_fetch");
    expect(p).toContain("already mounted");
    expect(p).toContain("curl/wget");
  });

  test("systemPrompt teaches spawn handoff packet for dispatch", () => {
    const p = skywalkerPackage.systemPrompt;
    expect(p).toContain("success_criteria");
    expect(p).toContain("do_not");
    expect(p).toContain("Child starts blank");
    expect(p).toContain("clean-room");
    expect(p).toContain("no fork");
    expect(p).toContain("required for implement/review");
    expect(p).toContain("keep it tight");
    expect(p).toContain("One job per spawn");
    expect(p).not.toContain("Runtime requires success_criteria");
    expect(p).not.toContain("Brief completeness");
    expect(p).not.toContain("Prefer typed spawn");
  });

  test("systemPrompt report envelope names each section header explicitly", () => {
    const p = skywalkerPackage.systemPrompt;
    expect(p).toContain("# Report shape");
    expect(p).toContain("## Summary");
    expect(p).toContain("## Findings");
    expect(p).toContain("## Blockers");
    expect(p).toContain("## Paths");
  });

  test("systemPrompt does not use leaf jargon", () => {
    expect(skywalkerPackage.systemPrompt).not.toMatch(/\bleaf\b/i);
    expect(skywalkerPackage.systemPrompt).not.toMatch(/\bleaves\b/i);
  });

  test("systemPrompt answers parked director questions via send_input", () => {
    const p = skywalkerPackage.systemPrompt;
    expect(p).toContain("ask_director");
    expect(p).toContain("send_input");
    expect(p).toMatch(/target = (that worker's |worker )session id/);
    expect(p).toMatch(
      /Escalate with ask_operator only when you cannot resolve it/,
    );
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
    expect(p).toContain("tester");
    expect(p).toMatch(/after every delegated builder landing.*run critic/is);
    expect(p).toMatch(/Builder self-report.*never sufficient to skip/is);
    expect(p).toContain("add greybeard when architecture is in play");
    expect(p).toMatch(/Skip a new critic only for parent-DIY/i);
  });

  test("systemPrompt spawn-target for substantial code is builder, not implement", () => {
    const p = skywalkerPackage.systemPrompt;
    expect(p).toContain("spawn builder");
    expect(p).toContain("builder = ship product code + tests");
    expect(p).not.toContain("implement = ship product code + tests");
    expect(p).not.toMatch(/\bspawn implement\b/);
    expect(p).toContain("Tiny parent-DIY edits stay plan-optional");
    expect(p).toContain("`/implement` does not steal planning from `/plan`");
  });

  test("systemPrompt re-dispatches builder on blocking critic", () => {
    const p = skywalkerPackage.systemPrompt;
    expect(p).toContain("blocking");
    expect(p).toContain("re-dispatch builder");
    expect(p).toMatch(/narrowed brief/i);
  });

  test("systemPrompt Linear three-state: In Review at PR-open, never Done at PR-open", () => {
    const p = skywalkerPackage.systemPrompt;
    expect(p).toContain("In Progress");
    expect(p).toContain("In Review");
    expect(p).toMatch(/ready for review/);
    expect(p).toContain("never Done at PR-open");
    expect(p).not.toContain("mcp__linear__save_issue");
    expect(p).not.toContain("gh pr create");
    expect(p).not.toContain("gh pr review");
  });

  test("systemPrompt routes mutation-checks to gauntlet", () => {
    const p = skywalkerPackage.systemPrompt;
    expect(p).toContain("gauntlet = mutation-check");
  });

  test("systemPrompt routes trust-path diffs to warden", () => {
    const p = skywalkerPackage.systemPrompt;
    expect(p).toContain("warden = permission / provider-auth / plugin-loader");
    expect(p).toContain("add warden when the diff touches permission");
  });
});
