import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  argumentHintFromFrontmatter,
  type CommandDefinition,
  type CommandPlugin,
  type CommandResult,
  type SubcommandDefinition,
} from "../tui/commands/registry.js";
import { splitFrontmatter } from "./frontmatter.js";

// A data-only command plugin declares its slash commands as markdown files, the
// same convention Claude Code (`.claude/commands/`), OpenCode
// (`.opencode/command/`), and Codex use. The filename stem is the command name;
// optional YAML frontmatter carries description + argument-hint; the body is the
// prompt sent to the agent when the command runs.
//
// Two layouts are recognized:
//   commands/<name>.md        ->  /<name> <args>      (flat command)
//   commands/<ns>/<sub>.md    ->  /<ns> <sub> <args>  (namespaced command)
//
// A namespaced command exposes one subcommand per file in its directory, so
// `commands/linear/scope.md` + `commands/linear/build.md` yields `/linear scope`
// and `/linear build` from a single `/linear` command. `$ARGUMENTS` in a body is
// replaced with the args passed to that command level (all args for a flat
// command; the args after the subcommand for a namespaced one).

const COMMAND_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

interface LoadedBody { description: string; body: string; argumentHint?: string }

// Replace `$ARGUMENTS` (Claude Code / OpenCode convention) with the args string.
function interpolate(body: string, args: string): string {
  return args.length > 0 ? body.replaceAll("$ARGUMENTS", args) : body.replaceAll("$ARGUMENTS", "");
}

function firstLineDescription(body: string, fallback: string): string {
  const line = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (line === undefined) return fallback;
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

async function loadBody(filePath: string, name: string): Promise<LoadedBody | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return null;
  }
  const { frontmatter, body } = splitFrontmatter(raw);
  if (frontmatter === null) return null;
  const description =
    typeof frontmatter.description === "string" && frontmatter.description.trim().length > 0
      ? frontmatter.description.trim()
      : firstLineDescription(body, name);
  const argumentHint = argumentHintFromFrontmatter(frontmatter);
  const loaded: LoadedBody = { description, body };
  if (argumentHint !== undefined) loaded.argumentHint = argumentHint;
  return loaded;
}

function buildFlatCommand(name: string, loaded: LoadedBody): CommandDefinition {
  const def: CommandDefinition = {
    name,
    description: loaded.description,
    handler: (args: string): CommandResult => ({
      type: "send",
      text: interpolate(loaded.body, args),
    }),
  };
  if (loaded.argumentHint !== undefined) def.argumentHint = loaded.argumentHint;
  return def;
}

function buildNamespacedCommand(ns: string, subs: Map<string, LoadedBody>): CommandDefinition {
  const subcommands: SubcommandDefinition[] = [...subs.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, loaded]) => ({ name, description: loaded.description }));
  const available = [...subs.keys()].sort().join(", ");
  return {
    name: ns,
    description: `${ns} commands: ${available}`,
    subcommands,
    handler: (args: string): CommandResult => {
      const parts = args.trim().split(/\s+/);
      const sub = parts[0] ?? "";
      const rest = parts.slice(1).join(" ");
      const entry = subs.get(sub);
      if (entry === undefined) {
        return {
          type: "message",
          text: `Unknown ${ns} subcommand "${sub}". Available: ${available}`,
        };
      }
      return { type: "send", text: interpolate(entry.body, rest) };
    },
  };
}

// Read `commands/*.md` (and one level of `commands/<ns>/*.md`) from a plugin
// directory. Returns null when the directory has no commands root or no usable
// markdown files, so the caller can fall through to other data-only kinds.
export async function loadDataOnlyCommands(
  pluginDir: string,
  opts: { onWarning?: (msg: string) => void } = {},
): Promise<{ commandPlugin: CommandPlugin } | null> {
  const warn = opts.onWarning ?? (() => {});

  // Accept both `commands/` (Claude Code) and `command/` (OpenCode) roots.
  let root: string | null = null;
  for (const candidate of ["commands", "command"]) {
    const dir = join(pluginDir, candidate);
    try {
      await readdir(dir);
      root = dir;
      break;
    } catch {
      // not present, try next
    }
  }
  if (root === null) return null;

  const flat = new Map<string, LoadedBody>();
  const namespaces = new Map<string, Map<string, LoadedBody>>();

  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const ns = entry.name;
      if (!COMMAND_NAME_PATTERN.test(ns)) {
        warn(`skipping commands/${ns}/: invalid command name`);
        continue;
      }
      let subEntries: import("node:fs").Dirent[];
      try {
        subEntries = await readdir(join(root, ns), { withFileTypes: true });
      } catch {
        continue;
      }
      const subs = new Map<string, LoadedBody>();
      for (const sub of subEntries) {
        if (!sub.isFile() || !/\.md$/i.test(sub.name)) continue;
        const stem = sub.name.replace(/\.md$/i, "");
        if (!COMMAND_NAME_PATTERN.test(stem)) {
          warn(`skipping commands/${ns}/${sub.name}: invalid command name`);
          continue;
        }
        const loaded = await loadBody(join(root, ns, sub.name), stem);
        if (loaded === null) {
          warn(`skipping commands/${ns}/${sub.name}: malformed frontmatter`);
          continue;
        }
        subs.set(stem, loaded);
      }
      if (subs.size > 0) namespaces.set(ns, subs);
    } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
      const stem = entry.name.replace(/\.md$/i, "");
      if (!COMMAND_NAME_PATTERN.test(stem)) {
        warn(`skipping commands/${entry.name}: invalid command name`);
        continue;
      }
      const loaded = await loadBody(join(root, entry.name), stem);
      if (loaded === null) {
        warn(`skipping commands/${entry.name}: malformed frontmatter`);
        continue;
      }
      flat.set(stem, loaded);
    }
  }

  if (flat.size === 0 && namespaces.size === 0) return null;

  const commands: CommandDefinition[] = [];
  for (const [name, loaded] of [...flat.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    // A namespace directory and a same-named flat file collide on the command
    // name; the richer namespaced command wins so its subcommands are visible.
    if (namespaces.has(name)) continue;
    commands.push(buildFlatCommand(name, loaded));
  }
  for (const [ns, subs] of [...namespaces.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    commands.push(buildNamespacedCommand(ns, subs));
  }

  return { commandPlugin: { commands } };
}
