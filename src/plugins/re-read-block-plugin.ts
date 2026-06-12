import type { ToolPlugin } from "@intx/tools-posix";
import type { CodingDirector } from "../agent/director.js";

export function reReadBlockPlugin(
  getDirector: () => Pick<CodingDirector, "getFilesReadAtTurn"> | undefined,
): ToolPlugin {
  return {
    middleware: (next) => async (call, signal) => {
      if (call.name === "read_file") {
        const director = getDirector();
        if (director !== undefined) {
          const path = String((call.arguments as Record<string, unknown>).path ?? "");
          const readAtTurn = director.getFilesReadAtTurn().get(path);
          if (readAtTurn !== undefined) {
            return {
              callId: call.id,
              content: `File already read at turn ${readAtTurn}. Use that result.`,
              isError: true,
            };
          }
        }
      }
      return next(call, signal);
    },
  };
}
