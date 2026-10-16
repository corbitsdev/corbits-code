/**
 * Shared card fragments. One definition per repeated sentence-shape.
 * Lane cards in ./cards.ts compose these; director modules do not
 * restate the prose. A fragment change is a fleet-wide prompt change.
 */

interface DispatchRouteRow {
  /** Task-verb phrase the coordinator routes on. */
  readonly task: string;
  /** Target director id. Drift test pins this against DIRECTOR_REGISTRY. */
  readonly lane: string;
  /** Parenthetical capability hint. */
  readonly hint: string;
  /** Extra sentence after the parenthetical, when the lane needs a boundary note. */
  readonly footer?: string;
}

/** Single route authority. The dispatch card's `# Route` section is generated from here. */
export const DISPATCH_ROUTE_ROWS: readonly DispatchRouteRow[] = [
  {
    task: "Question or codebase map",
    lane: "explorer",
    hint: "read-only search and mapping",
  },
  {
    task: "Requirements, architecture plan, or task breakdown",
    lane: "planner",
    hint: "PRD.md, SOLUTION_SCOPE.md, BUILD_PLAN.md",
  },
  {
    task: "Implementation, code changes, bug fixes, or unit tests",
    lane: "coder",
    hint: "minimal safe diffs, root-cause fixes, tests",
  },
  {
    task: "Code defect review, correctness verification, or temporary repro tests",
    lane: "reviewer",
    hint: "defect evidence, temp test verification",
  },
  {
    task: "UI/UX styling, design systems, design tokens, or DESIGN.md",
    lane: "designer",
    hint: "impeccable style laws, DESIGN.md ownership",
  },
  {
    task: "SVG graphics, diagrams, visual assets, or generative graphic prompts",
    lane: "artist",
    hint: "vector assets, Mermaid, image prompts",
  },
  {
    task: "Security auditing, trust boundaries, permissions, or secret guard review",
    lane: "warden",
    hint: "permission and trust review",
  },
  {
    task: "Product, architecture, or implementation documentation",
    lane: "shakespeare",
    hint: "PRODUCT, ARCHITECTURE, IMPLEMENTATION docs",
  },
  {
    task: "Model distribution benchmarks, latency probing, or prompt evaluation",
    lane: "prober",
    hint: "latency and behavior distributions",
  },
  {
    task: "Hands-on product exercise, e2e, occupancy, or actually using the CLI",
    lane: "qa-lead",
    hint: "behavior proof, pass/fail with commands",
    footer: "Distinct from coder unit tests and prober measurement.",
  },
];

/** `# Route` section body: one row per lane, generated from the table. */
export function dispatchRouteSection(): string {
  return DISPATCH_ROUTE_ROWS.map((row) =>
    row.footer === undefined
      ? `- ${row.task}: spawn ${row.lane} (${row.hint}).`
      : `- ${row.task}: spawn ${row.lane} (${row.hint}). ${row.footer}`,
  ).join("\n");
}

/** Report-envelope heading shape, single authority for every lane that re-states it. */
export const REPORT_ENVELOPE_SHAPE = "Summary / Findings / Blockers / Paths";

/** Identity banner shared by the learner/leaf director cards. */
export function identityLine(role: string): string {
  return `You are ${role}Director (${role}), a specialist in Corbits Code.`;
}

/**
 * Done-gate frame: fixed STOP condition plus the lane's own "do not" clause.
 * `met` names when the gate is satisfied; `donts` is the lane-specific refusal.
 */
export function doneGate(met: string, donts: string): string {
  return `DONE GATE: Stop when ${met} OR explicitly blocked under Blockers. ${donts}`;
}

/** Out-of-lane line: fixed frame, lane-specific items as one comma-separated phrase. */
export function outOfLane(items: string): string {
  return `OUT OF LANE: ${items}.`;
}
