import type { Workflow } from "./types.js";

// Documentation workflow. A faithful, workflow-shaped port of the gaas:scribe
// skill: the skill is a system prompt with a series of targets, and this recipe
// turns each of its execution phases (0-6) into a discrete step. The user hands
// scribe some input (the target); scribe classifies it by abstraction level,
// interviews for the depth a transcription would miss, writes, keeps the docs
// consistent across levels, probes for gaps, and reports. No plan step, no
// approval gate — the only interaction is the inline question/ask_operator tool.
//
// Documents are organized by abstraction level, which drives routing:
//   PRODUCT        — what we build and why, for users (value, vision, goals)
//   ARCHITECTURE   — how the system is structured, technology-agnostic
//   IMPLEMENTATION — concrete tech choices (libraries, protocols, formats)
export const scribe = {
  name: "scribe",
  description: "Route input to PRODUCT/ARCHITECTURE/IMPLEMENTATION, interview for depth, write, and check consistency",
  autoAdvance: true,
  steps: [
    {
      id: "discover",
      label: "Discover docs",
      prompt:
        "Locate the project's documentation and build a model of what each file covers. " +
        "Find every doc-shaped file — README, docs/ (PRODUCT.md, ARCHITECTURE.md, " +
        "IMPLEMENTATION.md, and any others), AGENTS.md, CLAUDE.md — and read them all. " +
        "Classify each into an abstraction level: PRODUCT (what we build and why, for users), " +
        "ARCHITECTURE (how the system is structured, technology-agnostic), or IMPLEMENTATION " +
        "(concrete tech, protocols, libraries, config). Learn the project's vocabulary — " +
        "component names, key terms, and how existing features are described — so later " +
        "questions can be context-aware rather than generic. Do not edit anything yet.",
    },
    {
      id: "analyze",
      label: "Analyze input",
      prompt:
        "Take the user's input and classify which abstraction level(s) it belongs to. PRODUCT " +
        "signals: user needs, value, goals, 'users can'/'enables' language. ARCHITECTURE " +
        "signals: components, interactions, abstractions, technology-agnostic design. " +
        "IMPLEMENTATION signals: named technologies, protocols, wire formats, config. Use the " +
        "general heuristics plus the project-specific vocabulary from discovery. A single input " +
        "may span multiple levels — determine where each part belongs before writing anything.",
    },
    {
      id: "deepen",
      label: "Classify and deepen",
      skill: "gaas:scribe",
      prompt:
        "If the input is ambiguous or spans multiple levels, decompose it into distinct claims " +
        "using ask_operator. Do not just ask 'which document?' — present targeted questions with " +
        "context-aware options that reference similar features, existing limits, or patterns " +
        "from the docs. Resolve each claim to its target document so the write step can route " +
        "precisely. If the input is unambiguous, proceed without interviewing.",
    },
    {
      id: "write",
      label: "Write documentation",
      skill: "gaas:scribe",
      prompt:
        "Update the target document(s) with the classified input and any interview answers. " +
        "Place content where it belongs — extend an existing section before creating a new one " +
        "— and match the document's existing style, structure, and heading conventions. A single " +
        "input may update multiple documents across the three levels. Commit with a clear " +
        "message. Then assess whether the change is significant: a new component or section, a " +
        "contradiction of existing content, or a new top-level capability. Significant changes " +
        "trigger the consistency and gap steps that follow; minor ones can skip straight to the " +
        "report.",
    },
    {
      id: "consistency",
      label: "Cross-document consistency",
      skill: "gaas:scribe",
      prompt:
        "For each significant change, read the sibling documents and check whether the new " +
        "content implies entries that should exist there but don't — a new architecture " +
        "component with no product justification, a product capability with no how-it-works, an " +
        "implementation detail naming an undescribed component, a product goal with no " +
        "implementation approach. Where a gap exists, present it via ask_operator with " +
        "context-aware options, then update the sibling docs with the answers. If the change was " +
        "not significant, call submit_output to move on.",
    },
    {
      id: "gaps",
      label: "Detect gaps",
      skill: "gaas:scribe",
      prompt:
        "Scan the content just added for non-obvious gaps — failure modes, edge cases, limits, " +
        "permissions, and decisions stated without rationale. Use ask_operator to batch 2-4 " +
        "probing questions with context-aware options drawn from the existing docs. Update the " +
        "document with any answers. If the user declines three or more questions in a row, stop " +
        "pressing and move on. If the change was not significant, call submit_output to move on.",
    },
    {
      id: "report",
      label: "Report",
      prompt:
        "Confirm what changed and in which document(s), including any sibling-doc updates made " +
        "during the consistency check and any follow-ups the user declined. Keep it brief and " +
        "scannable.",
    },
  ],
} satisfies Workflow;
