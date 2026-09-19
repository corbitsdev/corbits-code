// Section registry for director prompt assembly (CL-8685 render-style experiment).
//
// Every director system prompt is a preamble plus `#`/`##` sections. The
// markdown arm renders sections as `## Title` (byte-identical to the shipped
// prompts — the markdown path returns `formatDirectorSystemPrompt` untouched);
// the xml arm renders those same sections as `<tag>body</tag>` with a tag
// from the fixed vocabulary below. Tags wrap whole sections only: inline
// prose, deeper sub-headings (`###` and below pass through verbatim), and the
// identity header (no `#` headings, so it stays preamble) are never tagged.
//
// Switch: `CORBITS_PROMPT_RENDER_STYLE=markdown|xml` (default `markdown`).
// The style resolves once per process and is cached, so the prompt-cache
// prefix cannot split mid-session. Tests reset the cache via
// `resetCachedPromptRenderStyleForTests`.

import type { DirectorPackage } from "./types.js";
import { formatDirectorSystemPrompt } from "./identity.js";

export type PromptRenderStyle = "markdown" | "xml";

/** Environment variable selecting the director-prompt render style. */
export const PROMPT_RENDER_STYLE_ENV_VAR = "CORBITS_PROMPT_RENDER_STYLE";

// Fixed tag vocabulary: one tag per `#`/`##` section title shipped in
// `src/agent/directors/*/package.ts`, normalized as `normalizeSectionTag`
// does. Titles outside this set (future packages) fall back to `section`.
export const PROMPT_SECTION_TAG_VOCABULARY = [
  "acknowledgment",
  "actually_overall_assessment",
  "anti_cascade_stall_dig_diagnose",
  "architecture_recommendations_all_terrible",
  "architecture_review_criteria",
  "blockers",
  "build_a_shared_glossary",
  "build_gate",
  "capabilities",
  "cargo_cult_programming_patterns_you_re_missing",
  "case_template",
  "common_neckbeard_phrases",
  "corbits_report_shape",
  "critical_reminder",
  "cross_document_analysis",
  "design_in_report_workflow",
  "document_discovery",
  "document_types",
  "documents_not_found",
  "effort_scaling_implementation_orchestration",
  "error_handling",
  "execution_steps",
  "fetch_urls_primary_mounted",
  "final_recommendation",
  "findings",
  "findings_route_to_follow_ups_never_silent_retunes",
  "guidelines",
  "harness_consume_do_not_build_a_second_one",
  "hold_the_line_on_scope",
  "how_you_work",
  "if_communication_answer_directly",
  "if_implementation_diy_when_tiny_spawn_when_substantial",
  "if_orchestration_coordinate",
  "implement_and_test",
  "implementation_review_criteria",
  "incomplete_document_set",
  "insufferable_details_x_found",
  "insufferable_mode_default",
  "key_suggestions_all_terrible",
  "maddening_nitpicks_x_found",
  "malformed_documents",
  "neckbeard_perspective",
  "neckbeard_review_project_name",
  "neckbeard_review_project_name_maximum_pedantry_edition",
  "non_negotiables",
  "operator_updates_mandatory_while_fleet_is_live",
  "out_of_lane",
  "parent_tools",
  "paths",
  "peak_neckbeard_issues_x_found",
  "plan",
  "prerequisites",
  "product_review_criteria",
  "protocol_in_order_no_shortcuts",
  "push_back_on_the_vision_itself_gently",
  "recommendation",
  "remember",
  "report",
  "report_contract",
  "report_shape",
  "report_when_dispatched_as_a_worker",
  "reporting_back",
  "request_shape_implementation_orchestration_communication",
  "review_framework",
  "review_modes",
  "riff_first",
  "risk_prioritization",
  "rules",
  "sec_0_document_discovery",
  "sec_1_analyze_and_classify_input",
  "sec_2_route_and_deepen",
  "sec_3_update_document",
  "sec_4_cross_document_consistency_significant_only",
  "sec_5_gap_detection_significant_only",
  "sec_6_report",
  "session_initialization",
  "spawn_graph",
  "spawn_handoff",
  "stay_in_lane",
  "step_1_load_prerequisites",
  "step_2_discover_documents_and_code_when_asked",
  "step_3_determine_review_mode",
  "step_4_read_all_targets",
  "step_5_perform_analysis",
  "step_6_synthesize_nitpicks",
  "step_7_report_nitpicks",
  "summary",
  "tools",
  "unbearable_issues_x_found",
  "utterly_unbearable_mode",
  "verify_after_ship",
  "voice",
  "what_to_measure",
  "what_you_do_not_do",
  "who_you_are",
  "workflow_scribe_core",
  "write_the_brief_when_it_is_ready",
  "your_role",
] as const;

