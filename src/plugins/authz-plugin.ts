import type { ToolPlugin } from "@intx/tools-posix";
import type { ToolCall, ToolResult } from "@intx/types/runtime";

const BLOCKED_PATTERNS = [
  /rm\s+-rf\s+/,
  />{1,2}\s*\/etc\//,
  />{1,2}\s*\/sys\//,
  />{1,2}\s*\/proc\//,
  />{1,2}\s*\/dev\//,
  />{1,2}\s*\/var\//,
  /\btee\s+\/(etc|sys|proc|dev|var)\//,
  /\bcp\s+.*\/(etc|sys|proc|dev|var)\//,
  /\bmv\s+.*\/(etc|sys|proc|dev|var)\//,
  /dd\s+.*of=\s*\/dev\//,
  /dd\s+.*if=\s*\/dev\/zero.*of=\s*\/dev\//,
  /mkfs\b/,
  /mkfs\./,
  /:\(\)\s*\{\s*:\|:\&\s*\};/,
  /bash\s+-c\s+.*while\s+:\s*;\s*do/,
  /perl\s+-e\s+.*fork\s+while\s+fork/,
  /curl\s+.*\|\s*(bash|sh|zsh)/,
  /wget\s+.*\|\s*(bash|sh|zsh)/,
  /fetch\s+.*\|\s*(bash|sh|zsh)/,
  /sudo\b/,
  /su\s+-/,
  /\beval\b/,
  /\bexec\b/,
  /\bmkfs\b/,
  /\bfdisk\b/,
  /\bformat\b/,
  /chmod\s+.*\/(etc|sys|proc|dev|bin|sbin|usr\/bin|usr\/sbin)/,
  /chown\s+.*\/(etc|sys|proc|dev|bin|sbin|usr\/bin|usr\/sbin)/,
  /shutdown\b/,
  /reboot\b/,
  /poweroff\b/,
  /init\s+0/,
  /init\s+6/,
];

export function authzPlugin(): ToolPlugin {
  return {
    middleware: (next) => async (call, signal) => {
      if (call.name === "run_shell") {
        const command = String(call.arguments.command ?? "");
        for (const pattern of BLOCKED_PATTERNS) {
          if (pattern.test(command)) {
            return {
              callId: call.id,
              content: `Destructive command blocked by policy: ${command}`,
              isError: true,
            };
          }
        }
      }
      return next(call, signal);
    },
  };
}
