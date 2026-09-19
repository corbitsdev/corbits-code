import { afterEach, describe, expect, test } from "bun:test";

import { DIRECTOR_REGISTRY } from "./registry.js";
import { DIRECTOR_IDS } from "./types.js";
import { formatDirectorSystemPrompt } from "./identity.js";
import {
  FALLBACK_SECTION_TAG,
  normalizeSectionTag,
  PROMPT_RENDER_STYLE_ENV_VAR,
  PROMPT_SECTION_TAG_VOCABULARY,
  renderDirectorSystemPrompt,
  renderPromptBody,
  resetCachedPromptRenderStyleForTests,
  resolvePromptRenderStyle,
  splitPromptSections,
  tagForSectionTitle,
} from "./prompt-sections.js";

const savedEnv = process.env[PROMPT_RENDER_STYLE_ENV_VAR];

afterEach(() => {
  // "" resolves like unset (markdown); `delete` on a computed key is
  // lint-banned, so an empty assignment stands in for a missing var.
  process.env[PROMPT_RENDER_STYLE_ENV_VAR] = savedEnv ?? "";
  resetCachedPromptRenderStyleForTests();
});

function tagNames(xml: string): string[] {
  return [...xml.matchAll(/<([a-z][a-z0-9_]*)>/g)].map((m) => m[1] ?? "");
}

describe("director prompt render style", () => {
  test("default arm is byte-identical to formatDirectorSystemPrompt for every director", () => {
    process.env[PROMPT_RENDER_STYLE_ENV_VAR] = "";
    resetCachedPromptRenderStyleForTests();
    for (const id of DIRECTOR_IDS) {
      const pkg = DIRECTOR_REGISTRY[id];
      expect(renderDirectorSystemPrompt(pkg)).toBe(
        formatDirectorSystemPrompt(pkg),
      );
      expect(renderDirectorSystemPrompt(pkg, "markdown")).toBe(
        formatDirectorSystemPrompt(pkg),
      );
      expect(renderPromptBody(pkg.systemPrompt, "markdown")).toBe(
        pkg.systemPrompt,
      );
    }
  });

  test("xml arm keeps balanced tags with one counterpart per markdown section", () => {
    for (const id of DIRECTOR_IDS) {
      const pkg = DIRECTOR_REGISTRY[id];
      const full = formatDirectorSystemPrompt(pkg);
      const xml = renderDirectorSystemPrompt(pkg, "xml");
      const { sections } = splitPromptSections(full);
      if (sections.length === 0) {
        // Section-less directors render identically in both arms.
        expect(xml).toBe(full);
        continue;
      }
      // Every markdown section has exactly one xml counterpart.
      expect(tagNames(xml)).toHaveLength(sections.length);
      // Balanced: every open has its close, no heading lines survive.
      for (const tag of new Set(tagNames(xml))) {
        const opens = xml.split(`<${tag}>`).length - 1;
        const closes = xml.split(`</${tag}>`).length - 1;
        expect(opens).toBeGreaterThan(0);
        expect(closes).toBe(opens);
      }
      expect(xml).not.toMatch(/^#{1,2} /m);
      // Fixed vocabulary: every emitted tag is known or the fallback.
      const known = new Set<string>([
        ...PROMPT_SECTION_TAG_VOCABULARY,
        FALLBACK_SECTION_TAG,
      ]);
      for (const tag of tagNames(xml)) expect(known.has(tag)).toBe(true);
    }
  });

  test("fixed vocabulary covers every shipped section title", () => {
    const known: ReadonlySet<string> = new Set(PROMPT_SECTION_TAG_VOCABULARY);
    for (const id of DIRECTOR_IDS) {
      const { sections } = splitPromptSections(
        formatDirectorSystemPrompt(DIRECTOR_REGISTRY[id]),
      );
      for (const section of sections) {
        expect(known.has(tagForSectionTitle(section.title))).toBe(true);
      }
    }
  });

  test("style resolves once per session and defaults to markdown", () => {
    process.env[PROMPT_RENDER_STYLE_ENV_VAR] = "";
    resetCachedPromptRenderStyleForTests();
    expect(resolvePromptRenderStyle()).toBe("markdown");

    process.env[PROMPT_RENDER_STYLE_ENV_VAR] = "xml";
    resetCachedPromptRenderStyleForTests();
    expect(resolvePromptRenderStyle()).toBe("xml");
    // Mid-session flips do not take effect: the cache prefix holds.
    process.env[PROMPT_RENDER_STYLE_ENV_VAR] = "markdown";
    expect(resolvePromptRenderStyle()).toBe("xml");

    process.env[PROMPT_RENDER_STYLE_ENV_VAR] = "no-such-style";
    resetCachedPromptRenderStyleForTests();
    expect(resolvePromptRenderStyle()).toBe("markdown");
  });

  test("normalizeSectionTag handles digits, punctuation, and empties", () => {
    expect(normalizeSectionTag("Prerequisites")).toBe("prerequisites");
    expect(normalizeSectionTag("0. Document discovery")).toBe(
      "sec_0_document_discovery",
    );
    expect(
      normalizeSectionTag(
        "If IMPLEMENTATION → DIY when tiny; spawn when substantial",
      ),
    ).toBe("if_implementation_diy_when_tiny_spawn_when_substantial");
    expect(normalizeSectionTag("")).toBe(FALLBACK_SECTION_TAG);
    expect(tagForSectionTitle("a title no package uses")).toBe(
      FALLBACK_SECTION_TAG,
    );
  });
});
