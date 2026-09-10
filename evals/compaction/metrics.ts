import { type } from "arktype";

export const Evidence = type({
  id: "string",
  source: "string",
  value: "string",
});
export type Evidence = typeof Evidence.infer;

export const Measurement = type.or(
  { status: "'unavailable'", reason: "string" },
  {
    status: "'reported' | 'estimated' | 'synthetic'",
    value: "number >= 0",
    unit: "string",
  },
);
export type Measurement = typeof Measurement.infer;

export const Fold = type({
  requestedAtCall: "number.integer >= 1",
  beforeHash: "string",
  afterHash: "string",
  beforeTurns: "number.integer >= 0",
  afterTurns: "number.integer >= 0",
  persisted: "boolean",
  continuedAtCall: "number.integer >= 1 | null",
});
export type Fold = typeof Fold.infer;

export function qualifyingFold(fold: Fold): boolean {
  return (
    fold.persisted &&
    fold.beforeHash !== fold.afterHash &&
    fold.afterTurns < fold.beforeTurns &&
    fold.continuedAtCall !== null &&
    fold.continuedAtCall > fold.requestedAtCall
  );
}

export const Work = type({
  name: "string",
  argumentsKey: "string",
  outcome: "'success' | 'failure' | 'denied'",
  purpose: "'action' | 'verification'",
});
export type Work = typeof Work.infer;

export function repeatedWork(trace: readonly Work[]) {
  const seen = new Set<string>();
  const failures = new Set<string>();
  let repeatedReads = 0;
  let repeatedSearches = 0;
  let repeatedFailedAttempts = 0;
  let duplicatedEdits = 0;
  let verificationCalls = 0;
  for (const work of trace) {
    const key = JSON.stringify([work.name, work.argumentsKey]);
    if (work.purpose === "verification") {
      verificationCalls++;
      continue;
    }
    if (seen.has(key)) {
      if (work.name === "read_file") repeatedReads++;
      if (["grep", "search_files", "web_search"].includes(work.name))
        repeatedSearches++;
      if (["write_file", "edit_file", "apply_patch"].includes(work.name))
        duplicatedEdits++;
    }
    if (failures.has(key)) repeatedFailedAttempts++;
    seen.add(key);
    if (work.outcome === "failure") failures.add(key);
  }
  return {
    repeatedReads,
    repeatedSearches,
    repeatedFailedAttempts,
    duplicatedEdits,
    verificationCalls,
  };
}

export function grade(args: {
  expected: readonly Evidence[];
  recovered: readonly Evidence[];
  expectedArtifact: string;
  artifact: string | null;
  folds: readonly Fold[];
  trace: readonly Work[];
}) {
  const recoveredFacts = args.expected.filter((fact) =>
    args.recovered.some(
      (answer) =>
        answer.id === fact.id &&
        answer.source === fact.source &&
        answer.value === fact.value,
    ),
  ).length;
  const work = repeatedWork(args.trace);
  const persistedFolds = args.folds.filter(qualifyingFold).length;
  const completion = args.artifact === args.expectedArtifact;
  const factualRecovery = recoveredFacts === args.expected.length;
  const repeatedActions =
    work.repeatedReads +
    work.repeatedSearches +
    work.repeatedFailedAttempts +
    work.duplicatedEdits;
  return {
    completion,
    factualRecovery,
    recoveredFacts,
    requiredFacts: args.expected.length,
    persistedFolds,
    qualifying: persistedFolds >= 3,
    ...work,
    passed:
      completion &&
      factualRecovery &&
      persistedFolds >= 3 &&
      repeatedActions === 0,
  };
}

/** The responder receives only inference-visible text, never grader expectations. */
export function recoverEvidence(context: string): Evidence[] {
  const facts = new Map<string, Evidence>();
  for (const match of context.matchAll(
    /\[\[evidence:([^|\]\n]+)\|([^|\]\n]+)\|([^\]\n]+)\]\]/g,
  )) {
    const [, id, source, value] = match;
    if (id !== undefined && source !== undefined && value !== undefined) {
      facts.set(id, { id, source, value });
    }
  }
  return [...facts.values()];
}
