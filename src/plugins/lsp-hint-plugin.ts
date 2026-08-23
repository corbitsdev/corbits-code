import path from "node:path";
import type { ToolPlugin } from "@intx/tools-posix";

const TS_LIKE = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);

const LSP_UNAVAILABLE = "no LSP server available for this file type";
const INSTALL_HINT =
  " Install typescript-language-server in the project (e.g. bun add -d typescript-language-server) or on PATH.";

/** Append a setup hint when the stock LSP tool reports no server for TS/JS files. */
export function lspHintPlugin(): ToolPlugin {
  return {
    middleware: (next) => async (call, signal) => {
      const result = await next(call, signal);
      if (call.name !== "lsp" || result.isError !== true) {
        return result;
      }
      const content = String(result.content);
      if (!content.includes(LSP_UNAVAILABLE)) {
        return result;
      }
      const rawPath = call.arguments.filePath;
      if (typeof rawPath !== "string") {
        return result;
      }
      const ext = path.extname(rawPath).toLowerCase();
      if (!TS_LIKE.has(ext)) {
        return result;
      }
      if (content.includes(INSTALL_HINT.trim())) {
        return result;
      }
      return { ...result, content: `${content}.${INSTALL_HINT}` };
    },
  };
}
