export type ColorValue = { hex: string; ansi256: number };

export type SemanticRole =
  | "brand"
  | "accent"
  | "success"
  | "danger"
  | "warning"
  | "muted"
  | "text"
  | "surface";

const breakthroughOrange: ColorValue = { hex: "#e98428", ansi256: 173 };
const summitBlue: ColorValue = { hex: "#607C9A", ansi256: 67 };
const ridgeGreen: ColorValue = { hex: "#7B9974", ansi256: 108 };
const bedrockCharcoal: ColorValue = { hex: "#2b2627", ansi256: 235 };
const canvasCream: ColorValue = { hex: "#f7ead5", ansi256: 230 };
const dangerRed: ColorValue = { hex: "#c4453a", ansi256: 167 };
const mutedGray: ColorValue = { hex: "#8a8079", ansi256: 245 };

export const palette: Record<SemanticRole, ColorValue> = {
  brand: breakthroughOrange,
  accent: summitBlue,
  success: ridgeGreen,
  danger: dangerRed,
  warning: breakthroughOrange,
  muted: mutedGray,
  text: canvasCream,
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
