#!/usr/bin/env bun
// Entry point for the agent eval harness: `bun run eval --a <settingsA.json>
// --b <settingsB.json> [--tasks t1,t2] [--runs N]`.
//
// Each --config settings file (CL-927 format) defines the provider/model for
// that variant. Real scored runs need real provider credentials in those files;
// this is an internal measurement tool, not a product feature.
import { readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { runSuite } from "../eval/lib/harness.js";
import { formatReport } from "../eval/lib/report.js";
import { resolveJudge, type JudgeConfig } from "../eval/lib/judge.js";
import type { EvalTask, Variant } from "../eval/lib/types.js";

/* eslint-disable no-console */

const TASKS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "eval", "tasks");

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

async function discoverTasks(): Promise<EvalTask[]> {
  const entries = await readdir(TASKS_DIR);
  const tasks: EvalTask[] = [];
  for (const name of entries.sort()) {
    const dir = join(TASKS_DIR, name);
    if ((await stat(dir)).isDirectory()) tasks.push({ name, dir });
  }
  return tasks;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const aPath = flag(args, "--a");
  const bPath = flag(args, "--b");
  if (aPath === undefined || bPath === undefined) {
    console.error(
      "Usage: bun run eval --a <settingsA.json> --b <settingsB.json> [--tasks t1,t2] [--runs N]\n" +
        "       [--judge <settings.json> [--judge-provider <name>] [--judge-model <id>]] [--flat-fee]",
    );
    return 1;
  }

  const runs = Number(flag(args, "--runs") ?? "1");
  if (!Number.isInteger(runs) || runs < 1) {
    console.error(`--runs must be a positive integer (got "${flag(args, "--runs")}")`);
    return 1;
  }

  const all = await discoverTasks();
  if (all.length === 0) {
    console.error(`No eval tasks found under ${TASKS_DIR}.`);
    return 1;
  }
  const taskFilter = flag(args, "--tasks")?.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  let tasks = all;
  if (taskFilter !== undefined) {
    const known = new Set(all.map((t) => t.name));
    const unknown = taskFilter.filter((name) => !known.has(name));
    if (unknown.length > 0) {
      console.error(
        `Unknown task(s): ${unknown.join(", ")}. Available: ${all.map((t) => t.name).join(", ")}`,
      );
      return 1;
    }
    tasks = all.filter((t) => taskFilter.includes(t.name));
  }

  const flatFee = hasFlag(args, "--flat-fee");
  const variantA: Variant = { name: "A", configPath: resolve(aPath) };
  const variantB: Variant = { name: "B", configPath: resolve(bPath) };
  const providerA = flag(args, "--provider-a");
  const modelA = flag(args, "--model-a");
  const providerB = flag(args, "--provider-b");
  const modelB = flag(args, "--model-b");
  if (providerA !== undefined) variantA.provider = providerA;
  if (modelA !== undefined) variantA.model = modelA;
  if (providerB !== undefined) variantB.provider = providerB;
  if (modelB !== undefined) variantB.model = modelB;
  if (flatFee) {
    variantA.flatFee = true;
    variantB.flatFee = true;
  }

  // Optional LLM judge: resolved from its own settings file (credentials stay in
  // the file, same secure mechanism as the variants).
  let judgeCfg: JudgeConfig | null = null;
  const judgePath = flag(args, "--judge");
  if (judgePath !== undefined) {
    judgeCfg = await resolveJudge(
      resolve(judgePath),
      flag(args, "--judge-provider"),
      flag(args, "--judge-model"),
    );
  }

  console.error(
    `Running ${tasks.length} task(s) x 2 variants x ${runs} run(s)${judgeCfg ? " with LLM judge" : ""}: ${tasks.map((t) => t.name).join(", ")}`,
  );
  const { a, b } = await runSuite(tasks, variantA, variantB, runs, judgeCfg);
  console.log(formatReport(a, b, variantA.name, variantB.name));
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
/* eslint-enable no-console */
