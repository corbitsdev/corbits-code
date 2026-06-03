import type { TokenUsage } from "@intx/types/runtime";

// A self-contained eval task: a directory holding a starting-state `repo/`, a
// `prompt.txt` (the instruction given to the agent), and a `verify.sh` objective
// grader (exit 0 = success, typically the task's own test suite).
export type EvalTask = {
  name: string;
  // Absolute path to the task directory containing repo/, prompt.txt, verify.sh.
  dir: string;
};

// A variant is what we A/B: not just a prompt, but the (prompt, provider, model)
// triple. Provider/model are injected per run via the CL-927 `--config` flag, so
// the same harness compares prompts, models, and providers with no new
// machinery. `priceOverride` lets a run report real cost for a model the pricing
// source does not know.
export type Variant = {
  name: string;
  // Settings file passed as --config so this variant runs against its own
  // provider/model definitions.
  configPath: string;
  // Optional selection within the config file.
  provider?: string;
  model?: string;
  // Optional prompt-variant identifier, threaded to the prompt builder once
  // CL-1220 makes the prompt selectable. Recorded on the result regardless.
  promptVariant?: string;
  // Per-1000-token price override for models the pricing source lacks.
  priceOverride?: PriceOverride;
};

export type PriceOverride = {
  inputPricePerToken: number;
  outputPricePerToken: number;
  cacheReadPricePerToken?: number;
};

// Cost is nullable on purpose: a model unknown to the pricing source reports
// `known: false` rather than a misleading $0.00.
export type Cost = {
  known: boolean;
  usd: number | null;
};

// The metrics one task run produces under one variant.
export type RunMetrics = {
  task: string;
  variant: string;
  turns: number;
  toolCalls: number;
  toolCallsByType: Record<string, number>;
  tokens: TokenUsage;
  totalTokens: number;
  cost: Cost;
  wallClockMs: number;
  passed: boolean;
};
