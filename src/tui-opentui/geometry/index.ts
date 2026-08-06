export {
  COLLAPSE_ORDER,
  IDLE_TRANSCRIPT_FLOOR,
  OVERLAY_MAX_FRACTION,
  OVERLAY_TRANSCRIPT_FLOOR,
  PAINT_ORDER,
  PROMPT_BASE_ROWS,
  PROMPT_BORDER_ROWS,
  PROMPT_CAP_FRACTION,
  PROMPT_IDLE_INPUT_ROWS,
  PROMPT_IDLE_ROWS,
  ZONE_IDS,
  ZONE_REGISTRY,
  zoneDeclaration,
  type ZoneDeclaration,
  type ZoneId,
} from "./zones.js";

export {
  MARGIN_FULL_MIN_COLUMNS,
  MARGIN_MIN_COLUMNS,
  NARROW_SIDE_MARGIN,
  SIDE_MARGIN,
  TOP_PAD_MIN_TRANSCRIPT_ROWS,
  TOP_PAD_ROWS,
  resolveContentWidth,
  resolveSideMargin,
  resolveTopPadRows,
} from "./margins.js";

export {
  desiredHeights,
  resolveGeometry,
  type GeometryInput,
  type GeometryLayout,
  type OverlayInput,
  type OverlayMode,
  type Rect,
  type TerminalSize,
  type ZoneVisibility,
} from "./resolve.js";
