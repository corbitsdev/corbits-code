import { expect, test } from "bun:test";

import {
  createChatDirector,
  submitOutputDefinition,
} from "./agent/director.js";
import { manageTasksDefinition } from "./agent/tasks.js";
import { CHAT_PROMPT_QUALITY_MARKERS } from "./agent/prompt-contract.js";
import { hasPlanFindings, hasReportEnvelope } from "./subagent/report.js";
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

// Module-scope snapshots of the repeated no-arg prompt builders. Each builder
// is deterministic for absent input (the only per-call variance is the
// current-date/cwd context line, which no assertion pins exactly), so the
// no-arg calls below share one value instead of rebuilding it each time.
// Arg-taking variants keep calling the builders directly.
const CHAT_SYSTEM_PROMPT = buildChatSystemPrompt();
const CHAT_ROLE = buildChatRole();
const HARNESS_FACTS = buildHarnessFacts();
const GUIDELINES = buildGuidelines();
const REPORT_CONTRACT = buildSubAgentReportContract();
const SUBAGENT_SYSTEM_PROMPT = buildSubAgentSystemPrompt();

test("buildChatSystemPrompt wires into createChatDirector without error", () => {
  expect(() =>
    createChatDirector(CHAT_SYSTEM_PROMPT, minimalToolDefinitions, {}),
  ).not.toThrow();
});

test("chat prompt orders base, then tools, then context", () => {
  expect(CHAT_SYSTEM_PROMPT.indexOf(CHAT_ROLE)).toBe(0);
  expect(CHAT_SYSTEM_PROMPT.indexOf(CHAT_ROLE)).toBeLessThan(
    CHAT_SYSTEM_PROMPT.indexOf(HARNESS_FACTS),
  );
  expect(CHAT_SYSTEM_PROMPT.indexOf(HARNESS_FACTS)).toBeLessThan(
    CHAT_SYSTEM_PROMPT.indexOf(GUIDELINES),
  );
  expect(CHAT_SYSTEM_PROMPT.indexOf(GUIDELINES)).toBeLessThan(
    CHAT_SYSTEM_PROMPT.indexOf("Tools:"),
  );
  expect(CHAT_SYSTEM_PROMPT.indexOf("Tools:")).toBeLessThan(
    CHAT_SYSTEM_PROMPT.indexOf("Active context:"),
  );
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
  expect(CHAT_ROLE).toContain("You are Skywalker");
});

test("harness facts state only the non-derivable tool and safety rules", () => {
  expect(HARNESS_FACTS).toContain("write/edit");
  expect(HARNESS_FACTS).toContain("tiny/single-file/one-route");
  expect(HARNESS_FACTS).toContain("Spawn builder");
  expect(HARNESS_FACTS).not.toContain(
    "not mounted on the primary Skywalker session",
  );
  expect(HARNESS_FACTS).toContain("blocked");
  expect(HARNESS_FACTS).toContain("120s foreground timeout");
  expect(HARNESS_FACTS).toContain("no default timeout");
  expect(HARNESS_FACTS).toContain("find, rg, and grep -r");
  expect(HARNESS_FACTS).toMatch(/OOM the host/);
  expect(HARNESS_FACTS).toMatch(/Prefer the bounded grep\/glob tools/);
  expect(HARNESS_FACTS).toMatch(
    /not substitute another unbounded walk \(fd, ls -R, scripted os\.walk\)/,
  );
  expect(HARNESS_FACTS).not.toMatch(/Use grep, search_files, and list_dir\.$/m);
  expect(HARNESS_FACTS).toContain("operator approval");
  expect(HARNESS_FACTS).toContain("tool_search");
  expect(HARNESS_FACTS).toContain("plugins or integrations");
  expect(HARNESS_FACTS).toContain("slash-command steps");
  expect(HARNESS_FACTS).toContain(".corbits/MEMORY.md");
  expect(HARNESS_FACTS).toContain(
    "Attached images are native multimodal input",
  );
  expect(HARNESS_FACTS).toContain("parent tool.boundary");
  expect(HARNESS_FACTS).toContain("session-idle");
  expect(HARNESS_FACTS).not.toContain("Tool results already render richly");
});

