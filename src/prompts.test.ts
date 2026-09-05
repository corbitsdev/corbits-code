import { expect, test } from "bun:test";

import { createChatDirector, submitOutputDefinition } from "./agent/director.js";
import { manageTasksDefinition } from "./agent/tasks.js";
import { CHAT_PROMPT_QUALITY_MARKERS } from "./agent/prompt-contract.js";
import { hasReportEnvelope } from "./subagent/report.js";
import {
  buildActiveContext,
  buildAvailableTools,
  buildChatRole,
  buildChatSystemPrompt,
  buildEnvironmentContext,
  buildGuidelines,
  buildGrokLeafAntiThrashNote,
  buildHarnessFacts,
  buildSkillsSection,
  buildSubAgentReportContract,
  buildSubAgentSystemPrompt,
} from "./agent/prompts.js";

const minimalToolDefinitions = [manageTasksDefinition, submitOutputDefinition];

test("buildChatSystemPrompt wires into createChatDirector without error", () => {
  const prompt = buildChatSystemPrompt();
  expect(() =>
    createChatDirector(prompt, minimalToolDefinitions, { onTasksChange: () => {} }),
  ).not.toThrow();
});

test("chat prompt orders base, then tools, then context", () => {
  const prompt = buildChatSystemPrompt();
  expect(prompt.indexOf(buildChatRole())).toBe(0);
  expect(prompt.indexOf(buildChatRole())).toBeLessThan(prompt.indexOf(buildHarnessFacts()));
  expect(prompt.indexOf(buildHarnessFacts())).toBeLessThan(prompt.indexOf(buildGuidelines()));
  expect(prompt.indexOf(buildGuidelines())).toBeLessThan(prompt.indexOf("Tools:"));
  expect(prompt.indexOf("Tools:")).toBeLessThan(prompt.indexOf("Active context:"));
});

test("agent identity is Skywalker orchestrator", () => {
  const orchestrator = buildChatRole("orchestrator");
  expect(orchestrator).toContain("You are Skywalker");
  expect(orchestrator).toContain("Corbits Code");
  expect(orchestrator).toContain("When asked your name, answer: Skywalker");
  expect(orchestrator).toContain("PRIMARY INTENT");
  expect(orchestrator).toContain("Delegate");
  expect(orchestrator).toContain("Match operator tone");
  // Mode arg is ignored — product is orchestrator-only (CL-5814).
  expect(buildChatRole()).toContain("You are Skywalker");
});

test("harness facts state only the non-derivable tool and safety rules", () => {
  const facts = buildHarnessFacts();
  expect(facts).toContain("write_file/edit_file");
  expect(facts).toContain("tiny/single-file/one-route");
  expect(facts).toContain("Spawn builder");
  expect(facts).not.toContain("not mounted on the primary Skywalker session");
  expect(facts).toContain("blocked");
  expect(facts).toContain("no default timeout");
  expect(facts).toContain("find, rg, and grep -r");
  expect(facts).toMatch(/OOM the host/);
  expect(facts).toMatch(/Prefer the bounded grep\/search_files tools/);
  expect(facts).toMatch(/not substitute another unbounded walk \(fd, ls -R, scripted os\.walk\)/);
  expect(facts).not.toMatch(/Use grep, search_files, and list_dir\.$/m);
  expect(facts).toContain("operator approval");
  expect(facts).toContain("tool_search");
  expect(facts).toContain("plugins or integrations");
  expect(facts).toContain("slash-command steps");
  expect(facts).toContain(".corbits/MEMORY.md");
  expect(facts).toContain("Attached images are native multimodal input");
  expect(facts).toContain("parent tool.boundary");
  expect(facts).toContain("session-idle");
  expect(facts).not.toContain("Tool results already render richly");
});

test("harness facts name skill_search as a resident catalog tool", () => {
  const facts = buildHarnessFacts();
  expect(facts).toMatch(/advertised catalog \(including skill_search\) are resident/);
  expect(facts).not.toContain("Only the core tools below are loaded");
  // skill_search is catalog-advertised and excluded from tool_search results.
  expect(facts).not.toMatch(/only the core tools[\s\S]*tool_search/i);
});

