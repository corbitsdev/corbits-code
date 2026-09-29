import { extname } from "node:path";
import { shellQuote } from "../agent/tool-aliases.js";

/** Host binary that extracts text from a PDF (poppler). */
export const PDF_EXTRACTOR_BIN = "pdftotext";

const PDF_MAGIC = Buffer.from("%PDF");

export type FileInspectionKind =
  | "pdf"
  | "pdf-malformed"
  | "binary"
  | "unreadable";

export type FileInspectionBlockCode =
  | "missing_extractor"
  | "permission_boundary"
  | "extractor_ready"
  | "malformed"
  | "unreadable"
  | "binary";

export interface FileInspectionDiagnosis {
  code: FileInspectionBlockCode;
  message: string;
}

export interface DiagnoseBlockedFileInspectionInput {
  path: string;
  kind: FileInspectionKind;
  extractorAvailable: boolean;
  canExecuteHostCommands: boolean;
  extractorName?: string;
}

export function chunkLooksLikePdf(chunk: Uint8Array): boolean {
  return (
    chunk.length >= PDF_MAGIC.length &&
    Buffer.from(chunk.subarray(0, PDF_MAGIC.length)).equals(PDF_MAGIC)
  );
}

export function pathLooksLikePdf(filePath: string): boolean {
  return extname(filePath).toLowerCase() === ".pdf";
}

/**
 * Classify the first streamed chunk. PDF magic wins even without a .pdf
 * suffix. A .pdf name with NUL but no magic is malformed. A .pdf that is
 * otherwise valid UTF-8 is left as a normal text read so a misnamed text
 * file is not a new refusal.
 */
export function inspectionKindFromFirstChunk(
  filePath: string,
  chunk: Uint8Array,
): FileInspectionKind | undefined {
  if (chunkLooksLikePdf(chunk)) return "pdf";
  if (chunk.includes(0)) {
    return pathLooksLikePdf(filePath) ? "pdf-malformed" : "binary";
  }
  return undefined;
}

function extractorLabel(name: string | undefined): string {
  return name !== undefined && name.length > 0 ? name : PDF_EXTRACTOR_BIN;
}

/**
 * Operator- and model-facing diagnosis when read_file cannot inspect a file.
 * One fact (capability vs permission vs bad file) plus one next action.
 */
export function diagnoseBlockedFileInspection(
  input: DiagnoseBlockedFileInspectionInput,
): FileInspectionDiagnosis {
  const extractor = extractorLabel(input.extractorName);
  const path = input.path;

  if (input.kind === "unreadable") {
    return {
      code: "unreadable",
      message:
        `Unreadable file (filesystem permission denied), not a missing extractor or worker-tool gap. ` +
        `Check ownership and mode, or copy it into a readable workspace path. File: ${path}`,
    };
  }

  if (input.kind === "pdf-malformed") {
    return {
      code: "malformed",
      message:
        `Malformed PDF, not a missing extractor or permission boundary. ` +
        `Open it in a PDF reader or re-export it. File: ${path}`,
    };
  }

  if (input.kind === "binary") {
    return {
      code: "binary",
      message:
        `refusing to read binary file: ${path}. Not a missing-tool or permission failure. ` +
        `Use a format-specific extractor if you need text from it.`,
    };
  }

  // kind === "pdf"
  if (!input.extractorAvailable) {
    return {
      code: "missing_extractor",
      message:
        `Missing PDF extractor: ${extractor} is not on PATH (capability gap), not a malformed file. ` +
        `Install poppler (\`brew install poppler\` or \`apt-get install poppler-utils\`), then retry. File: ${path}`,
    };
  }

  if (!input.canExecuteHostCommands) {
    return {
      code: "permission_boundary",
      message:
        `Permission boundary: ${extractor} is installed but this worker cannot execute it (run_shell is not mounted), not a malformed file. ` +
        `Re-dispatch to a director that mounts run_shell, or grant this worker run_shell. File: ${path}`,
    };
  }

  return {
    code: "extractor_ready",
    message: `read_file cannot decode PDFs. ${extractor} is installed — run \`${extractor} ${shellQuote(path)} -\` via bash.`,
  };
}
