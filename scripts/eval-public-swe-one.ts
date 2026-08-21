#!/usr/bin/env bun
/**
 * One-shot public SWE-bench smoke: Corbits as the agent on a single Lite instance.
 *
 * Intentionally narrow:
 *   - provider/model come from required --provider / --model CLI flags
 *   - host-side agent run (product exec path), not a full SWE Docker fleet
 *   - captures a git patch + trajectory report for later official eval
 *
 * Usage:
 *   bun scripts/eval-public-swe-one.ts --provider <name> --model <id>
 *   bun scripts/eval-public-swe-one.ts --instance psf__requests-3362 --provider <name> --model <id>
 *   bun scripts/eval-public-swe-one.ts --dry-run --provider <name> --model <id>
 *
 * Optional official grading (heavy; needs Docker resources):
 *   bun scripts/eval-public-swe-one.ts --instance … --provider <name> --model <id> --evaluate
 */

import { mkdir, writeFile, readFile, mkdtemp, rm, cp } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config/index.js";
import { runExec } from "../src/exec/runner.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_INSTANCE = "psf__requests-3362";
const DEFAULT_SUBSET = "princeton-nlp/SWE-bench_Lite";
const DEFAULT_SPLIT = "test";
const DEFAULT_AGENT_TIMEOUT_MS = 1_800_000; // 30m — real SWE tasks thrash

type CliOptions = {
  provider: string;
  model: string;
  instanceId: string;
  subset: string;
  split: string;
  agentTimeoutMs: number;
  evaluate: boolean;
  dryRun: boolean;
  outDir: string;
  help: boolean;
};

type SweInstance = {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  FAIL_TO_PASS: string;
  PASS_TO_PASS: string;
  version?: string;
  patch?: string;
  test_patch?: string;
};

function printHelp(): void {
  console.log(`Usage: bun scripts/eval-public-swe-one.ts --provider <name> --model <id> [options]

One public SWE-bench Lite instance via Corbits product exec.

Options:
  --instance <id>     SWE-bench instance_id (default: ${DEFAULT_INSTANCE})
  --provider <name>   Provider name (required except --help)
  --model <id>        Model id (required except --help)
  --subset <hf>       HF dataset id (default: ${DEFAULT_SUBSET})
  --split <name>      Dataset split (default: ${DEFAULT_SPLIT})
  --timeout-ms <n>    Agent wall-clock timeout (default: ${DEFAULT_AGENT_TIMEOUT_MS})
  --out <dir>         Results directory (default: evals/public/results/<run-id>)
  --evaluate          After the agent, attempt official SWE-bench Docker eval (heavy)
  --dry-run           Load instance + print plan; do not clone or run the agent
  -h, --help          Show this help
`);
}

export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    provider: "",
    model: "",
    instanceId: DEFAULT_INSTANCE,
    subset: DEFAULT_SUBSET,
    split: DEFAULT_SPLIT,
    agentTimeoutMs: DEFAULT_AGENT_TIMEOUT_MS,
    evaluate: false,
    dryRun: false,
    outDir: "",
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      return v;
    };
    switch (a) {
      case "-h":
      case "--help":
        opts.help = true;
        break;
      case "--instance":
        opts.instanceId = next();
        break;
      case "--provider":
        opts.provider = next();
        break;
      case "--model":
        opts.model = next();
        break;
      case "--subset":
        opts.subset = next();
        break;
      case "--split":
        opts.split = next();
        break;
      case "--timeout-ms":
        opts.agentTimeoutMs = Number(next());
        if (!Number.isFinite(opts.agentTimeoutMs) || opts.agentTimeoutMs <= 0) {
          throw new Error("--timeout-ms must be a positive number");
        }
        break;
      case "--out":
        opts.outDir = next();
        break;
      case "--evaluate":
        opts.evaluate = true;
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      default:
        throw new Error(`unknown arg: ${a}`);
    }
  }
  if (!opts.help) {
    if (!opts.provider && !opts.model) {
      throw new Error("missing required --provider and --model");
    }
    if (!opts.provider) {
      throw new Error("missing required --provider");
    }
    if (!opts.model) {
      throw new Error("missing required --model");
    }
  }
  return opts;
}