test("leaf harness facts advertise product write tools", () => {
  const facts = buildHarnessFacts({ subAgent: true, dynamicTools: false });
  expect(facts).toContain("write_file/edit_file");
  expect(facts).not.toContain("not mounted on the primary Skywalker session");
});

test("leaf harness facts state no-budget report completion behavior", () => {
  const facts = buildHarnessFacts({ subAgent: true, dynamicTools: false });
  expect(facts).toContain("There is no turn budget");
  expect(facts).toContain("one incomplete-report nudge");
  expect(facts).toContain("next tool-less reply still omits the envelope");
  expect(facts).toContain("completion, cancellation, an opt-in deadline, or a stall");
  expect(facts).not.toContain("Turn budget is real");
  expect(facts).not.toContain("wrap-up nudge may fire");
  expect(facts).not.toContain("as the budget ends");
});

test("guidelines cover response style, tool choice, ask vs proceed, and scope", () => {
  const guidelines = buildGuidelines();
  expect(guidelines).toContain("Response style:");
  expect(guidelines).toContain("Tool choice:");
  expect(guidelines).toContain("Ask vs proceed:");
  expect(guidelines).toContain("Scope and conventions:");
  expect(guidelines).toContain("grep or search_files");
  expect(guidelines).toContain("ask_operator only when permission blocks you");
  expect(guidelines).toContain("skill_search when choosing");
  expect(guidelines).toContain("use_skill style and philosophy when starting repo work");
  expect(guidelines).toContain("DIY tiny/single-file/one-route");
  expect(guidelines).toContain("never shell-write (echo/heredoc/sed/rm)");
  expect(guidelines).not.toContain("not mounted on Skywalker");
  expect(buildGuidelines({ subAgent: true })).not.toContain(
    "use_skill style and philosophy when starting repo work",
  );
});

test("orchestrator guidelines teach the typed task spawn contract", () => {
  const guidelines = buildGuidelines({ sessionMode: "orchestrator" });
  expect(guidelines).toContain("Orchestration:");
  expect(guidelines).toContain("success_criteria");
  expect(guidelines).toContain("do_not");
  expect(guidelines).toContain("report_focus");
  expect(guidelines).toContain("intent");
  expect(guidelines).toContain("spawn_agent");
  expect(guidelines).toContain("wait_agents");
  expect(guidelines).toContain("required for implement/review");
  expect(guidelines).toContain("and their default directors");
  expect(guidelines).not.toContain("weaker");
});

test("primary chat prompt does not invite auto-starting the next worker after unfinished specialists", () => {
  const prompt = buildChatSystemPrompt();
  const guidelines = buildGuidelines({ sessionMode: "orchestrator" });
  expect(guidelines).not.toContain("change the brief rather than repeating it");
  expect(guidelines).not.toContain("start the next worker");
  expect(prompt).not.toContain("Then start the next worker");
  expect(prompt).not.toContain("if the job still needs doing");
});

test("primary guidelines advise against early-stop from compaction token fear", () => {
  const guidelines = buildGuidelines();
  expect(guidelines).toContain("compacted automatically");
  expect(guidelines).toContain("do not stop tasks early due to token fear");
  expect(guidelines).toContain("manage_tasks and worker reports");
  // Leaf guidelines omit primary orchestration compaction guidance.
  expect(buildGuidelines({ subAgent: true })).not.toContain("token fear");
});

test("chat system prompt satisfies system prompt quality markers", () => {
  const prompt = buildChatSystemPrompt();
  for (const marker of CHAT_PROMPT_QUALITY_MARKERS) {
    expect(prompt).toContain(marker);
  }
});

test("default session lists split fleet tools and search_agents", () => {
  const prompt = buildChatSystemPrompt(undefined, undefined, undefined, [], "orchestrator");
  expect(prompt).not.toContain("- task:");
  expect(prompt).toContain("- spawn_agent:");
  expect(prompt).toContain("- wait_agents:");
  expect(prompt).toContain("- search_agents:");
});

