/**
 * Headless import check for @opentui/core (no TTY required).
 * Run: bun ./src/tui/smoke.ts
 */
import "@opentui/core";

const PLATFORM_VERSION = "0.5.10" as const;

console.log(`opentui-ok platform=${PLATFORM_VERSION}`);
