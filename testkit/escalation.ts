// ask_director rejects a call without an escalation payload, so every
// scripted ask that should park carries this director_resolvable one.

export const DIRECTOR_RESOLVABLE_ESCALATION = {
  policyVersion: "1",
  classification: "director_resolvable",
  blockedOutcome: "cannot choose a target branch",
  unavailableDirectorPath: "the director has no branch map",
  permittedAlternatives: [
    {
      attempted: "check the branch list",
      result: "ambiguous",
      comparableConfidence: false,
    },
  ],
  minimumAddition: "a branch decision",
  declineConsequence: "implementation stays on the current branch",
} as const;
