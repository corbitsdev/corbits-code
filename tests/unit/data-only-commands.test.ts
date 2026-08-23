import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CommandContext } from "../../src/tui/commands/registry.js";
import { loadDataOnlyCommands } from "../../src/plugins/data-only-commands.js";
import { loadDataOnlyPlugin } from "../../src/plugins/data-only.js";

let root: string;

async function makePlugin(layout: Record<string, string>): Promise<string> {
  const dir = join(root, `p-${Math.random().toString(36).slice(2)}`);
  for (const [relPath, content] of Object.entries(layout)) {
    const fullPath = join(dir, relPath);
    await mkdir(join(fullPath, ".."), { recursive: true });
    await writeFile(fullPath, content, "utf8");
  }
  return dir;
}

const ctx: CommandContext = { signalClear: () => {} };

beforeEach(async () => {
  root = await mkdtemp();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function mkdtemp(): Promise<string> {
  const dir = join(tmpdir(), `ic-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

describe("loadDataOnlyCommands", () => {
  test("returns null when there is no commands directory", async () => {
    const dir = await makePlugin({ "README.md": "hi" });
    expect(await loadDataOnlyCommands(dir)).toBeNull();
  });

  test("returns null when every command name is invalid", async () => {
    const dir = await makePlugin({ "commands/BadName.md": "body" });
    expect(await loadDataOnlyCommands(dir)).toBeNull();
  });

  test("synthesizes a flat command from a markdown file", async () => {
    const dir = await makePlugin({
      "commands/greet.md": "---\ndescription: Greet someone\n---\nHello $ARGUMENTS!",
    });
    const plugin = await loadDataOnlyCommands(dir);
    expect(plugin).not.toBeNull();
    const cmd = plugin!.commandPlugin.commands.find((c) => c.name === "greet");
    expect(cmd).toBeDefined();
    expect(cmd!.description).toBe("Greet someone");
    const res = cmd!.handler("world", ctx);
    expect(res).toEqual({ type: "send", text: "Hello world!" });
  });

  test("copies argument-hint from command frontmatter", async () => {
    const dir = await makePlugin({
      "commands/greet.md":
        "---\ndescription: Greet someone\nargument-hint: <name>\n---\nHello $ARGUMENTS!",
    });
    const cmd = (await loadDataOnlyCommands(dir))!.commandPlugin.commands.find(
      (c) => c.name === "greet",
    )!;
    expect(cmd.argumentHint).toBe("<name>");
  });

  test("falls back to the first body line when frontmatter omits a description", async () => {
    const dir = await makePlugin({
      "commands/plain.md": "Summarize the working tree.\nMore detail.",
    });
    const cmd = (await loadDataOnlyCommands(dir))!.commandPlugin.commands[0]!;
    expect(cmd.description).toBe("Summarize the working tree.");
  });

  test("drops $ARGUMENTS when the command is invoked with no args", async () => {
    const dir = await makePlugin({ "commands/echo.md": "Body [$ARGUMENTS] end" });
    const cmd = (await loadDataOnlyCommands(dir))!.commandPlugin.commands[0]!;
    expect(cmd.handler("", ctx)).toEqual({ type: "send", text: "Body [] end" });
  });

  test("builds a namespaced command from a subdirectory", async () => {
    const dir = await makePlugin({
      "commands/repo/init.md": "---\ndescription: init a repo\n---\nInit $ARGUMENTS",
      "commands/repo/scan.md": "---\ndescription: scan a repo\n---\nScan it",
    });
    const cmd = (await loadDataOnlyCommands(dir))!.commandPlugin.commands.find(
      (c) => c.name === "repo",
    );
    expect(cmd).toBeDefined();
    expect(cmd!.subcommands?.map((s) => s.name).sort()).toEqual(["init", "scan"]);

    const ok = cmd!.handler("init acme", ctx);
    expect(ok).toEqual({ type: "send", text: "Init acme" });

    const missing = cmd!.handler("nope", ctx);
    expect(missing).toEqual({
      type: "message",
      text: 'Unknown repo subcommand "nope". Available: init, scan',
    });
  });

  test("accepts the OpenCode command/ (singular) root", async () => {
    const dir = await makePlugin({ "command/greet.md": "Hi $ARGUMENTS" });
    const plugin = await loadDataOnlyCommands(dir);
    expect(plugin).not.toBeNull();
    expect(plugin!.commandPlugin.commands[0]!.name).toBe("greet");
  });
});

describe("loadDataOnlyPlugin command routing", () => {
  test("a commands-only directory infers kind command", async () => {
    const dir = await makePlugin({ "commands/greet.md": "Hi $ARGUMENTS" });
    const plugin = await loadDataOnlyPlugin(dir);
    expect(plugin).not.toBeNull();
    expect(plugin!.manifest.kind).toBe("command");
    expect(plugin!.manifest.id).toBe(dir.split("/").pop()!);
    expect(plugin!.commandPlugin).toBeDefined();
    expect(plugin!.agentPlugin).toBeUndefined();
  });

  test("an explicit manifest.json is authoritative", async () => {
    const dir = await makePlugin({
      "manifest.json": JSON.stringify({
        id: "my-cmds",
        name: "My Commands",
        kind: "command",
        description: "from manifest",
      }),
      "commands/greet.md": "Hi",
    });
    const plugin = await loadDataOnlyPlugin(dir);
    expect(plugin!.manifest).toEqual({
      id: "my-cmds",
      name: "My Commands",
      kind: "command",
      description: "from manifest",
    });
  });

  test("returns null when the directory has neither agents nor commands", async () => {
    const dir = await makePlugin({
      "manifest.json": JSON.stringify({ id: "x", name: "x", kind: "command" }),
    });
    expect(await loadDataOnlyPlugin(dir)).toBeNull();
  });

  test("agents and commands together (no manifest) infer kind agent so profiles wire", async () => {
    const dir = await makePlugin({
      "agents/karen.md": "You orchestrate.",
      "commands/greet.md": "Hi $ARGUMENTS",
    });
    const plugin = await loadDataOnlyPlugin(dir);
    expect(plugin!.manifest.kind).toBe("agent");
    // Both exports are attached; commands wire as an added surface via the
    // agent-kind allowance in isEnabledCommandPlugin.
    expect(plugin!.agentPlugin).toBeDefined();
    expect(plugin!.commandPlugin).toBeDefined();
  });
});
