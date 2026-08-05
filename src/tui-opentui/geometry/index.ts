export {
  COLLAPSE_ORDER,
  IDLE_TRANSCRIPT_FLOOR,
  OVERLAY_MAX_FRACTION,
  OVERLAY_TRANSCRIPT_FLOOR,
  PAINT_ORDER,
  PROMPT_BASE_ROWS,
  PROMPT_CAP_FRACTION,
  ZONE_IDS,
  ZONE_REGISTRY,
  zoneDeclaration,
  type ZoneDeclaration,
  type ZoneId,
} from "./zones.js";

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
