export type ColorValue = { hex: string; ansi256: number };

export type SemanticRole =
  | "brand"
  | "accent"
  | "success"
  | "danger"
  | "warning"
  | "muted"
  | "dim"
  | "live"
  | "text"
  | "emphasis"
  | "surface";

const breakthroughOrange: ColorValue = { hex: "#f5933a", ansi256: 173 };
const summitBlue: ColorValue = { hex: "#7ea2c4", ansi256: 74 };
const ridgeGreen: ColorValue = { hex: "#94b889", ansi256: 108 };
const bedrockCharcoal: ColorValue = { hex: "#2b2627", ansi256: 235 };
const canvasCream: ColorValue = { hex: "#faf1e2", ansi256: 230 };
// One step brighter than the cream body text — carries inline emphasis so
// strong text reads as brighter rather than shouting in bold weight.
const brightWhite: ColorValue = { hex: "#ffffff", ansi256: 231 };
const dangerRed: ColorValue = { hex: "#e0594d", ansi256: 167 };
const mutedGray: ColorValue = { hex: "#a89f96", ansi256: 247 };
// One step dimmer than muted — used for tool args, collapsed results, thinking gutter.
const dimGray: ColorValue = { hex: "#736c66", ansi256: 243 };

export const palette: Record<SemanticRole, ColorValue> = {
  brand: breakthroughOrange,
  accent: summitBlue,
  success: ridgeGreen,
  danger: dangerRed,
  warning: breakthroughOrange,
  muted: mutedGray,
  dim: dimGray,
  // Spinner/streaming indicator color — calm blue rather than brand orange.
  live: summitBlue,
  text: canvasCream,
  emphasis: brightWhite,
  surface: bedrockCharcoal,
};

export function color(role: SemanticRole): string {
  return palette[role].hex;
}

export function color256(role: SemanticRole): number {
  return palette[role].ansi256;
}

export function supportsTrueColor(): boolean {
  const colorterm = process.env.COLORTERM;
  if (colorterm === undefined) return false;
  return colorterm === "truecolor" || colorterm === "24bit";
}