function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => {
      stdout += b.toString("utf8");
    });
    child.stderr.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
    });
    const timer =
      opts.timeoutMs !== undefined
        ? setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`timeout after ${opts.timeoutMs}ms: ${cmd} ${args.join(" ")}`));
          }, opts.timeoutMs)
        : null;
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function loadInstance(opts: CliOptions): Promise<SweInstance> {
  const py = `
import json, sys
from datasets import load_dataset
ds = load_dataset(${JSON.stringify(opts.subset)}, split=${JSON.stringify(opts.split)})
want = ${JSON.stringify(opts.instanceId)}
row = None
for r in ds:
    if r["instance_id"] == want:
        row = r
        break
if row is None:
    # allow numeric index
    try:
        idx = int(want)
        row = ds[idx]
    except Exception:
        pass
if row is None:
    sys.stderr.write(f"instance not found: {want}\\n")
    sys.exit(2)
keys = ["instance_id","repo","base_commit","problem_statement","FAIL_TO_PASS","PASS_TO_PASS","version","patch","test_patch"]
out = {}
for k in keys:
    if k in row:
        v = row[k]
        out[k] = v if isinstance(v, str) else json.dumps(v)
print(json.dumps(out))
`;
  const result = await run("uv", ["run", "--with", "datasets", "python", "-c", py], {
    timeoutMs: 180_000,
  });
  if (result.code !== 0) {
    throw new Error(`failed to load instance:\n${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout.trim()) as SweInstance;
}

async function prepareRepo(instance: SweInstance, workRoot: string): Promise<string> {
  const repoDir = join(workRoot, "repo");
  const url = `https://github.com/${instance.repo}.git`;
  console.log(`cloning ${url} …`);
  // Prefer a full clone so older base_commits resolve without partial-fetch pain.
  // requests/flask are small enough that this is cheap.
  const clone = await run("git", ["clone", url, repoDir], {
    timeoutMs: 600_000,
  });
  if (clone.code !== 0) {
    throw new Error(`git clone failed:\n${clone.stderr || clone.stdout}`);
  }
  const co = await run("git", ["checkout", "--force", instance.base_commit], {
    cwd: repoDir,
    timeoutMs: 120_000,
  });
  if (co.code !== 0) {
    // try fetch then checkout
    await run("git", ["fetch", "--depth", "1", "origin", instance.base_commit], {
      cwd: repoDir,
      timeoutMs: 300_000,
    });
    const co2 = await run("git", ["checkout", "--force", instance.base_commit], {
      cwd: repoDir,
      timeoutMs: 120_000,
    });
    if (co2.code !== 0) {
      throw new Error(`git checkout ${instance.base_commit} failed:\n${co2.stderr || co2.stdout}`);
    }
  }
  // Detach cleanly; agent may commit.
  await run("git", ["checkout", "--detach", "HEAD"], { cwd: repoDir });
  return repoDir;
}

function buildPrompt(instance: SweInstance): string {
  return [
    "You are fixing a real open-source GitHub issue (SWE-bench style).",
    "The repository is already checked out at the buggy base commit in the current working directory.",
    "",
    `Instance: ${instance.instance_id}`,
    `Repo: ${instance.repo}`,
    "",
    "## Issue",
    instance.problem_statement.trim(),
    "",
    "## Constraints",
    "- Implement a minimal correct fix for the issue.",
    "- Do not rewrite unrelated code.",
    "- Prefer the project's existing style and tests.",
    "- You may run the project's tests to verify.",
    "- Leave the fix as a normal git working-tree change (commit optional).",
    "- Do not change remotes or force-push.",
    "",
    "When done, stop. The harness will capture `git diff` against the base commit.",
  ].join("\n");
}

async function capturePatch(repoDir: string, baseCommit: string): Promise<string> {
  // Stage everything, then diff the index tree against the SWE base commit so
  // we include new files and agent commits without depending on HEAD movement.
  await run("git", ["add", "-A"], { cwd: repoDir });
  const tree = await run("git", ["write-tree"], { cwd: repoDir });
  if (tree.code !== 0) {
    throw new Error(`git write-tree failed:\n${tree.stderr || tree.stdout}`);
  }
  const treeSha = tree.stdout.trim();
  const diff = await run("git", ["diff", "--binary", baseCommit, treeSha], { cwd: repoDir });
  if (diff.code !== 0) {
    throw new Error(`git diff ${baseCommit}..${treeSha} failed:\n${diff.stderr || diff.stdout}`);
  }
  return diff.stdout;
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir =
    opts.outDir.length > 0
      ? resolve(opts.outDir)
      : join(REPO_ROOT, "evals/public/results", `${opts.instanceId}-${runId}`);
  await mkdir(outDir, { recursive: true });

  console.log("=== public SWE-bench one-shot ===");
  console.log(`provider/model: ${opts.provider} / ${opts.model}`);
  console.log(`instance: ${opts.instanceId}`);
  console.log(`subset: ${opts.subset} @ ${opts.split}`);
  console.log(`out: ${outDir}`);

  const instance = await loadInstance(opts);
  await writeFile(join(outDir, "instance.json"), JSON.stringify(instance, null, 2));
  console.log(`loaded ${instance.instance_id} (${instance.repo} @ ${instance.base_commit.slice(0, 12)})`);

  const prompt = buildPrompt(instance);
  await writeFile(join(outDir, "prompt.txt"), prompt);

  if (opts.dryRun) {
    console.log("dry-run: skipping clone + agent");
    console.log("--- prompt preview ---");
    console.log(prompt.slice(0, 800));
    console.log("---");
    process.exit(0);
  }

  const workRoot = await mkdtemp(join(tmpdir(), "corbits-swe-"));
  let repoDir: string | null = null;
  try {
    repoDir = await prepareRepo(instance, workRoot);
    console.log(`workdir: ${repoDir}`);

    const argv = [
      "exec",
      "--cwd",
      repoDir,
      "--provider",
      opts.provider,
      "--model",
      opts.model,
      "--dangerously-skip-permissions",
      "--force",
      prompt,
    ];

    const config = await loadConfig(argv, { allowUnconfigured: false });
    if (!config.configured) {
      throw new Error(
        `Provider not configured for --provider ${opts.provider} --model ${opts.model}`,
      );
    }
    const resolvedProvider = config.providerName;
    const resolvedModel = config.model;
    console.log(`resolved: ${resolvedProvider} / ${resolvedModel}`);
    if (resolvedProvider !== opts.provider || resolvedModel !== opts.model) {
      throw new Error(
        `provider/model mismatch: requested ${opts.provider}/${opts.model} ` +
          `but resolved ${resolvedProvider}/${resolvedModel}`,
      );
    }

    console.log("running Corbits agent …");
    const started = Date.now();
    const execResult = await withTimeout(
      runExec(config),
      opts.agentTimeoutMs,
      `agent (${instance.instance_id})`,
    );
    const durationMs = execResult.durationMs ?? Date.now() - started;
    console.log(
      `agent done exit=${execResult.exitCode} turns=${execResult.turnsUsed ?? "?"} ` +
        `tools=${execResult.toolCallCount ?? "?"} ${durationMs}ms`,
    );

    const patch = await capturePatch(repoDir, instance.base_commit);
    await writeFile(join(outDir, "prediction.patch"), patch);
    const pred = {
      [instance.instance_id]: {
        model_name_or_path: `corbits+${opts.provider}+${opts.model}`,
        model_patch: patch,
        instance_id: instance.instance_id,
      },
    };
    // SWE-bench preds.json is often a JSONL or dict; write both.
    await writeFile(join(outDir, "preds.json"), JSON.stringify(pred, null, 2));
    await writeFile(
      join(outDir, "preds.jsonl"),
      JSON.stringify({
        instance_id: instance.instance_id,
        model_name_or_path: `corbits+${opts.provider}+${opts.model}`,
        model_patch: patch,
      }) + "\n",
    );

    const report = {
      kind: "public-swe-one",
      instance_id: instance.instance_id,
      repo: instance.repo,
      base_commit: instance.base_commit,
      provider: opts.provider,
      model: opts.model,
      resolvedProvider,
      resolvedModel,
      agentExitCode: execResult.exitCode,
      turnsUsed: execResult.turnsUsed ?? null,
      toolCallCount: execResult.toolCallCount ?? null,
      durationMs,
      patchBytes: Buffer.byteLength(patch, "utf8"),
      patchEmpty: patch.trim().length === 0,
      outDir,
      evaluateRequested: opts.evaluate,
      note:
        "Patch captured from host-side Corbits run. Official resolved/not-resolved " +
        "requires SWE-bench Docker eval (--evaluate or external harness).",
    };
    await writeFile(join(outDir, "report.json"), JSON.stringify(report, null, 2));

    // Keep a copy of the final tree for debugging (may be large — skip if huge).
    console.log(`patch bytes: ${report.patchBytes}${report.patchEmpty ? " (EMPTY)" : ""}`);
    console.log(`report: ${join(outDir, "report.json")}`);

    if (opts.evaluate) {
      console.log(
        "\n--evaluate: official SWE-bench Docker grading is resource-heavy " +
          "(docs recommend ≥120GB disk, 16GB RAM; this Docker Desktop may be under-provisioned). " +
          "Not auto-invoked in v0 — run the SWE-bench harness against preds.jsonl manually.",
      );
      await writeFile(
        join(outDir, "EVALUATE.md"),
        [
          "# Official eval (manual)",
          "",
          "Predictions:",
          `- \`${join(outDir, "preds.jsonl")}\``,
          "",
          "Use the SWE-bench harness / mini-SWE-agent eval path against this prediction.",
          "Ensure Docker has enough CPU/RAM/disk first.",
          "",
        ].join("\n"),
      );
    }

    console.log("\n=== done ===");
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.patchEmpty || execResult.exitCode !== 0 ? 1 : 0);
  } finally {
    // Leave workRoot for forensics when agent fails? Clean to save disk.
    try {
      await rm(workRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  });
}
