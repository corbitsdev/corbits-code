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
  | "surface"
  | "syntaxKeyword"
  | "syntaxString"
  | "syntaxComment"
  | "syntaxFunction"
  | "syntaxNumber"
  | "syntaxType"
  | "syntaxOperator"
  | "syntaxPunctuation"
  | "syntaxVariable"
  | "markdownHeading"
  | "markdownLink"
  | "markdownCode"
  | "markdownBlockquote"
  | "markdownEmphasis"
  | "markdownStrong"
  | "diffAdded"
  | "diffRemoved"
  | "diffContext"
  | "diffHunkHeader"
  | "diffAddedBg"
  | "diffRemovedBg"
  | "userMessageBg";

const breakthroughOrange: ColorValue = { hex: "#f5933a", ansi256: 173 };
const summitBlue: ColorValue = { hex: "#7ea2c4", ansi256: 74 };
const ridgeGreen: ColorValue = { hex: "#94b889", ansi256: 108 };
const bedrockCharcoal: ColorValue = { hex: "#2b2627", ansi256: 235 };
// Body prose. A calm warm off-white rather than near-white cream so a wall of
// text does not read as heavy; emphasis and headings sit above it in brightness.
const bodyOffWhite: ColorValue = { hex: "#d0c7bb", ansi256: 250 };
// The brightest step in the ladder — carries inline emphasis so strong text
// reads as brighter rather than shouting in bold weight.
const emphasisCream: ColorValue = { hex: "#faf1e2", ansi256: 230 };
const dangerRed: ColorValue = { hex: "#e0594d", ansi256: 167 };
const mutedGray: ColorValue = { hex: "#a89f96", ansi256: 247 };
// One step dimmer than muted — used for tool args, collapsed results, thinking gutter.
const dimGray: ColorValue = { hex: "#736c66", ansi256: 243 };
const heatherPurple: ColorValue = { hex: "#b48ead", ansi256: 139 };
const duskOrange: ColorValue = { hex: "#d19a66", ansi256: 173 };
const sandGold: ColorValue = { hex: "#e5c07b", ansi256: 180 };
// A half-step below muted so punctuation recedes behind identifiers without
// falling all the way to the dim rung used by comments.
const graphiteGray: ColorValue = { hex: "#8a827a", ansi256: 244 };
// Between body text and emphasis cream — italic emphasis lifts slightly above
// prose while strong text keeps the top brightness rung.
const parchment: ColorValue = { hex: "#e8ddcc", ansi256: 253 };
const pineShadow: ColorValue = { hex: "#293a28", ansi256: 22 };
const emberShadow: ColorValue = { hex: "#3d2a28", ansi256: 52 };
// Cool gray in an otherwise warm palette; kept deliberately so the user's own
// words sit apart from everything the model produces.
const coolGray: ColorValue = { hex: "#45454a", ansi256: 238 };

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
  text: bodyOffWhite,
  emphasis: emphasisCream,
  surface: bedrockCharcoal,
  syntaxKeyword: heatherPurple,
  syntaxString: ridgeGreen,
  syntaxComment: dimGray,
  syntaxFunction: summitBlue,
  syntaxNumber: duskOrange,
  syntaxType: sandGold,
  syntaxOperator: mutedGray,
  syntaxPunctuation: graphiteGray,
  syntaxVariable: bodyOffWhite,
  markdownHeading: emphasisCream,
  markdownLink: summitBlue,
  markdownCode: breakthroughOrange,
  markdownBlockquote: mutedGray,
  markdownEmphasis: parchment,
  markdownStrong: emphasisCream,
  diffAdded: ridgeGreen,
  diffRemoved: dangerRed,
  // Carries the full dimmed appearance of unchanged rows; renderers should not
  // stack an extra dim attribute on top.
  diffContext: dimGray,
  diffHunkHeader: summitBlue,
  diffAddedBg: pineShadow,
  diffRemovedBg: emberShadow,
  userMessageBg: coolGray,
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
