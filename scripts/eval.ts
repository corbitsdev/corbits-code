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

import { runSuite } from "../src/eval/harness.js";
import { formatReport } from "../src/eval/report.js";
import type { EvalTask, Variant } from "../src/eval/types.js";

/* eslint-disable no-console */

const TASKS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "eval", "tasks");

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

async function discoverTasks(filter?: string[]): Promise<EvalTask[]> {
  const entries = await readdir(TASKS_DIR);
  const tasks: EvalTask[] = [];
  for (const name of entries.sort()) {
    if (filter !== undefined && !filter.includes(name)) continue;
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
      "Usage: bun run eval --a <settingsA.json> --b <settingsB.json> [--tasks t1,t2] [--runs N]",
    );
    return 1;
  }

  const runs = Number(flag(args, "--runs") ?? "1");
  const taskFilter = flag(args, "--tasks")?.split(",").map((s) => s.trim());
  const tasks = await discoverTasks(taskFilter);
  if (tasks.length === 0) {
    console.error("No eval tasks found.");
    return 1;
  }

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

  console.error(
    `Running ${tasks.length} task(s) x 2 variants x ${runs} run(s): ${tasks.map((t) => t.name).join(", ")}`,
  );
  const { a, b } = await runSuite(tasks, variantA, variantB, runs);
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
