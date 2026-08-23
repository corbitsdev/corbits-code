/**
 * Headless import check for @opentui/core (no TTY required).
 * Run: bun ./src/tui/smoke.ts
 */
import "@opentui/core";
import { PLATFORM_VERSION } from "./index";

console.log(`opentui-ok platform=${PLATFORM_VERSION}`);
