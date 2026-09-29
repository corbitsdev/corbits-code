import { extname } from "node:path";

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
 * suffix. A .pdf name without magic is malformed, whether or not the chunk
 * looks binary. NUL without PDF markers is an ordinary binary file.
 */
export function inspectionKindFromFirstChunk(
  filePath: string,
  chunk: Uint8Array,
): FileInspectionKind | undefined {
  if (chunkLooksLikePdf(chunk)) return "pdf";
  if (pathLooksLikePdf(filePath)) return "pdf-malformed";
  if (chunk.includes(0)) return "binary";
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
        `Cannot inspect ${path}: the file is unreadable (filesystem permission denied), not a missing extractor or worker-tool gap. ` +
        `Check ownership and mode, or copy the file into a readable workspace path.`,
    };
  }

  if (input.kind === "pdf-malformed") {
    return {
      code: "malformed",
      message:
        `Cannot inspect ${path}: the file is not a valid PDF (malformed or unreadable bytes), not a missing extractor or permission boundary. ` +
        `Open it in a PDF reader or re-export it, then retry.`,
    };
  }

  if (input.kind === "binary") {
    return {
      code: "binary",
      message:
        `refusing to read binary file: ${path}. This is a binary file, not a missing-tool or permission failure. ` +
        `Use a format-specific extractor if you need text from it.`,
    };
  }

  // kind === "pdf"
  if (!input.extractorAvailable) {
    return {
      code: "missing_extractor",
      message:
        `Cannot inspect PDF ${path}: ${extractor} is not installed (missing PDF-extraction capability), not a malformed file. ` +
        `Install poppler so ${extractor} is on PATH (for example \`brew install poppler\` or \`apt-get install poppler-utils\`), then retry.`,
    };
  }

  if (!input.canExecuteHostCommands) {
    return {
      code: "permission_boundary",
      message:
        `Cannot inspect PDF ${path}: ${extractor} is installed, but this worker cannot execute it (run_shell is not mounted — a permission boundary, not a malformed file). ` +
        `Re-dispatch to a director that mounts run_shell, or grant this worker run_shell, then retry.`,
    };
  }

  return {
    code: "extractor_ready",
    message:
      `Cannot inspect PDF ${path} as text via read_file. ${extractor} is installed and this session can run host commands. ` +
      `Run \`${extractor} ${path} -\` via bash to extract text.`,
  };
}