test("harness facts gate tool-output URI reads on a named truncation notice", () => {
  expect(HARNESS_FACTS).toContain("Only read a tool-output:// URI");
  expect(HARNESS_FACTS).toMatch(/filesystem path/i);
  expect(HARNESS_FACTS).toMatch(/tool-output:\/\//);
  expect(HARNESS_FACTS).toContain("truncation notice on that result named one");
  expect(HARNESS_FACTS).toContain("do not re-read a complete inline result");
  expect(HARNESS_FACTS).not.toMatch(/prefer the URI/i);
  expect(HARNESS_FACTS).not.toMatch(/re-reading huge blobs/i);
});

test("read catalog summary gates tool-output URI reads on truncation", () => {
  const listed = buildAvailableTools(["read"]);
  expect(listed).toContain("read");
  expect(listed).toMatch(/tool-output:\/\//);
  expect(listed).toContain("truncation notice named one");
  expect(listed).toContain("cat/head/tail");
  expect(listed).not.toMatch(/prefer the URI/i);
});

test("harness facts name skill_search as a resident catalog tool", () => {
  expect(HARNESS_FACTS).toMatch(
    /advertised catalog \(including skill_search\) are resident/,
  );
  expect(HARNESS_FACTS).not.toContain("Only the core tools below are loaded");
  // skill_search is catalog-advertised and excluded from tool_search results.
  expect(HARNESS_FACTS).not.toMatch(/only the core tools[\s\S]*tool_search/i);
});

test("leaf harness facts advertise product write tools", () => {
  const facts = buildHarnessFacts({ subAgent: true, dynamicTools: false });
  expect(facts).toContain("write/edit");
  expect(facts).not.toContain("not mounted on the primary Skywalker session");
});

test("leaf harness facts state no-budget report completion behavior", () => {
  const facts = buildHarnessFacts({ subAgent: true, dynamicTools: false });
  expect(facts).toContain("There is no turn budget");
  expect(facts).toContain("one incomplete-report nudge");
  expect(facts).toContain("next tool-less reply still omits the envelope");
  expect(facts).toContain(
    "completion, cancellation, an opt-in deadline, or a stall",
  );
  expect(facts).not.toContain("Turn budget is real");
  expect(facts).not.toContain("wrap-up nudge may fire");
  expect(facts).not.toContain("as the budget ends");
});

test("guidelines cover response style, tool choice, ask vs proceed, and scope", () => {
  expect(GUIDELINES).toContain("Response style:");
  expect(GUIDELINES).toContain("Tool choice:");
  expect(GUIDELINES).toContain("Ask vs proceed:");
  expect(GUIDELINES).toContain("Scope and conventions:");
  expect(GUIDELINES).toContain("grep or glob");
  expect(GUIDELINES).toContain("ask_operator only when permission blocks you");
  expect(GUIDELINES).toContain("skill_search when choosing");
  expect(GUIDELINES).toContain(
    "use_skill style and philosophy when starting repo work",
  );
  expect(GUIDELINES).toContain("DIY tiny/single-file/one-route");
  expect(GUIDELINES).toContain("never shell-write (echo/heredoc/sed/rm)");
  expect(GUIDELINES).not.toContain("not mounted on Skywalker");
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
  expect(guidelines).toContain("One focused task per spawned worker");
  expect(guidelines).toContain("one lane per PR/path/ownership");
  expect(guidelines).toContain("keep it tight");
  // CL-7678: the default (TUI/nested) surface is unmounted — spawn then idle
  // on mailbox mail. The wait_agents collect path is exec-primary opt-in.
  expect(guidelines).toContain("mailbox mail arrives as inbound");
  expect(guidelines).not.toContain("wait_agents");
  expect(
    buildGuidelines({ sessionMode: "orchestrator", waitAgentsMounted: true }),
  ).toContain("wait_agents");
  expect(guidelines).toContain("required for implement/review");
  expect(guidelines).toContain("and their default directors");
  expect(guidelines).not.toContain("weaker");
});

test("primary chat prompt classifies fail-path successor vs interrupt resume vs operator-cancel wait", () => {
  const guidelines = buildGuidelines({ sessionMode: "orchestrator" });
  expect(guidelines).toContain("MAY spawn one successor with a changed brief");
  expect(guidelines).toContain("wait for the operator");
  expect(guidelines).toContain("do not auto-retry");
  expect(guidelines).toContain("Identical brief: refuse");
  expect(guidelines).toContain("resume_agent");
  expect(guidelines).toContain("still-live worker");
  expect(guidelines).not.toContain("interrupted-incomplete");
  expect(guidelines).not.toContain("start the next worker");
  expect(CHAT_SYSTEM_PROMPT).toContain("wait for the operator");
  expect(CHAT_SYSTEM_PROMPT).not.toContain("Then start the next worker");
  expect(CHAT_SYSTEM_PROMPT).not.toContain("if the job still needs doing");
});

test("primary guidelines advise against early-stop from compaction token fear", () => {
  expect(GUIDELINES).toContain("compacted automatically");
  expect(GUIDELINES).toContain("do not stop tasks early due to token fear");
  expect(GUIDELINES).toContain("manage_tasks and worker reports");
  // Leaf guidelines omit primary orchestration compaction guidance.
  expect(buildGuidelines({ subAgent: true })).not.toContain("token fear");
});

test("chat system prompt satisfies system prompt quality markers", () => {
  for (const marker of CHAT_PROMPT_QUALITY_MARKERS) {
    expect(CHAT_SYSTEM_PROMPT).toContain(marker);
  }
});

test("default session lists split fleet tools and search_agents", () => {
  const prompt = buildChatSystemPrompt(
    undefined,
    undefined,
    undefined,
    [],
    "orchestrator",
  );
  expect(prompt).not.toContain("- task:");
  expect(prompt).toContain("- spawn_agent:");
  // CL-7678: default (TUI/nested) session leaves wait_agents unmounted —
  // collection is mailbox mail. Exec-primary mounts it via waitAgentsMounted.
  expect(prompt).not.toContain("- wait_agents:");
  expect(prompt).toContain("- search_agents:");
  const mounted = buildChatSystemPrompt(
    undefined,
    undefined,
    undefined,
    [],
    "orchestrator",
    { languageServerAvailable: true, waitAgentsMounted: true },
  );
  expect(mounted).toContain("- wait_agents:");
  expect(mounted).toContain("collect with wait_agents");
});

test("chat prompt advertises core tools but never enumerates MCP integrations", () => {
  expect(CHAT_SYSTEM_PROMPT).toContain("- read:");
  expect(CHAT_SYSTEM_PROMPT).toContain("tool_search");
  expect(CHAT_SYSTEM_PROMPT).not.toContain("mcp__");
  // No static catalog dump — discovery is via tool_search, not a listed catalog.
  expect(CHAT_SYSTEM_PROMPT).not.toContain("Discoverable tools");
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
  expect(CHAT_SYSTEM_PROMPT).not.toContain("Skills (");
});

test("a SYSTEM.md base override replaces the static base but keeps tools and context", () => {
  const override = "You are a custom agent with project-specific rules.";
  const prompt = buildChatSystemPrompt(undefined, undefined, override);
  expect(prompt).toContain(override);
  expect(prompt).not.toContain(CHAT_ROLE);
  expect(prompt).toContain("## Session mode");
  expect(prompt).toContain("Orchestration:");
  // Tools and context still attach.
  expect(prompt).toContain("Tools:");
  expect(prompt).toContain("Active context:");
});

test("SYSTEM.md override still appends orchestrator harness rules", () => {
  const override =
    "You are a custom agent that mentions delegating to workers.";
  const prompt = buildChatSystemPrompt(undefined, undefined, override, []);
  expect(prompt).toContain(override);
  expect(prompt).toContain("## Session mode");
  expect(prompt).toContain("Orchestration:");
  expect(prompt).toContain("- spawn_agent:");
  // CL-7678: SYSTEM.md override keeps the unmounted default — no wait_agents ad.
  expect(prompt).not.toContain("- wait_agents:");
  expect(prompt).toContain("Mailbox mail arrives as inbound");
});

test("an empty base override falls back to the default base", () => {
  const prompt = buildChatSystemPrompt(undefined, undefined, "   ");
  expect(prompt).toContain(CHAT_ROLE);
  expect(prompt).toContain(HARNESS_FACTS);
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
  expect(context).toContain(
    "Current Date: 05/06/2026 (prompt cache survives for <=24hr)",
  );
  expect(context).toContain("/repo/root/.corbits/MEMORY.md");
  expect(context).toContain("Working Directory: /repo/root");
});

test("without an env, the chat prompt ends with the static active context", () => {
  expect(CHAT_SYSTEM_PROMPT.trim()).toMatch(/\.corbits\/MEMORY\.md/);
  expect(CHAT_SYSTEM_PROMPT).toMatch(
    /Current Date: \d{2}\/\d{2}\/\d{4} \(prompt cache survives for <=24hr\)/,
  );
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
  const custom = ["read", "write"];
  const listed = buildAvailableTools(custom);
  expect(listed).toContain("read");
  expect(listed).toContain("write");
  expect(listed).not.toContain("tool_search");
});

test("sub-agent prompt is the lean worker assembly: contract, names, env", () => {
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
  expect(prompt).toContain("Tools (names only):");
  // Lean worker: no harness-facts prose, no catalog summaries, no appendix,
  // no idle/poll/mailbox copy — the contract owns identity and escalation.
  expect(prompt).not.toContain("Change files with write_file/edit_file");
  expect(prompt).not.toContain("parent session's permission gate");
  expect(prompt).not.toContain("your full toolset");
  expect(prompt).not.toContain("## Corbits Code notes");
  expect(prompt).not.toContain("Harness facts:");
  expect(prompt).not.toContain("Guidelines:");
  expect(prompt).not.toContain("Prompt discipline:");
  expect(prompt).not.toContain("mailbox");
  expect(prompt).not.toContain("do not poll");
  expect(prompt).not.toContain("without asking for approval");
  expect(prompt).not.toContain("ask_operator");
  expect(prompt).not.toContain("you cannot ask the parent mid-run");
  expect(prompt).not.toContain("You are a sub-agent");
});

test("when ask_director is in toolNames, the worker prompt mentions ask_director", () => {
  const prompt = buildSubAgentSystemPrompt(
    undefined,
    {
      cwd: "/repo/root",
      platform: "Darwin 25.4.0",
      arch: "arm64",
      runtime: "Bun 1.2.0",
      date: new Date(2026, 5, 5),
      isGitRepo: false,
    },
    undefined,
    {
      toolNames: ["read_file", "ask_director"],
    },
  );
  expect(prompt).toContain("ask_director");
  expect(prompt).toContain("cannot reach the operator");
  expect(prompt).not.toContain("ask_operator");
});

test("sub-agent report contract does not claim the worker cannot receive answers", () => {
  const withAsk = buildSubAgentReportContract({ askDirector: true });
  expect(REPORT_CONTRACT).not.toContain("you cannot receive answers");
  expect(REPORT_CONTRACT).not.toContain("Do not ask the parent questions");
  expect(withAsk).not.toContain("you cannot receive answers");
  expect(withAsk).not.toContain("You cannot reach the operator");
});

test("sub-agent report contract treats Success criteria as completion gate", () => {
  expect(REPORT_CONTRACT).toContain("Success criteria");
  expect(REPORT_CONTRACT).toContain("done-definition");
  expect(REPORT_CONTRACT).toContain("stop calling tools");
  expect(REPORT_CONTRACT).toContain("Do not");
  expect(REPORT_CONTRACT).toContain("Intent / Do not");
});

// Pins the only real report-envelope mechanism (buildSubAgentReportContract's
// prompt text and hasReportEnvelope's completeness check) to stay in sync,
// since director packages no longer declare their own requiredSections
// (CL-6969: that field was inert and enforced nothing).
test("sub-agent report contract's headings satisfy hasReportEnvelope", () => {
  const headingsOnly = REPORT_CONTRACT.split("\n")
    .filter((line) => line.startsWith("## "))
    .join("\n");
  expect(hasReportEnvelope(headingsOnly)).toBe(true);
  expect(hasPlanFindings(headingsOnly)).toBe(false);
});

test("sub-agent prompt does not advertise tool_search (it gets names only)", () => {
  expect(SUBAGENT_SYSTEM_PROMPT).not.toContain("tool_search");
  expect(SUBAGENT_SYSTEM_PROMPT).toContain("Tools (names only):");
});

test("worker prompt does not advertise archive:///; primary chat prompt does", () => {
  expect(SUBAGENT_SYSTEM_PROMPT).not.toContain("archive:///");
  expect(CHAT_SYSTEM_PROMPT).toContain("archive:///");
  expect(buildAvailableTools(["read", "grep", "glob"])).not.toContain(
    "archive:///",
  );
  expect(
    buildAvailableTools(["read", "grep", "glob"], {
      advertiseArchive: true,
    }),
  ).toContain("archive:///");
});

// The lean worker assembly (CL-8212) is [contract, tool-names-only, env,
// director body, grok note]: no Corbits Code appendix. The director voice
// still lands verbatim after the harness sections, whether it came from a
// data-only markdown file or a JS plugin's `agentPlugin.agents[i].systemPromptRole`.
test("sub-agent prompt carries the director voice after the harness sections, with no appendix", () => {
  const role = "You are a JS-plugin scout. Map the call graph and report.";
  const prompt = buildSubAgentSystemPrompt([role]);
  expect(prompt).toContain(role);
  expect(prompt).not.toContain("## Corbits Code notes");
  // Director body leads nothing; harness sections come first.
  expect(prompt.indexOf("Tools (names only):")).toBeLessThan(
    prompt.indexOf(role),
  );
});

// Default sub-agents must NOT recurse — the appendix tells them to return a
// concrete report instead of spawning further agents. This is the rule that
// stops a fan-out of sub-agents each fanning out further.
test("default sub-agent prompt forbids recursion", () => {
  expect(SUBAGENT_SYSTEM_PROMPT).toContain(
    "Only the primary Corbits Code session (or a built-in orchestrator director) may call `spawn_agent`",
  );
  expect(SUBAGENT_SYSTEM_PROMPT).toContain("You are a worker");
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
  expect(SUBAGENT_SYSTEM_PROMPT).toContain("## Summary");
  expect(SUBAGENT_SYSTEM_PROMPT).toContain("## Findings");
  expect(SUBAGENT_SYSTEM_PROMPT).toContain("## Blockers");
  expect(SUBAGENT_SYSTEM_PROMPT).toContain("## Paths");
  expect(SUBAGENT_SYSTEM_PROMPT).toContain("Stick to the dispatch brief");
  expect(SUBAGENT_SYSTEM_PROMPT).toContain("manage_tasks checklist");
});

test("default sub-agent prompt omits Grok anti-thrash residual", () => {
  expect(SUBAGENT_SYSTEM_PROMPT).not.toContain(
    "Finish bias (xAI / Grok worker)",
  );
});

test("grokAntiThrash opts appends tiny finish-bias note as the last section", () => {
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
  // No appendix anymore: the grok note closes the prompt.
  expect(prompt.trimEnd().endsWith(note)).toBe(true);
});
