export {
  AGENTS_PANEL_MAX_VISIBLE,
  COLLAPSE_ORDER,
  FLEET_BOARD_CAP_FRACTION,
  FLEET_FLOOR_MIN_LANES,
  FLEET_TRANSCRIPT_FLOOR,
  IDLE_TRANSCRIPT_FLOOR,
  OVERLAY_MAX_FRACTION,
  OVERLAY_MIN_ROWS,
  OVERLAY_TRANSCRIPT_FLOOR,
  PROMPT_BASE_ROWS,
  PROMPT_CAP_FRACTION,
  PROMPT_IDLE_ROWS,
  TASKS_PANEL_MAX_VISIBLE,
  ZONE_IDS,
  ZONE_REGISTRY,
} from "./zones.js";

export {
  BOTTOM_MARGIN_MIN_ROWS,
  MARGIN_MIN_COLUMNS,
  SIDE_MARGIN,
  resolveBottomMarginRows,
  resolveContentWidth,
  resolveSideMargin,
  resolveTopPadRows,
} from "./zones.js";

export {
  resolveGeometry,
  type GeometryInput,
  type GeometryLayout,
  type OverlayMode,
  type ZoneVisibility,
} from "./resolve.js";
