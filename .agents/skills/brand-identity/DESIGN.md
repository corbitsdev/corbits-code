---
design_system:
  name: Corbits Brand System
  version: 4.1.0

  # ─── COLORS (source: CBS color-palette.md) ───

  colors:
    primary:
      - name: Canvas Cream
        value: "#F7EAD5"
        role: Backgrounds, breathing room (~60% of composition)
      - name: Breakthrough Orange
        value: "#E98428"
        role: Action color, primary CTAs, attention moments
      - name: Bedrock Charcoal
        value: "#2B2627"
        role: Typography, structure, interface bones (~25%)
      - name: Summit Blue
        value: "#607C9A"
        role: Cool information, secondary signals
      - name: Ridge Green
        value: "#7B9974"
        role: Success, completion signals

    dark:
      - name: Canvas Cream
        value: "#E4D5BC"
      - name: Breakthrough Orange
        value: "#BF6B20"
      - name: Bedrock Charcoal
        value: "#1F1A1B"
      - name: Summit Blue
        value: "#2D455C"
      - name: Ridge Green
        value: "#425A3D"

    light:
      - name: Canvas Cream
        value: "#FFFFFF"
      - name: Breakthrough Orange
        value: "#F2B277"
      - name: Bedrock Charcoal
        value: "#5C5555"
      - name: Summit Blue
        value: "#C5D2DE"
      - name: Ridge Green
        value: "#C1D1BE"

    neutral:
      - name: Pure White
        value: "#FFFFFF"
      - name: Paper White
        value: "#F2F4F5"
      - name: Pure Black
        value: "#000000"

    # Semantic color tokens (structure borrowed from Linear, values from CBS palette)
    semantic:
      text:
        primary: "#2B2627"          # Bedrock Charcoal
        secondary: "#5C5555"        # Bedrock Charcoal light
        tertiary: "#607C9A"         # Summit Blue — muted, informational
        inverse: "#F7EAD5"          # Canvas Cream — text on dark backgrounds
        accent: "#E98428"           # Breakthrough Orange — links, emphasis
        success: "#7B9974"          # Ridge Green
      background:
        primary: "#F7EAD5"          # Canvas Cream
        secondary: "#FFFFFF"        # Pure White — cards, elevated surfaces
        tertiary: "#F2F4F5"         # Paper White — subtle section differentiation
        inverse: "#2B2627"          # Bedrock Charcoal — dark mode base
        accent: "#E98428"           # Breakthrough Orange — accent surfaces (use sparingly)
        success: "#7B9974"          # Ridge Green — success states
      border:
        default: "rgba(43, 38, 39, 0.12)"    # Charcoal at 12% — default borders
        strong: "rgba(43, 38, 39, 0.24)"      # Charcoal at 24% — emphasized borders
        focus: "#E98428"                       # Breakthrough Orange — focus rings
        success: "#7B9974"                     # Ridge Green — success borders
      icon:
        primary: "#2B2627"          # Bedrock Charcoal
        secondary: "#5C5555"        # Bedrock Charcoal light
        tertiary: "#607C9A"         # Summit Blue
        accent: "#E98428"           # Breakthrough Orange
        success: "#7B9974"          # Ridge Green

  # ─── TYPOGRAPHY (source: CBS typography.md) ───

  typography:
    families:
      - name: Belwe Bd BT
        value: "'Belwe Bd BT', 'Arial Black', Impact, sans-serif"
        role: Brand wordmark and brand marks only
        weights: [300, 500, 700]
        variable: --font/brand-font
      - name: Tratex
        value: "'Tratex', 'Arial Black', Impact, sans-serif"
        role: Display headlines
        weights: [700, 800]
        variable: --font/display-font
        case: uppercase          # Tratex is ALWAYS set in ALL CAPS — non-negotiable
        text_transform: uppercase
        variants:
          - name: TratexSvart
            use: Light backgrounds
            variable: --font/display-font---black
          - name: TratexVit
            use: Dark backgrounds
            variable: --font/display-font---white
      - name: Red Hat Display
        value: "'Red Hat Display', 'Open Sans', Roboto, Arial, sans-serif"
        role: All headings, body text, UI elements
        weights: [300, 400, 500, 600, 700, 900]
        variable: --font/body-font
      - name: Space Mono
        value: "'Space Mono', 'Fira Code', 'IBM Plex Mono', Monaco, Consolas, 'Courier New', monospace"
        role: Code, technical accents, data readouts
        weights: [400, 700]

    scale:
      - name: Title Hero
        font: Red Hat Display
        size: 72px
        weight: 900
        line_height: 1.2
        letter_spacing: 0
      - name: Title Page
        font: Red Hat Display
        size: 48px
        weight: 900
        line_height: 1.2
        letter_spacing: 0
      - name: Subtitle
        font: Red Hat Display
        size: 32px
        weight: 600
        line_height: 1.0
        letter_spacing: 0
        color: "#5C5555"
      - name: Heading 1
        font: Red Hat Display
        size: 60px
        weight: 700
        line_height: 1.2
        letter_spacing: 0
      - name: Heading 2
        font: Red Hat Display
        size: 48px
        weight: 700
        line_height: 1.2
        letter_spacing: 0
      - name: Heading 3
        font: Red Hat Display
        size: 36px
        weight: 500
        line_height: 1.2
        letter_spacing: 0
      - name: Body Large
        font: Red Hat Display
        size: 36px
        weight: 400
        line_height: 1.2
        letter_spacing: 0
      - name: Body Medium
        font: Red Hat Display
        size: 24px
        weight: 400
        line_height: 1.3
        letter_spacing: 0
      - name: Body Small
        font: Red Hat Display
        size: 18px
        weight: 400
        line_height: 1.3
        letter_spacing: 0
      - name: Paragraph
        font: Red Hat Display
        size: 16px
        weight: 400
        line_height: 1.3
        letter_spacing: 0
      - name: Caption
        font: Red Hat Display
        size: 20px
        weight: 400
        line_height: 1.2
        letter_spacing: 4px
        text_transform: uppercase
      - name: Code Inline
        font: Space Mono
        size: 14px
        weight: 400
        line_height: 1.5
        letter_spacing: 0
      - name: Code Block
        font: Space Mono
        size: 14px
        weight: 400
        line_height: 1.6
        letter_spacing: 0
      - name: Display
        font: Tratex
        size: 72px
        weight: 700
        line_height: 1.1
        letter_spacing: -0.04em
        text_transform: uppercase    # Tratex is always ALL CAPS

  # ─── SPACING (adapted from Linear's 4px grid, relaxed for breathing room) ───

  spacing:
    unit: px
    base: 4
    scale: [0, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96, 128, 160]
    semantic:
      - name: xs
        value: 4px
        use: Icon gaps, tight internal spacing
      - name: sm
        value: 8px
        use: Compact padding, inline element gaps
      - name: md
        value: 16px
        use: Standard padding, component internal spacing
      - name: lg
        value: 24px
        use: Card padding, section gutters
      - name: xl
        value: 32px
        use: Large component margins, group separation
      - name: 2xl
        value: 48px
        use: Major section breaks
      - name: 3xl
        value: 64px
        use: Page-level vertical rhythm
      - name: 4xl
        value: 96px
        use: Hero spacing, landing page sections
      - name: section
        value: 96px
        description: Vertical spacing between page sections
      - name: page-gutter
        value: 24px
        description: Horizontal page margins on mobile
      - name: page-gutter-desktop
        value: 64px
        description: Horizontal page margins on desktop

  # ─── LAYOUT (4px grid, adapted from Linear's 12-col approach) ───

  layout:
    max_width: 1280px
    content_width: 720px
    grid:
      columns: 12
      gutter: 24px
      gutter_desktop: 32px
    breakpoints:
      - name: sm
        value: 640px
      - name: md
        value: 768px
      - name: lg
        value: 1024px
      - name: xl
        value: 1280px
      - name: 2xl
        value: 1536px

  # ─── ELEVATION (source: CBS design-engineering.md ring-as-border pattern) ───

  elevation:
    levels:
      - name: flat
        value: "none"
        use: Default state, inline elements
      - name: raised
        value: "0px 0px 0px 1px rgba(0, 0, 0, 0.06), 0px 1px 2px -1px rgba(0, 0, 0, 0.06), 0px 2px 4px 0px rgba(0, 0, 0, 0.04)"
        use: Cards, containers, buttons
      - name: raised-hover
        value: "0px 0px 0px 1px rgba(0, 0, 0, 0.08), 0px 1px 2px -1px rgba(0, 0, 0, 0.08), 0px 2px 4px 0px rgba(0, 0, 0, 0.06)"
        use: Hover state for raised elements
      - name: floating
        value: "0px 4px 12px -2px rgba(0, 0, 0, 0.12), 0px 0px 0px 1px rgba(0, 0, 0, 0.06)"
        use: Dropdowns, popovers, tooltips
      - name: overlay
        value: "0px 16px 48px -8px rgba(0, 0, 0, 0.16), 0px 0px 0px 1px rgba(0, 0, 0, 0.06)"
        use: Modals, drawers, dialogs
    dark_mode:
      - name: raised
        value: "0 0 0 1px rgba(255, 255, 255, 0.08)"
      - name: raised-hover
        value: "0 0 0 1px rgba(255, 255, 255, 0.13)"
      - name: floating
        value: "0 0 0 1px rgba(255, 255, 255, 0.1), 0px 4px 12px -2px rgba(0, 0, 0, 0.4)"
      - name: overlay
        value: "0 0 0 1px rgba(255, 255, 255, 0.1), 0px 16px 48px -8px rgba(0, 0, 0, 0.6)"

  # ─── SHAPE (progressive radius, adapted from Linear's scale with larger defaults for breathing room) ───

  shape:
    border_radius:
      - name: none
        value: 0px
      - name: sm
        value: 4px
        use: Badges, chips, small inline elements
      - name: md
        value: 8px
        use: Buttons, inputs, small cards
      - name: lg
        value: 12px
        use: Cards, containers, dropdowns
      - name: xl
        value: 16px
        use: Modals, large cards, hero sections
      - name: 2xl
        value: 24px
        use: Feature cards, marketing surfaces
      - name: full
        value: 9999px
        use: Pills, avatars, circular elements
    rule: "Nested elements use concentric radii: outerRadius = innerRadius + padding"

  # ─── ICONOGRAPHY ───

  iconography:
    library: Lucide
    package: lucide-react
    stroke_width: 2px
    default_size: 24px

  # ─── MOTION (source: CBS design-engineering.md) ───

  motion:
    easing:
      - name: ease-out
        value: "cubic-bezier(0.23, 1, 0.32, 1)"
        use: UI interactions, enter animations
      - name: ease-in-out
        value: "cubic-bezier(0.77, 0, 0.175, 1)"
        use: On-screen movement, morphing
      - name: ease-drawer
        value: "cubic-bezier(0.32, 0.72, 0, 1)"
        use: Drawer and sheet animations
    duration:
      - name: instant
        value: 100ms
        use: Button press feedback
      - name: fast
        value: 150ms
        use: Tooltips, small popovers, hover states
      - name: normal
        value: 200ms
        use: Dropdowns, selects, standard transitions
      - name: slow
        value: 300ms
        use: Modals, drawers, page transitions
    reduce_motion: "Keep opacity and color transitions; remove transform-based movement"

  # ─── COMPONENTS (adapted from Linear's patterns, relaxed padding for breathing room) ───

  components:
    button:
      border_radius: 8px
      padding: "12px 20px"
      font: Red Hat Display
      font_weight: 600
      font_size: 16px
      active_scale: 0.97
      transition: "transform 160ms cubic-bezier(0.23, 1, 0.32, 1)"
      variants:
        - name: primary
          background: "#E98428"
          text: "#FFFFFF"
          hover_background: "#D4771F"
        - name: secondary
          background: transparent
          text: "#2B2627"
          border: "1px solid rgba(43, 38, 39, 0.12)"
        - name: ghost
          background: transparent
          text: "#2B2627"
    input:
      border_radius: 8px
      padding: "12px 16px"
      font: Red Hat Display
      font_size: 16px
      border: "1px solid rgba(43, 38, 39, 0.12)"
      focus_ring: "0 0 0 2px #E98428"
    card:
      border_radius: 12px
      padding: 24px
      shadow: "0px 0px 0px 1px rgba(0, 0, 0, 0.06), 0px 1px 2px -1px rgba(0, 0, 0, 0.06), 0px 2px 4px 0px rgba(0, 0, 0, 0.04)"