const SECTION_TAG_SET: ReadonlySet<string> = new Set(
  PROMPT_SECTION_TAG_VOCABULARY,
);

/** Fallback tag for section titles outside the fixed vocabulary. */
export const FALLBACK_SECTION_TAG = "section";

export interface PromptSection {
  readonly title: string;
  readonly level: 1 | 2;
  readonly body: string;
}

export interface SplitPrompt {
  readonly preamble: string;
  readonly sections: readonly PromptSection[];
}

// Section boundary: an ATX `#` or `##` heading line. `###` and deeper are
// sub-section detail and never split — tags stay at section granularity.
const SECTION_HEADING_PATTERN = /^#{1,2} ([^\n]*)(?:\n|$)/gm;

/** Split prompt text into its preamble and `#`/`##` sections (offsets preserved). */
export function splitPromptSections(text: string): SplitPrompt {
  const matches = [...text.matchAll(SECTION_HEADING_PATTERN)];
  if (matches.length === 0) return { preamble: text, sections: [] };
  const first = matches[0];
  if (first === undefined || first.index === undefined)
    return { preamble: text, sections: [] };
  const preamble = text.slice(0, first.index);
  const sections = matches.map((match, i) => {
    const level = match[0].startsWith("## ") ? 2 : 1;
    const next = matches[i + 1];
    const bodyStart = (match.index ?? 0) + match[0].length;
    const bodyEnd = next?.index ?? text.length;
    return {
      title: (match[1] ?? "").trim(),
      level: level as 1 | 2,
      body: text.slice(bodyStart, bodyEnd),
    };
  });
  return { preamble, sections };
}

// Normalize a section title to its tag: lowercase, runs of non-alphanumerics
// to `_`, trimmed. Leading-digit results take a `sec_` prefix (bare digits
// are not valid XML tag starts); empty results take the fallback tag.
export function normalizeSectionTag(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (base === "") return FALLBACK_SECTION_TAG;
  return /^[0-9]/.test(base) ? `sec_${base}` : base;
}

/** Map a section title to its render tag: vocabulary hit, else the fallback. */
export function tagForSectionTitle(title: string): string {
  const tag = normalizeSectionTag(title);
  return SECTION_TAG_SET.has(tag) ? tag : FALLBACK_SECTION_TAG;
}

/**
 * Render prompt text in a style. Markdown returns the input untouched
 * (byte-identical by construction); xml wraps each section body in its tag.
 */
export function renderPromptBody(
  text: string,
  style: PromptRenderStyle,
): string {
  if (style === "markdown") return text;
  const { preamble, sections } = splitPromptSections(text);
  if (sections.length === 0) return text;
  const parts = preamble.trim() === "" ? [] : [preamble.trim()];
  for (const section of sections) {
    const tag = tagForSectionTitle(section.title);
    parts.push(`<${tag}>\n${section.body.trim()}\n</${tag}>`);
  }
  return parts.join("\n\n");
}

let cachedStyle: PromptRenderStyle | undefined;

/**
 * Resolve the render style once per process and cache it: the director prompt
 * prefix must not change mid-session or the prompt cache splits. Unknown and
 * absent values fall back to markdown.
 */
export function resolvePromptRenderStyle(
  env: Record<string, string | undefined> = process.env,
): PromptRenderStyle {
  if (cachedStyle === undefined) {
    const raw = env[PROMPT_RENDER_STYLE_ENV_VAR]?.trim().toLowerCase();
    cachedStyle = raw === "xml" ? "xml" : "markdown";
  }
  return cachedStyle;
}

/** Test-only reset for the once-per-session style cache. */
export function resetCachedPromptRenderStyleForTests(): void {
  cachedStyle = undefined;
}

/**
 * Render a director package system prompt (identity header + body) in a
 * style. The default arm resolves the once-per-session style; markdown is
 * `formatDirectorSystemPrompt` verbatim.
 */
export function renderDirectorSystemPrompt(
  pkg: DirectorPackage,
  style: PromptRenderStyle = resolvePromptRenderStyle(),
): string {
  const full = formatDirectorSystemPrompt(pkg);
  return style === "xml" ? renderPromptBody(full, "xml") : full;
}
