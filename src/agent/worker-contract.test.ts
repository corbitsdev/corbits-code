import { describe, expect, test } from "bun:test";
import {
  buildWorkerContract,
  buildWorkerToolNames,
  type WorkerContractOptions,
} from "./worker-contract.js";
import { buildSubAgentReportContract } from "./prompts.js";

const VARIANTS: WorkerContractOptions[] = [
  {},
  { askDirector: true },
  { orchestrator: true },
  { askDirector: true, orchestrator: true },
];

describe("buildWorkerContract", () => {
  test("report envelope is byte-identical to buildSubAgentReportContract", () => {
    for (const opts of VARIANTS) {
      const askDirector = opts.askDirector === true;
      expect(
        buildWorkerContract(opts).endsWith(
          buildSubAgentReportContract({ askDirector }),
        ),
      ).toBe(true);
    }
  });

  test("contract stays lean (<= ~2.2k chars in every variant)", () => {
    for (const opts of VARIANTS) {
      expect(buildWorkerContract(opts).length).toBeLessThanOrEqual(2200);
    }
  });

  test("carries no idle/poll/mailbox/tool-catalog/appendix copy", () => {
    for (const opts of VARIANTS) {
      const contract = buildWorkerContract(opts);
      expect(contract).not.toContain("mailbox");
      expect(contract).not.toContain("do not poll");
      expect(contract).not.toMatch(/\breply and idle\b/i);
      expect(contract).not.toContain("## Corbits Code notes");
      expect(contract).not.toContain("Prompt discipline:");
      expect(contract).not.toContain("Guidelines:");
      expect(contract).not.toContain("Harness facts:");
      expect(contract).not.toContain("Tools:");
    }
  });

  test("ask rule names ask_director only when mounted", () => {
    const withAsk = buildWorkerContract({ askDirector: true });
    expect(withAsk).toContain("ask_director");
    expect(withAsk).toContain("cannot reach the operator");
    const withoutAsk = buildWorkerContract({ askDirector: false });
    expect(withoutAsk).not.toContain("ask_director");
    expect(withoutAsk).toContain("best-judgment");
  });

  test("default worker gets the no-recursion rule, not the spawn grant", () => {
    const contract = buildWorkerContract({ askDirector: true });
    expect(contract).toContain(
      "Only the primary Corbits Code session (or a built-in orchestrator director) may call `spawn_agent`",
    );
    expect(contract).toContain("You are a worker");
    expect(contract).not.toContain("MAY call `spawn_agent`");
  });

  test("orchestrator variant grants the spawn exception without mailbox copy", () => {
    const contract = buildWorkerContract({
      askDirector: true,
      orchestrator: true,
    });
    expect(contract).toContain("You are an orchestrator");
    expect(contract).toContain("MAY call `spawn_agent`");
    expect(contract).toContain(
      'spawn_agent(agent="greybeard", description="Review approach", prompt="...")',
    );
    expect(contract).not.toContain(
      "Only the primary Corbits Code session (or a built-in orchestrator director) may call `spawn_agent`",
    );
    expect(contract).not.toContain("mailbox");
  });

  test("contract owns the skill-escalation rule (deny-safe)", () => {
    const contract = buildWorkerContract({ askDirector: true });
    expect(contract).toContain(
      "Skills are available; search only when the brief names a skill or the task is outside your lane. For a small, bounded edit, do not search skills.",
    );
    expect(contract).toContain(
      "Load a brief-named skill straight through use_skill",
    );
    expect(contract).toContain("load only the skills the task needs");
    // Deny-safe: grok/kimi leaves omit skill_search, so discovery is
    // conditional on the tool being mounted — never mandated.
    expect(contract).not.toContain("Call skill_search for descriptions");
    expect(contract).toContain("it is mounted");
  });
});

describe("buildWorkerToolNames", () => {
  test("lists names only, no catalog summaries", () => {
    const listed = buildWorkerToolNames(["read_file", "ask_director"]);
    expect(listed).toBe("Tools (names only): read_file, ask_director");
    expect(listed).not.toContain("cat/head/tail");
  });
});