---

# Corbits Design System

Machine-readable design tokens for the Corbits brand. This file follows the [DESIGN.md](https://github.com/nichochar/design.md) specification, giving AI agents structured access to our visual system.

For strategic brand guidance (voice, messaging, photography, illustration, storytelling), see the full brand-identity skill and its 18 reference documents. This file covers **implementation tokens only**.

---

## Sources and Attribution

This file combines tokens from three sources:

| Source | What it provides |
|--------|-----------------|
| **CBS (Corbits Brand System)** | Colors, typography families, type scale, motion/easing values |
| **CBS design-engineering.md** | Elevation/shadow system (ring-as-border pattern), motion durations, interaction patterns |
| **Linear's design system** (adapted) | 4px grid structure, semantic color token naming, progressive border-radius scale, component padding ratios |

Where Linear's patterns are borrowed, values are adapted for **more breathing room** — ~20% more generous padding, wider desktop gutters, larger section spacing. Linear optimizes for extreme power-user density; we want spacious but efficient.

**Not borrowed from Linear:** Their color values, typography (Inter), or brand-specific styling. Our fonts, colors, and visual identity are entirely from CBS.

---

## Color Philosophy

Five colors. That's it. The constraint is the system.

Canvas Cream (`#F7EAD5`) is the ground — it should occupy ~60% of any composition. Bedrock Charcoal (`#2B2627`) carries all structure and text at ~25%. The remaining 15% splits across Breakthrough Orange, Summit Blue, and Ridge Green.

**Breakthrough Orange is earned, not distributed.** One primary CTA per screen. One attention moment per view. If everything is orange, nothing is.

Never use more than three colors in a single view. Dark mode isn't an inversion — it's a different time of day. Bedrock Charcoal darkens to `#1F1A1B` (never pure black), and all warm tones shift cooler and more muted.

### Semantic Color Tokens

The semantic tokens (see YAML above) map our five-color palette to UI roles. This structure is borrowed from Linear's approach — instead of referencing "Bedrock Charcoal" in component code, reference `--color-text-primary`. This decouples the brand palette from implementation, so dark mode and theme changes only require updating the semantic mapping.

| Token category | Purpose |
|---------------|---------|
| `text.*` | Text color by prominence level (primary → tertiary) |
| `background.*` | Surface colors by hierarchy (primary = Canvas Cream, secondary = White cards) |
| `border.*` | Border and divider colors by weight |
| `icon.*` | Icon fills matching the text hierarchy |

### Do's and Don'ts

- **Do** use Canvas Cream as the dominant background
- **Do** reserve Breakthrough Orange for the single most important action
- **Do** use semantic tokens (`text.primary`, `background.secondary`) in component code instead of raw hex values
- **Do** use Summit Blue for informational/secondary elements
- **Do** use Ridge Green exclusively for success and completion states
- **Don't** use more than three colors in a single view
- **Don't** use Breakthrough Orange for decorative purposes
- **Don't** use pure black (`#000000`) for text — use Bedrock Charcoal
- **Don't** invert the palette for dark mode — shift it (see dark mode tokens above)

---

## Typography Philosophy

Four fonts, each with a job. No overlap.

**Belwe Bd BT** is the brand — wordmark and brand marks only. It never appears in UI or body text.

**Tratex** is display impact — hero headlines, marketing statements, large-format typography. **Tratex is always set in ALL CAPS.** This is non-negotiable — the face is designed for uppercase setting and loses its intended impact in mixed case. It has two background-aware variants: TratexSvart (black ink, for light backgrounds) and TratexVit (white ink, for dark backgrounds). Always match the variant to the background.

**Red Hat Display** does everything else — headings, body, UI, navigation, labels. Its open forms and generous x-height make it readable at every size.

**Space Mono** is for code and data. Inline code, timestamps, technical readouts, terminal output. Fixed-width, precise, functional.

### Do's and Don'ts

- **Do** use Red Hat Display for all interface text
- **Do** set Tratex in ALL CAPS, always (apply `text-transform: uppercase`)
- **Do** match Tratex variant to background (Svart on light, Vit on dark)
- **Do** use `-0.04em` letter spacing for Belwe and Tratex at display sizes
- **Do** use `text-wrap: balance` on headings, `text-wrap: pretty` on body text
- **Do** apply `-webkit-font-smoothing: antialiased` globally
- **Don't** use Belwe in UI or body copy
- **Don't** set Tratex in sentence case or mixed case — ever
- **Don't** mix Tratex variants on the same background
- **Don't** use Space Mono for anything except code and data

---

## Spacing

4px base grid. Every measurement should be a multiple of 4. This is the standard grid unit used across modern design systems (Linear, Vercel, Figma).

Our semantic scale is tuned for **breathing room** — slightly more generous than Linear's dense power-user defaults. The goal: spacious enough to feel unhurried, compact enough for power users to scan efficiently.

| Token | Value | Use |
|-------|-------|-----|
| `xs` | 4px | Icon gaps, tight internal spacing |
| `sm` | 8px | Compact padding, inline element gaps |
| `md` | 16px | Standard padding, component internal spacing |
| `lg` | 24px | Card padding, section gutters |
| `xl` | 32px | Large component margins, group separation |
| `2xl` | 48px | Major section breaks |
| `3xl` | 64px | Page-level vertical rhythm |
| `4xl` | 96px | Hero spacing, landing page sections |
| `section` | 96px | Vertical rhythm between page sections |

Page gutters are `24px` on mobile, `64px` on desktop (Linear uses tighter gutters — we add breathing room). Content maxes out at `720px` for readability; full layouts at `1280px`.

### Decisions still needed

- [ ] **Density modes** — should Interchange support a "compact" mode for power users? If so, define a condensed spacing scale (reduce each token by one step)
- [ ] **Touch targets** — mobile spacing may need a separate scale with minimum 44px tap targets

---

## Layout

12-column grid with 24px gutters (32px on desktop). Breakpoints follow Tailwind defaults.

Content containers should use `max-w-3xl` (720px) for text-heavy layouts and `max-w-7xl` (1280px) for full-width layouts.

---

## Elevation

Shadows instead of borders for depth. This is the ring-as-border pattern from our design-engineering reference — the first shadow layer acts as a 1px border ring, the second adds subtle lift, the third provides ambient depth. This approach adapts to any background since shadows use transparency; solid borders don't.

The system has four levels:
1. **Flat** — default, no shadow
2. **Raised** — cards, containers, buttons (3-layer: ring + lift + ambient)
3. **Floating** — dropdowns, popovers, tooltips
4. **Overlay** — modals, drawers, dialogs

Dark mode shadows use white ring borders since layered depth shadows aren't visible on dark backgrounds.

### Do's and Don'ts

- **Do** use the 3-layer shadow system for raised elements
- **Do** transition shadows on hover (`150ms ease-out`)
- **Don't** use solid borders for depth on cards or buttons — use shadows
- **Don't** use layered shadows in dark mode — use single white ring

---

## Shape

Progressive border-radius scale. Larger, more prominent surfaces get larger radii. Our scale starts at 4px (Linear uses 2px for their smallest) — this contributes to the softer, more spacious feel.

| Token | Value | Use |
|-------|-------|-----|
| `sm` | 4px | Badges, chips, small inline elements |
| `md` | 8px | Buttons, inputs, small cards |
| `lg` | 12px | Cards, containers, dropdowns |
| `xl` | 16px | Modals, large cards, hero sections |
| `2xl` | 24px | Feature cards, marketing surfaces |
| `full` | 9999px | Pills, avatars, circular elements |

The critical rule for nested elements: **outer radius = inner radius + padding**. This creates concentric curves that feel natural. Mismatched radii on nested elements is one of the most common things that makes interfaces feel off.

If padding between nested elements exceeds 24px, treat them as independent surfaces and choose radii independently.

### Decisions still needed

- [ ] **Default interactive radius** — Linear uses 6px for buttons; we currently use 8px. Confirm 8px feels right for our brand.

---

## Iconography

We use [Lucide](https://lucide.dev/) exclusively. 2px stroke width, 24px default size. Install via `lucide-react`.

---

## Motion

Animations follow the design engineering principles from our full brand system. Key rules:

1. **Frequency determines animation.** Actions repeated 100+ times/day get no animation. Occasional actions (modals, drawers) get standard animation. Rare actions can add delight.
2. **Never animate keyboard-initiated actions.**
3. **Use `ease-out` for enters, `ease-in-out` for on-screen movement.** Never `ease-in` for UI — it feels sluggish.
4. **Stay under 300ms for UI animations.**
5. **Only animate `transform` and `opacity`** — these skip layout and paint.
6. **Never use `transition: all`.** Specify exact properties.
7. **Respect `prefers-reduced-motion`.** Keep opacity transitions, remove transform-based movement.

### Do's and Don'ts

- **Do** use custom easing curves (built-in CSS easings are too weak)
- **Do** add `scale(0.97)` on `:active` for pressable elements
- **Do** start enter animations from `scale(0.95)` with `opacity: 0` (never `scale(0)`)
- **Do** make popovers origin-aware (scale from trigger, not center)
- **Don't** animate keyboard shortcuts or command palette toggles
- **Don't** use keyframes for rapidly-triggered elements (use transitions for interruptibility)
- **Don't** exceed 300ms for UI animations
- **Don't** use Framer Motion `x`/`y` shorthand under load (use full `transform` string)

---

## Components

Component tokens define the base. Padding values are adapted from Linear's component patterns with ~20% more space for breathing room.

| What | Linear | Ours | Why |
|------|--------|------|-----|
| Button padding | `10px 16px` | `12px 20px` | More breathing room |
| Input padding | `10px 12px` | `12px 16px` | More breathing room |
| Button radius | 6px | 8px | Slightly softer feel |
| Card padding | ~16-20px | 24px | More breathing room |

All components follow these principles:

- **Buttons** use `scale(0.97)` active state, 160ms ease-out transition, 8px border radius
- **Primary buttons** use Breakthrough Orange — one per view
- **Inputs** use 8px border radius with a 2px Breakthrough Orange focus ring
- **Cards** use 12px border radius with the 3-layer raised shadow
- **Borders** use semantic `border.default` (Charcoal at 12% opacity) instead of `rgba(0, 0, 0, 0.12)`

For full component interaction patterns (springs, gestures, stagger animations, clip-path techniques), see `references/design-engineering.md`.

### Decisions still needed

- [ ] **Button sizes** — should we define sm/md/lg button variants with specific heights (32/40/48px)?
- [ ] **Input sizes** — same question for form inputs
- [ ] **Card variants** — bordered card vs shadow card vs flat card
- [ ] **Data table density** — row height and cell padding for power-user tables

---

## Tailwind Configuration

To export these tokens into a Tailwind config:

```js
// tailwind.config.js
const corbits = {
  colors: {
    cream: { DEFAULT: '#F7EAD5', dark: '#E4D5BC', light: '#FFFFFF' },
    orange: { DEFAULT: '#E98428', dark: '#BF6B20', light: '#F2B277' },
    charcoal: { DEFAULT: '#2B2627', dark: '#1F1A1B', light: '#5C5555' },
    blue: { DEFAULT: '#607C9A', dark: '#2D455C', light: '#C5D2DE' },
    green: { DEFAULT: '#7B9974', dark: '#425A3D', light: '#C1D1BE' },
    white: '#FFFFFF',
    paper: '#F2F4F5',
    black: '#000000',
    // Semantic tokens
    text: {
      primary: '#2B2627',
      secondary: '#5C5555',
      tertiary: '#607C9A',
      inverse: '#F7EAD5',
      accent: '#E98428',
      success: '#7B9974',
    },
    bg: {
      primary: '#F7EAD5',
      secondary: '#FFFFFF',
      tertiary: '#F2F4F5',
      inverse: '#2B2627',
      accent: '#E98428',
      success: '#7B9974',
    },
    border: {
      DEFAULT: 'rgba(43, 38, 39, 0.12)',
      strong: 'rgba(43, 38, 39, 0.24)',
      focus: '#E98428',
      success: '#7B9974',
    },
  },
  fontFamily: {
    brand: ["'Belwe Bd BT'", "'Arial Black'", 'Impact', 'sans-serif'],
    display: ["'Tratex'", "'Arial Black'", 'Impact', 'sans-serif'],
    body: ["'Red Hat Display'", "'Open Sans'", 'Roboto', 'Arial', 'sans-serif'],
    mono: ["'Space Mono'", "'Fira Code'", "'IBM Plex Mono'", 'Monaco', 'Consolas', "'Courier New'", 'monospace'],
  },
  borderRadius: {
    sm: '4px',
    md: '8px',
    lg: '12px',
    xl: '16px',
    '2xl': '24px',
    full: '9999px',
  },
  boxShadow: {
    raised: '0px 0px 0px 1px rgba(0, 0, 0, 0.06), 0px 1px 2px -1px rgba(0, 0, 0, 0.06), 0px 2px 4px 0px rgba(0, 0, 0, 0.04)',
    'raised-hover': '0px 0px 0px 1px rgba(0, 0, 0, 0.08), 0px 1px 2px -1px rgba(0, 0, 0, 0.08), 0px 2px 4px 0px rgba(0, 0, 0, 0.06)',
    floating: '0px 4px 12px -2px rgba(0, 0, 0, 0.12), 0px 0px 0px 1px rgba(0, 0, 0, 0.06)',
    overlay: '0px 16px 48px -8px rgba(0, 0, 0, 0.16), 0px 0px 0px 1px rgba(0, 0, 0, 0.06)',
  },
  spacing: {
    xs: '4px',
    sm: '8px',
    md: '16px',
    lg: '24px',
    xl: '32px',
    '2xl': '48px',
    '3xl': '64px',
    '4xl': '96px',
    section: '96px',
    'page-gutter': '24px',
    'page-gutter-desktop': '64px',
  },
}
```

---

## Relationship to Full Brand System

This DESIGN.md provides the **implementation layer** — structured tokens an agent can parse and apply directly to code.

The full brand-identity skill provides the **strategic layer**:
- Voice and tone (`references/brand-voice-tone.md`)
- Messaging and positioning (`references/brand-messaging.md`)
- Photography direction (`references/photography.md`)
- Illustration style (`references/illustration.md`)
- Logo usage and lockups (`references/logos.md`, `references/wordmarks.md`)
- Texture system (`references/textures.md`)
- Writing mechanics (`references/writing-mechanics.md`)
- Design engineering patterns (`references/design-engineering.md`)

Load `/brand-identity` for the full brand. Use this DESIGN.md for tokens.
