// Caps how many sub-agent loops run at once. Each loop spawns its own LSP
// sidecars and git-backed store; unbounded parallel task calls (e.g. workflow
// review panels) can exhaust process/file limits and take down the TUI.

import {
  DEFAULT_MAX_CONCURRENT_SUB_AGENTS,
  clampMaxConcurrentSubAgents,
} from "../config/settings.js";

export const SUB_AGENTS_DISABLED_MESSAGE =
  "Sub-agents are disabled (maxConcurrentSubAgents is 0 in settings).";

let maxConcurrent = DEFAULT_MAX_CONCURRENT_SUB_AGENTS;
let active = 0;
const waiters: Array<() => void> = [];

export function configureSubAgentConcurrency(limit: number): void {
  maxConcurrent = clampMaxConcurrentSubAgents(limit);
}

/** @internal Tests only — prefer configureSubAgentConcurrency. */
export function setMaxConcurrentSubAgentsForTests(value: number): void {
  configureSubAgentConcurrency(value);
}

function release(): void {
  active = Math.max(0, active - 1);
  const next = waiters.shift();
  if (next !== undefined) next();
}

function acquire(): Promise<void> {
  if (maxConcurrent === 0) {
    return Promise.reject(new Error(SUB_AGENTS_DISABLED_MESSAGE));
  }
  if (active < maxConcurrent) {
    active++;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    waiters.push(() => {
      active++;
      resolve();
    });
  });
}

export async function withSubAgentSlot<T>(fn: () => Promise<T>): Promise<T> {
  await acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}