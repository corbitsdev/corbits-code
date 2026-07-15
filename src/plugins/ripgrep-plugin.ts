import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, basename } from "node:path";
import type { ToolPlugin } from "@intx/tools-posix";

import {
  runBoundedGrep,
  runBoundedSearchFiles,
  type BoundedGrepArgs,
} from "./bounded-grep-fallback.js";

// A grep over a large tree with the pure-TypeScript walker enumerates the whole
// directory (node_modules, build output, the lot) before searching, which stalls
// the loop. ripgrep prunes ignored and skipped directories during its own walk,
// so it stays fast and never surfaces gitignored content. This plugin routes
// grep/search_files through `rg` when it is installed and falls back to the
// built-in posix tool otherwise, so behavior degrades gracefully on hosts
// without ripgrep.

const RG_TIMEOUT_MS = 10_000;
const DEFAULT_GREP_MAX = 500;
const DEFAULT_SEARCH_MAX = 1000;
// Cap collected stdout so a runaway pattern cannot OOM the process before the
// line-cap post-processing runs.
const MAX_OUTPUT_BYTES = 512_000;

type RgResult =
  | { kind: "output"; stdout: string }
  | { kind: "no-match" }
  | { kind: "unavailable" }
  | { kind: "error"; message: string };

function runRg(rgArgs: string[], cwd: string, signal: AbortSignal): Promise<RgResult> {
  return new Promise((resolve) => {
    const child = spawn("rg", rgArgs, {
      cwd,
      signal,
      // Process-group leader so timeout kills any grandchildren.
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: RgResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const killTree = (): void => {
      if (child.pid === undefined) return;
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // already dead
        }
      }
    };

    const timer = setTimeout(() => {
      killTree();
      finish({ kind: "error", message: `ripgrep timed out after ${RG_TIMEOUT_MS}ms — narrow path/glob` });
    }, RG_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      if (settled) return;
      stdout += String(chunk);
      if (stdout.length > MAX_OUTPUT_BYTES) {
        killTree();
        clearTimeout(timer);
        finish({
          kind: "error",
          message: `ripgrep output exceeded ${MAX_OUTPUT_BYTES} bytes — narrow path/glob or pattern`,
        });
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      // ENOENT means rg is not installed: signal a fallback, not an error.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") finish({ kind: "unavailable" });
      else finish({ kind: "error", message: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      if (code === 0) finish({ kind: "output", stdout });
      else if (code === 1) finish({ kind: "no-match" });
      else finish({ kind: "error", message: stderr.trim() || `ripgrep exited with code ${code}` });
    });
  });
}

function capLines(text: string, max: number): string {
  const lines = text.split("\n").filter((line) => line.length > 0);
  if (lines.length <= max) return lines.join("\n");
  return `${lines.slice(0, max).join("\n")}\n... (showing first ${max} of ${lines.length}+ lines; narrow path/glob)`;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// rg prints paths relative to its cwd when the search target is ".", matching
// the posix tool's directory-relative output. For a single file we search from
// its parent so the printed path stays short and relative.
function searchLocation(path: string, fallbackCwd: string): { cwd: string; target: string } {
  try {
    const info = statSync(path);
    if (info.isDirectory()) return { cwd: path, target: "." };
    return { cwd: dirname(path), target: basename(path) };
  } catch {
    return { cwd: fallbackCwd, target: path };
  }
}

export function ripgrepPlugin(cwd: string): ToolPlugin {
  return {
    middleware: (next) => async (call, signal) => {
      if (call.name === "grep") {
        const pattern = str(call.arguments.pattern);
        if (pattern === undefined) return next(call, signal);
        const path = str(call.arguments.path) ?? cwd;
        const context = num(call.arguments.context) ?? 0;
        const glob = str(call.arguments.glob);
        const maxResults = num(call.arguments.max_results) ?? DEFAULT_GREP_MAX;
        const { cwd: rgCwd, target } = searchLocation(path, cwd);

        const rgArgs = ["--line-number", "--no-heading", "--color", "never"];
        // Per-file match cap; total output is also byte- and line-capped below.
        rgArgs.push("--max-count", String(maxResults));
        if (context > 0) rgArgs.push("-C", String(context));
        if (glob !== undefined) rgArgs.push("-g", glob);
        rgArgs.push("--regexp", pattern, target);

        const result = await runRg(rgArgs, rgCwd, signal);
        if (result.kind === "unavailable") {
          try {
            const boundedArgs: BoundedGrepArgs = {
              pattern,
              path: target,
              context,
              max_results: maxResults,
            };
            if (glob !== undefined) boundedArgs.glob = glob;
            const content = await runBoundedGrep(boundedArgs, signal, rgCwd);
            return { callId: call.id, content: capLines(content, maxResults) };
          } catch (err) {
            return {
              callId: call.id,
              content: err instanceof Error ? err.message : String(err),
              isError: true,
            };
          }
        }
        if (result.kind === "no-match") {
          return { callId: call.id, content: `no matches for /${pattern}/` };
        }
        if (result.kind === "error") {
          return { callId: call.id, content: result.message, isError: true };
        }
        return { callId: call.id, content: capLines(result.stdout, maxResults) };
      }

      if (call.name === "search_files") {
        const pattern = str(call.arguments.pattern);
        if (pattern === undefined) return next(call, signal);
        const path = str(call.arguments.path) ?? cwd;
        const maxResults = num(call.arguments.max_results) ?? DEFAULT_SEARCH_MAX;
        const { cwd: rgCwd, target } = searchLocation(path, cwd);

        const result = await runRg(["--files", "-g", pattern, target], rgCwd, signal);
        if (result.kind === "unavailable") {
          try {
            const content = await runBoundedSearchFiles(
              { pattern, path: target, max_results: maxResults },
              signal,
              rgCwd,
            );
            return { callId: call.id, content: capLines(content, maxResults) };
          } catch (err) {
            return {
              callId: call.id,
              content: err instanceof Error ? err.message : String(err),
              isError: true,
            };
          }
        }
        if (result.kind === "no-match") {
          return { callId: call.id, content: `no files matching "${pattern}"` };
        }
        if (result.kind === "error") {
          return { callId: call.id, content: result.message, isError: true };
        }
        return { callId: call.id, content: capLines(result.stdout, maxResults) };
      }

      return next(call, signal);
    },
  };
}