test("chat prompt advertises core tools but never enumerates MCP integrations", () => {
  const prompt = buildChatSystemPrompt();
  expect(prompt).toContain("read_file");
  expect(prompt).toContain("tool_search");
  expect(prompt).not.toContain("mcp__");
  // No static catalog dump — discovery is via tool_search, not a listed catalog.
  expect(prompt).not.toContain("Discoverable tools");
});

test("lists skill names without descriptions and points at skill_search then use_skill", () => {
  const prompt = buildChatSystemPrompt(undefined, undefined, undefined, [
    { name: "scribe", description: "write docs" },
  ]);
  expect(prompt).toContain("Skills (");
  expect(prompt).toContain("scribe");
  expect(prompt).not.toContain("write docs");
  expect(prompt).toContain("skill_search");
  expect(prompt).toContain("use_skill");
});

test("buildSkillsSection for a synthetic 10-name roster stays under a few hundred chars", () => {
  const roster = Array.from({ length: 10 }, (_, i) => ({
    name: `skill${i}`,
    description: "x".repeat(400),
  }));
  const section = buildSkillsSection(roster);
  expect(section.length).toBeLessThan(400);
  expect(Buffer.byteLength(section, "utf8")).toBeLessThan(400);
  for (const skill of roster) {
    expect(section).toContain(skill.name);
    expect(section).not.toContain(skill.description);
  }
  expect(section).toContain("skill_search");
  expect(section).toContain("use_skill");
});

test("omits the skills section when no skills are available", () => {
  expect(buildChatSystemPrompt()).not.toContain("Skills (");
});

test("a SYSTEM.md base override replaces the static base but keeps tools and context", () => {
  const override = "You are a custom agent with project-specific rules.";
  const prompt = buildChatSystemPrompt(undefined, undefined, override);
  expect(prompt).toContain(override);
  expect(prompt).not.toContain(buildChatRole());
  expect(prompt).toContain("## Session mode");
  expect(prompt).toContain("Orchestration:");
  // Tools and context still attach.
  expect(prompt).toContain("Tools:");
  expect(prompt).toContain("Active context:");
});

test("SYSTEM.md override still appends orchestrator harness rules", () => {
  const override = "You are a custom agent that mentions delegating to workers.";
  const prompt = buildChatSystemPrompt(undefined, undefined, override, []);
  expect(prompt).toContain(override);
  expect(prompt).toContain("## Session mode");
  expect(prompt).toContain("Orchestration:");
  expect(prompt).toContain("- spawn_agent:");
  expect(prompt).toContain("- wait_agents:");
});

test("an empty base override falls back to the default base", () => {
  const prompt = buildChatSystemPrompt(undefined, undefined, "   ");
  expect(prompt).toContain(buildChatRole());
  expect(prompt).toContain(buildHarnessFacts());
});

test("extensions are appended after the base, tools, and context", () => {
  const ext = "## Project guidance\n\nUse tabs, not spaces.";
  const prompt = buildChatSystemPrompt([ext]);
  expect(prompt).toContain(ext);
  expect(prompt.indexOf("Active context:")).toBeLessThan(prompt.indexOf(ext));
});

test("buildActiveContext includes the current date in DD/MM/YYYY and the memory path", () => {
  const context = buildActiveContext(new Date(2026, 5, 5), "/repo/root");
  expect(context).toContain("Active context:");
  expect(context).toContain("Current Date: 05/06/2026 (prompt cache survives for <=24hr)");
  expect(context).toContain("/repo/root/.corbits/MEMORY.md");
  expect(context).toContain("Working Directory: /repo/root");
});

test("without an env, the chat prompt ends with the static active context", () => {
  const prompt = buildChatSystemPrompt();
  expect(prompt.trim()).toMatch(/\.corbits\/MEMORY\.md/);
  expect(prompt).toMatch(/Current Date: \d{2}\/\d{2}\/\d{4} \(prompt cache survives for <=24hr\)/);
});

