/** OpenTUI platform kit — not wired to the CLI entry yet. */
export const PLATFORM_VERSION = "0.5.10" as const;

export * from "./geometry/index";
export * from "./focus/index";
export * from "./list-viewport";
export * from "./session-queue";
export * from "./stream";
export * from "./stream-event-map";
export {
  attachSessionBridge,
  createRecordingPort,
  FIXTURE_BUSY_SESSION,
  mapReactorLike,
  type PortCall,
  type SessionBridge,
  type SessionPort,
  type SessionPortHandlers,
} from "./runtime-bridge";
export * from "./live-session-port";
export * from "./overlays";
export * from "./long-log";
export * from "./command-catalog";
export * from "./model-catalog";
export * from "./copy-path";
export * from "./chrome-state";
export * from "./residuals";
export * from "./gate-wire";
export * from "./landing";
export * from "./mark-anim";
export * from "./mark-shape";
export * from "./shell";
export * from "./harness";
export {
  mountProductHost,
  operatorResultFromSelection,
  permissionChoices,
  type ProductHost,
  type ProductHostConfig,
  type ProductHostDeliver,
  type ProductHostInterrupt,
  type ProductHostModelOption,
  type ProductHostSend,
} from "./product-host";
