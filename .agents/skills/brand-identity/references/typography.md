# Typography

---

## Font Families

### Brand Font — Belwe Bd BT

CSS variable: `--font/brand-font`

Used for the Corbits wordmark and brand marks. Bold, serif character with strong visual weight.

- **Specimen:** Belwe Bd BT Bold
- **Fallbacks:** Arial Black, Impact
- **Sizes:** 48px–96px+ for hero, 28px–48px for section titles
- **Weights:** Bold (700) or ExtraBold (800)
- **Letter spacing:** -0.04em at display sizes

Files: `fonts/Belwe/BelweBT-Bold.ttf`, `BelweBT-Medium.ttf`, `BelweBT-Light.ttf`, `BelweBT-RomanCondensed.ttf`

---

### Display Font — Tratex

Two variants for background contrast:

| Variant | CSS Variable | Font File | Use |
|---------|-------------|-----------|-----|
| TratexSvart (Black) | `--font/display-font---black` | `fonts/Tratex/TratexSvart/TRATS___.TTF` | Light backgrounds |
| TratexVit (White) | `--font/display-font---white` | `fonts/Tratex/TratexVit/TRATV___.TTF` | Dark backgrounds |

Tratex is a contemporary display sans-serif known for its strong, utilitarian lines and robust presence. It often features subtle industrial or technical cues, making it feel engineered and sturdy. Its impactful nature commands attention without being overly decorative, aligning with the brand's directness and problem-solving focus.

- **Case:** ALL CAPS — always. Tratex is never set in sentence case or mixed case. Apply `text-transform: uppercase` in CSS or capitalize all characters in source text.
- **Fallbacks:** Arial Black, Impact
- **Sizes:** 48px–96px+ for hero, 28px–48px for section titles
- **Weights:** Bold (700) or ExtraBold (800) primarily; lighter weights for very large stylized brand statements
- **Letter spacing:** -0.04em at display sizes

Additional variants: `TratexNegVersal/TRATEN__.TTF`, `TratexPosVersal/TRATEP__.TTF`

---

### Body Font — Red Hat Display

CSS variable: `--font/body-font`

Red Hat Display is a highly accessible and widely respected typeface known for its exceptional legibility across diverse screen sizes and resolutions. Its open forms, generous x-height, and neutral yet friendly appearance make it incredibly comfortable for extended reading. It boasts a broad range of weights and excellent language support, ensuring global accessibility and versatility for all content.

- **Fallbacks:** Open Sans, Roboto, Arial, sans-serif
- **Sizes:** 16px–20px for primary body text on desktop
- **Weights:** Regular (400) for paragraphs; Semibold (600) or Bold (700) for emphasis

**Available weights:**

| Category | Weights |
|----------|---------|
| Primary | Light, Regular, Medium |
| Secondary | Italic, Medium-Italic |

---

### Accent Font — Space Mono

Monospace typeface for code and technical accents.

Space Mono serves as a direct, powerful visual nod to the "software engineer" aspect of the brand. Its fixed-width, monospace nature instantly evokes command-line interfaces, code editors, and technical documentation. It injects a sense of precise functionality, analytical thought, and a subtle retro-futuristic charm. It communicates that the brand understands the underlying logic and structure.

- **Fallbacks:** Fira Code, IBM Plex Mono, Monaco, Consolas, Courier New, monospace
- **Sizes:** 13px–16px for inline code, data readouts, timestamps; 18px–24px for code blocks, labels, UI elements
- **Weights:** Regular (400) primarily; Bold (700) for specific emphasis

Files: `fonts/Space_Mono/SpaceMono-Regular.ttf`, `SpaceMono-Bold.ttf`, `SpaceMono-Italic.ttf`, `SpaceMono-BoldItalic.ttf`

---

## Heading Scale

All headings use Red Hat Display (`--font/body-font`).

| Style | Weight | Size | Line Height | Letter Spacing |
|-------|--------|------|-------------|----------------|
| Title Hero | Black (900) | 72px | 1.2 | 0 |
| Title Page | Black (900) | 48px | 1.2 | 0 |
| Subtitle | Semi-bold (600) | 32px | 100% | 0 |
| Heading 1 | Bold (700) | 60px | 1.2 | 0 |
| Heading 2 | Bold (700) | 48px | 1.2 | 0 |
| Heading 3 | Medium (500) | 36px | 1.2 | 0 |

Subtitle uses `--color/light/bedrock-charcoal` (#5C5555).

---

## Body Scale

All body styles use Red Hat Display (`--font/body-font`).

| Style | Weight | Size | Line Height | Letter Spacing |
|-------|--------|------|-------------|----------------|
| Body Large | Regular (400) | 36px | 1.2 | 0 |
| Body Medium | Regular (400) | 24px | 1.3 | 0 |
| Body Small | Regular (400) | 18px | 1.3 | 0 |
| Paragraph | Regular (400) | 16px | 1.3 | 0 |
| Caption | Regular (400) | 20px | 1.2 | 4px (uppercase) |

---

## CSS Variable Summary

| Variable | Font | Usage |
|----------|------|-------|
| `--font/brand-font` | Belwe Bd BT (Bold) | Logo, brand marks |
| `--font/display-font---white` | TratexVit (Regular) | Display headlines on dark backgrounds — **ALL CAPS only** |
| `--font/display-font---black` | TratexSvart (Regular) | Display headlines on light backgrounds — **ALL CAPS only** |
| `--font/body-font` | Red Hat Display | All headings, body text, UI elements |

**Tratex case rule:** Any use of Tratex (either variant) must be set in ALL CAPS. Apply `text-transform: uppercase` in CSS, or write the source text in uppercase. This is non-negotiable — Tratex is a display face designed for uppercase setting and loses its intended impact in mixed case.