test("when an env is supplied, the prompt ends with a live <env> block instead", () => {
  const env = {
    cwd: "/repo/root",
    platform: "Darwin 25.4.0",
    arch: "arm64",
    runtime: "Bun 1.2.0",
    date: new Date(2026, 5, 5),
    isGitRepo: true,
    gitBranch: "main",
    gitDirtyCount: 2,
    gitStatusSummary: " M src/a.ts\n?? tmp/",
    topLevel: "src/  tests/  package.json",
  };
  const prompt = buildChatSystemPrompt(undefined, env);
  expect(prompt).toContain("<env>");
  expect(prompt.trim()).toMatch(/<\/env>$/);
  expect(prompt).toContain("Working directory: /repo/root");
  expect(prompt).toContain("Arch: arm64");
  expect(prompt).toContain("Runtime: Bun 1.2.0");
  expect(prompt).toContain("Git: on main, 2 uncommitted change(s):");
  expect(prompt).toContain(" M src/a.ts");
  expect(prompt).not.toContain("Active context:");
});

test("buildEnvironmentContext reports a clean tree and a non-git directory", () => {
  const clean = buildEnvironmentContext({
    cwd: "/r",
    platform: "Linux 6",
    arch: "x64",
    runtime: "Bun 1.2.0",
    date: new Date(2026, 0, 1),
    isGitRepo: true,
    gitBranch: "dev",
    gitDirtyCount: 0,
  });
  expect(clean).toContain("Git: on dev, working tree clean");
  expect(clean).toContain("Arch: x64");

  const noGit = buildEnvironmentContext({
    cwd: "/r",
    platform: "Linux 6",
    arch: "x64",
    runtime: "Bun 1.2.0",
    date: new Date(2026, 0, 1),
    isGitRepo: false,
  });
  expect(noGit).toContain("Git: not a git repository");
});

test("buildAvailableTools lists exactly the tools it is given", () => {
  const custom = ["read_file", "write_file"];
  const listed = buildAvailableTools(custom);
  expect(listed).toContain("read_file");
  expect(listed).toContain("write_file");
  expect(listed).not.toContain("tool_search");
});

test("sub-agent prompt carries the report-back contract and harness facts", () => {
  // Context interpolates cwd. A worktree path containing "ask_operator" would
  // poison this check even when the prompt does not advertise the tool.
  const prompt = buildSubAgentSystemPrompt(undefined, {
    cwd: "/repo/root",
    platform: "Darwin 25.4.0",
    arch: "arm64",
    runtime: "Bun 1.2.0",
    date: new Date(2026, 5, 5),
    isGitRepo: false,
  });
  expect(prompt).toContain("fleet agent — a worker dispatched by Corbits Code");
  expect(prompt).toContain("Reporting back:");
  expect(prompt).toContain("only thing returned to the parent");
  expect(prompt).toContain("ask_director");
  expect(prompt).toContain("Change files with write_file/edit_file");
  expect(prompt).toContain("remove files with delete_file");
  expect(prompt).toContain("parent session's permission gate");
  expect(prompt).not.toContain("without asking for approval");
  expect(prompt).not.toContain("ask_operator");
  expect(prompt).not.toContain("you cannot ask the parent mid-run");
  expect(prompt).not.toContain("You are a sub-agent");
});

test("when ask_director is in toolNames, the worker prompt mentions ask_director", () => {
  const prompt = buildSubAgentSystemPrompt(undefined, undefined, undefined, {
    toolNames: ["read_file", "ask_director"],
  });
  expect(prompt).toContain("ask_director");
  expect(prompt).toContain("cannot reach the operator");
  expect(prompt).not.toContain("ask_operator");
});

test("sub-agent report contract treats Success criteria as completion gate", () => {
  const contract = buildSubAgentReportContract();
  expect(contract).toContain("Success criteria");
  expect(contract).toContain("done-definition");
  expect(contract).toContain("stop calling tools");
  expect(contract).toContain("Do not");
  expect(contract).toContain("Intent / Do not");
});

// Pins the only real report-envelope mechanism (buildSubAgentReportContract's
// prompt text and hasReportEnvelope's completeness check) to stay in sync,
// since director packages no longer declare their own requiredSections
// (CL-6969: that field was inert and enforced nothing).
test("sub-agent report contract's headings satisfy hasReportEnvelope", () => {
  const contract = buildSubAgentReportContract();
  const headingsOnly = contract
    .split("\n")
    .filter((line) => line.startsWith("## "))
    .join("\n");
  expect(hasReportEnvelope(headingsOnly)).toBe(true);
});

