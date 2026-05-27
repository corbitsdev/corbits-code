---
name: brand-identity
description: |
  Applies Corbits brand system to any artifact. Routes to the relevant domain
  (color, typography, logo, imagery, messaging, templates) and loads only what's
  needed. Use when brand colors, style guidelines, visual formatting, typography,
  design tokens, logo usage, photography direction, or messaging alignment is
  required.
metadata:
  author: pva
  version: 4.1.0
  category: brand
  tags: [brand, design, identity, messaging, visual-identity]
---

# Brand Guidelines

You are applying the Corbits brand system. This skill routes requests to the
correct brand domain and loads only the relevant reference material.

## Step 1: Classify the Request

Determine which domain(s) the request falls into:

| Domain | Trigger signals | Reference file |
|--------|----------------|----------------|
| **Color** | Hex values, palette, color usage, backgrounds, accents | `references/color-palette.md` |
| **Typography** | Fonts, type scale, weights, headings, body text, captions | `references/typography.md` |
| **Logos** | Logo placement, sizing, clear space, do/don't, lockups | `references/logos.md` + `references/wordmarks.md` |
| **Imagery — Photography** | Photo direction, sports, human, aerial, lifestyle | `references/photography.md` |
| **Imagery — Illustration** | Illustration style, line work, fills, characters | `references/illustration.md` |
| **Imagery — Textures** | Background textures, material prompts, grain | `references/textures.md` |
| **Imagery — Iconography** | Icons, icon style, icon grid, strokes | `references/iconography.md` |
| **Products** | Product definitions, ecosystem, relationships, what each product is/does | `references/products.md` |
| **Messaging — Positioning** | Category, value props, statements | `references/statements.md` + `references/value-generation.md` |
| **Messaging — Pitches** | One-liners, elevator pitches, core messages, proof points | `references/brand-messaging.md` |
| **Voice and Tone** | Voice elements, tone adaptation, writing principles, voice attributes | `references/brand-voice-tone.md` |
| **Word List** | Standardized spellings, terms to use/avoid, special cases | `references/brand-word-list.md` |
| **Writing — Grammar** | Capitalization, punctuation, numbers, dates, formatting, copyright | `references/writing-mechanics.md` |
| **Writing — Web Elements** | Alt text, buttons, forms, headings, links, lists, SEO/GEO | `references/writing-web-elements.md` |
| **Writing — Agents** | How to describe agents, capabilities, limitations, failures, human role | `references/writing-agents-guide.md` |
| **Templates** | Social layouts, email, presentations, collateral | `references/brand-templates.md` |
| **Design Engineering** | Animation, UI polish, interaction design, easing, transitions, component craft | `references/design-engineering.md` |
| **Design Tokens** | Structured tokens for colors, typography, spacing, elevation, shapes, components, Tailwind config | `DESIGN.md` |

Most requests touch 1-2 domains. When in doubt, load more references rather than fewer — completeness beats efficiency here.

## Step 2: Load the Relevant References

Read the reference file(s) identified in Step 1 using relative paths from this
skill's directory.

If the request spans multiple domains (e.g., "review this landing page"), load
each relevant domain's reference. But never load all references preemptively —
read them as you encounter specific questions.

### Asset directories

When you need to reference or inspect actual brand assets:

| Asset type | Path |
|------------|------|
| Logo SVGs/PNGs | `references/BRANDS/` |
| Font files | `references/fonts/` |
| Texture images | `references/textures/` |
| Photography references | `references/photography/` |
| Illustration references | `references/illustration/` |
| Iconography references | `references/iconography/` |

## Step 3: Apply and Evaluate

With the relevant references loaded:

1. **Evaluate** the artifact against the loaded brand standards
2. **Flag** any deviations with specific citations (e.g., "Breakthrough Orange should be #E98428, not #E9842A")
3. **Recommend** fixes with exact values from the reference docs
4. **Never improvise** brand values — if the reference doesn't specify something, say so rather than guessing

## Domain Quick Reference

For fast lookups without loading full reference docs:

### Primary Colors
- Canvas Cream: `#F7EAD5` — backgrounds, breathing room (~60%)
- Breakthrough Orange: `#E98428` — action color, primary CTAs
- Bedrock Charcoal: `#2B2627` — typography, structure (~25%)
- Summit Blue: `#607C9A` — cool information, secondary signals
- Ridge Green: `#7B9974` — success, completion signals

### Primary Typefaces
- Belwe Bd BT: Brand wordmark, brand marks (Bold 700)
- Tratex: Display/hero headlines, **ALL CAPS only** (Svart on light, Vit on dark)
- Red Hat Display: Headings, body text, UI elements (Regular 400–Black 900)
- Space Mono: Code, technical accents, data readouts (Regular 400)

### Logo Rule
- Minimum clear space: height of the "C" in the wordmark on all sides
- Never stretch, rotate, recolor, or add effects
