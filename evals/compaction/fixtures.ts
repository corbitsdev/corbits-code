import type { Evidence } from "./metrics.js";

export const BASELINE = {
  productRevision: "6ea596945657f3a0d3af5bfb0277b94af19e1589",
  packageVersion: "0.3.18",
  protocol: "primary-component-mechanics-v1",
  model: "claude-integration",
  provider: "anthropic",
  folds: 3,
  growthTurnsPerFold: 10,
  syntheticLowInput: 100,
  syntheticTriggerInput: 200000,
  outputTokens: 1,
  keepRecentTurns: 6,
  summaryMaxChars: 4000,
  wallTimeoutMs: 30000,
} as const;

export const REQUIRED_EVIDENCE: readonly Evidence[] = [
  { id: "constraint", source: "operator:initial", value: "no-schema-change" },
  { id: "decision", source: "operator:correction", value: "west-not-east" },
  { id: "failure", source: "command:diagnose", value: "unsupported-format-7" },
  {
    id: "decisive",
    source: "file:diagnostic.log:middle",
    value: "route-cobalt",
  },
];

export function evidenceText(facts: readonly Evidence[]): string {
  return facts
    .map((fact) => `[[evidence:${fact.id}|${fact.source}|${fact.value}]]`)
    .join("\n");
}

export const INITIAL =
  "Audit the deployment. Preserve this constraint: " +
  evidenceText(REQUIRED_EVIDENCE.slice(0, 1));
export const CORRECTION =
  "Correction: target west instead of east. " +
  evidenceText(REQUIRED_EVIDENCE.slice(1, 2));
export const FAILED_OUTPUT =
  "Diagnostic preamble.\n".repeat(250) +
  evidenceText(REQUIRED_EVIDENCE.slice(2, 3));
export const OVERSIZED_OUTPUT =
  "Unrelated diagnostic row.\n".repeat(1500) +
  evidenceText(REQUIRED_EVIDENCE.slice(3)) +
  "\nUnrelated trailing row.".repeat(1500);