test("sub-agent prompt does not advertise tool_search (it gets the full toolset)", () => {
  const prompt = buildSubAgentSystemPrompt();
  expect(prompt).not.toContain("tool_search");
  expect(prompt).toContain("your full toolset");
});

// Pins the appendix-last invariant for JS-plugin agents: regardless of how the
// systemPromptRole is sourced (data-only markdown vs. a JS plugin's
// `agentPlugin.agents[i].systemPromptRole`), `buildSubAgentSystemPrompt` is
// the single point that appends the Corbits Code translation notes — so a
// JS-plugin-only path that bypasses the data-only loader still gets them.
test("sub-agent prompt always appends Corbits Code notes, even with a JS-plugin-style systemPromptRole", () => {
  const role = "You are a JS-plugin scout. Map the call graph and report.";
  const prompt = buildSubAgentSystemPrompt([role]);
  expect(prompt).toContain(role);
  expect(prompt).toContain("## Corbits Code notes");
  // Workers get the no-recursion rule, not the spawn syntax.
  expect(prompt).toContain("You are a worker");
  // Agent voice leads; translation notes are the last section.
  expect(prompt.indexOf(role)).toBeLessThan(prompt.indexOf("## Corbits Code notes"));
});

// Default sub-agents must NOT recurse — the appendix tells them to return a
// concrete report instead of spawning further agents. This is the rule that
// stops a fan-out of sub-agents each fanning out further.
test("default sub-agent prompt forbids recursion", () => {
  const prompt = buildSubAgentSystemPrompt();
  expect(prompt).toContain(
    "Only the primary Corbits Code session (or a built-in orchestrator director) may call `spawn_agent`",
  );
  expect(prompt).toContain("You are a worker");
});

// Built-in orchestrator directors are the documented exception to the
// no-recursion rule — their purpose IS to fan work out to
// other agents. The appendix grants them permission and links the syntax.
test("orchestrator sub-agent prompt grants the spawn_agent recursion exception", () => {
  const prompt = buildSubAgentSystemPrompt(undefined, undefined, undefined, {
    orchestrator: true,
  });
  expect(prompt).toContain("You are an orchestrator");
  expect(prompt).toContain("MAY call `spawn_agent`");
  expect(prompt).toContain(
    'spawn_agent(agent="greybeard", description="Review approach", prompt="...")',
  );
  expect(prompt).not.toContain("Prefer search_agents");
  // Must NOT contain the default no-recursion line — that would contradict
  // the permission grant in the same appendix.
  expect(prompt).not.toContain(
    "Only the primary Corbits Code session (or a built-in orchestrator director) may call `spawn_agent`",
  );
});

test("sub-agent prompt requires structured report envelope and stick-to-brief", () => {
  const prompt = buildSubAgentSystemPrompt();
  expect(prompt).toContain("## Summary");
  expect(prompt).toContain("## Findings");
  expect(prompt).toContain("## Blockers");
  expect(prompt).toContain("## Paths");
  expect(prompt).toContain("Stick to the dispatch brief");
  expect(prompt).toContain("manage_tasks checklist");
});

test("default sub-agent prompt omits Grok anti-thrash residual", () => {
  const prompt = buildSubAgentSystemPrompt();
  expect(prompt).not.toContain("Finish bias (xAI / Grok worker)");
});

test("grokAntiThrash opts appends tiny finish-bias note before appendix", () => {
  const prompt = buildSubAgentSystemPrompt(undefined, undefined, undefined, {
    grokAntiThrash: true,
  });
  const note = buildGrokLeafAntiThrashNote();
  expect(prompt).toContain(note);
  expect(prompt).toContain("prefer the structured report");
  expect(prompt).toContain("re-open paths you already read");
  expect(prompt).toContain(
    "When the dispatch brief's done-definition is met, write the report envelope",
  );
  expect(prompt).not.toContain("Leave the last turn");
  expect(prompt).not.toContain("spend the budget");
  // Appendix still last.
  expect(prompt.indexOf("Finish bias (xAI / Grok worker)")).toBeLessThan(
    prompt.indexOf("## Corbits Code notes"),
  );
});
