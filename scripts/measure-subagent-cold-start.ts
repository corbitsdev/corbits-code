#!/usr/bin/env bun

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import {
  createSkillSearchTool,
  workerSkillSearchDefinition,
} from "../src/agent/skill-search.js";
import {
  createUseSkillTool,
  workerUseSkillDefinition,
} from "../src/agent/use-skill.js";
import { discoverSkills } from "../src/extensions/skills.js";
import { assembleInferenceBase } from "../src/session/assemble-runtime.js";
import { createSessionStores } from "../src/session/optimized-context-store.js";

type Mode = "sequential" | "overlap";
type Measurement = {
  a: number;
  b: number;
  c: number;
  readiness: number;
};
type Sample = {
  sample: number;
  sequential: Measurement;
  overlap: Measurement;
  savings: number;
};

const DEFAULT_SAMPLES = 7;
const repositoryRoot = resolve(import.meta.dir, "..");
const skillDirs = [join(repositoryRoot, "plugins/corbits-skills")];
const allowedSkillNames = [
  "style",
  "philosophy",
  "native-runtime",
  "idiot-proof",
  "ponytail",
];
const attachedSkills = ["style", "philosophy"];

function parseSampleCount(args: readonly string[]): number {
  const raw = args
    .find((arg) => arg.startsWith("--samples="))
    ?.slice("--samples=".length);
  if (raw === undefined) return DEFAULT_SAMPLES;

  const samples = Number(raw);
  if (!Number.isSafeInteger(samples) || samples < 1) {
    throw new Error("--samples must be a positive integer");
  }
  return samples;
}

function elapsedSince(startedAt: number): number {
  return performance.now() - startedAt;
}

async function measureLeaf(mode: Mode, workdir: string): Promise<Measurement> {
  const readinessStartedAt = performance.now();

  let phaseStartedAt = performance.now();
  await assembleInferenceBase();
  const a = elapsedSince(phaseStartedAt);

  phaseStartedAt = performance.now();
  const skills = await discoverSkills(repositoryRoot, skillDirs);
  createSkillSearchTool({
    skills,
    allowedNames: allowedSkillNames,
    definition: workerSkillSearchDefinition,
  });
  createUseSkillTool(
    repositoryRoot,
    skillDirs,
    undefined,
    allowedSkillNames,
    workerUseSkillDefinition,
    attachedSkills,
  );
  const b = elapsedSince(phaseStartedAt);

  phaseStartedAt = performance.now();
  if (mode === "sequential") {
    await mkdir(workdir, { recursive: true });
    await createSessionStores(workdir);
  } else {
    const storesPromise = createSessionStores(workdir);
    void storesPromise.catch(() => undefined);
    await mkdir(workdir, { recursive: true });
    await storesPromise;
  }
  const c = elapsedSince(phaseStartedAt);

  return { a, b, c, readiness: elapsedSince(readinessStartedAt) };
}

function summary(values: readonly number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
      : (sorted[middle] ?? 0);
  return {
    median,
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
  };
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

function roundedSummary(values: readonly number[]) {
  const result = summary(values);
  return { median: round(result.median), mean: round(result.mean) };
}

async function main(): Promise<void> {
  const sampleCount = parseSampleCount(process.argv.slice(2));
  const root = await mkdtemp(join(tmpdir(), "corbits-subagent-cold-start-"));
  const samples: Sample[] = [];

  try {
    await measureLeaf("sequential", join(root, "warmup-sequential"));
    await measureLeaf("overlap", join(root, "warmup-overlap"));

    for (let sample = 1; sample <= sampleCount; sample++) {
      const modes: readonly Mode[] =
        sample % 2 === 1
          ? ["sequential", "overlap"]
          : ["overlap", "sequential"];
      const measurements = new Map<Mode, Measurement>();

      for (const mode of modes) {
        measurements.set(
          mode,
          await measureLeaf(mode, join(root, `${sample}-${mode}`)),
        );
      }

      const sequential = measurements.get("sequential");
      const overlap = measurements.get("overlap");
      if (sequential === undefined || overlap === undefined) {
        throw new Error("both benchmark modes must complete");
      }
      samples.push({
        sample,
        sequential,
        overlap,
        savings: sequential.readiness - overlap.readiness,
      });
    }

    const roundedSamples = samples.map((sample) => ({
      sample: sample.sample,
      sequential: Object.fromEntries(
        Object.entries(sample.sequential).map(([key, value]) => [
          key,
          round(value),
        ]),
      ),
      overlap: Object.fromEntries(
        Object.entries(sample.overlap).map(([key, value]) => [
          key,
          round(value),
        ]),
      ),
      savings: round(sample.savings),
    }));
    const sequentialReadiness = samples.map(
      (sample) => sample.sequential.readiness,
    );
    const overlapReadiness = samples.map((sample) => sample.overlap.readiness);
    const savings = samples.map((sample) => sample.savings);
    const overlapResidual = samples.map((sample) => sample.overlap.c);

    console.log(
      JSON.stringify(
        {
          samplesPerMode: sampleCount,
          warmupRunsPerMode: 1,
          units: "milliseconds",
          boundaries: {
            a: "assemble inference dependencies",
            b: "discover skills and construct skill tools",
            c: "make the workdir and initialize session stores",
            readiness: "a + b + c, immediately before agent construction",
            sequential: "await mkdir, then initialize stores",
            overlap: "start stores, await mkdir, then await stores",
            residual:
              "overlap c latency still visible on the leaf-readiness critical path",
          },
          samples: roundedSamples,
          summary: {
            beforeSequentialReadiness: roundedSummary(sequentialReadiness),
            afterOverlapReadiness: roundedSummary(overlapReadiness),
            pairedSavings: roundedSummary(savings),
            overlapResidual: roundedSummary(overlapResidual),
          },
        },
        null,
        2,
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await main();
