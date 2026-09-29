import { describe, expect, test } from "bun:test";
import {
  chunkLooksLikePdf,
  diagnoseBlockedFileInspection,
  inspectionKindFromFirstChunk,
  pathLooksLikePdf,
  PDF_EXTRACTOR_BIN,
} from "./file-inspection-diagnosis.js";

const PATH = "/tmp/report.pdf";

describe("PDF sniffing", () => {
  test("magic bytes classify as pdf regardless of suffix", () => {
    expect(chunkLooksLikePdf(Buffer.from("%PDF-1.7\n"))).toBe(true);
    expect(
      inspectionKindFromFirstChunk("notes.bin", Buffer.from("%PDF-1.4")),
    ).toBe("pdf");
  });

  test("a .pdf name with NUL and no magic is malformed; a text .pdf is not refused", () => {
    expect(pathLooksLikePdf("report.PDF")).toBe(true);
    expect(
      inspectionKindFromFirstChunk("report.pdf", Buffer.from("not-a-pdf\0")),
    ).toBe("pdf-malformed");
    expect(
      inspectionKindFromFirstChunk("report.pdf", Buffer.from("plain text")),
    ).toBeUndefined();
  });

  test("NUL without PDF markers is ordinary binary", () => {
    expect(
      inspectionKindFromFirstChunk("blob.bin", Buffer.from([0x41, 0x00, 0x42])),
    ).toBe("binary");
  });

  test("plain text is not an inspection block", () => {
    expect(
      inspectionKindFromFirstChunk("readme.txt", Buffer.from("hello\n")),
    ).toBeUndefined();
  });
});

describe("diagnoseBlockedFileInspection", () => {
  test("missing extractor names the capability and an install action", () => {
    const result = diagnoseBlockedFileInspection({
      path: PATH,
      kind: "pdf",
      extractorAvailable: false,
      canExecuteHostCommands: true,
    });
    expect(result.code).toBe("missing_extractor");
    expect(result.message).toContain("PDF");
    expect(result.message).toContain(PDF_EXTRACTOR_BIN);
    expect(result.message).toContain("Missing PDF extractor");
    expect(result.message.toLowerCase()).toContain("poppler");
    expect(result.message).toContain("not a malformed file");
    expect(result.message).not.toContain("permission boundary");
  });

  test("missing extractor wins over an unmounted shell (first gap)", () => {
    const result = diagnoseBlockedFileInspection({
      path: PATH,
      kind: "pdf",
      extractorAvailable: false,
      canExecuteHostCommands: false,
    });
    expect(result.code).toBe("missing_extractor");
  });

  test("installed extractor with no run_shell is a permission boundary", () => {
    const result = diagnoseBlockedFileInspection({
      path: PATH,
      kind: "pdf",
      extractorAvailable: true,
      canExecuteHostCommands: false,
    });
    expect(result.code).toBe("permission_boundary");
    expect(result.message).toContain("installed");
    expect(result.message).toContain("Permission boundary");
    expect(result.message).toContain("run_shell");
    expect(result.message).toContain("not a malformed file");
    expect(result.message.toLowerCase()).not.toContain("brew install");
  });

  test("installed extractor the worker can run names the bash extract command", () => {
    const result = diagnoseBlockedFileInspection({
      path: PATH,
      kind: "pdf",
      extractorAvailable: true,
      canExecuteHostCommands: true,
    });
    expect(result.code).toBe("extractor_ready");
    expect(result.message).toContain("bash");
    expect(result.message).toContain(`${PDF_EXTRACTOR_BIN} ${PATH} -`);
  });

  test("malformed PDF is not blamed on tooling or permission", () => {
    const result = diagnoseBlockedFileInspection({
      path: PATH,
      kind: "pdf-malformed",
      extractorAvailable: false,
      canExecuteHostCommands: false,
    });
    expect(result.code).toBe("malformed");
    expect(result.message).toContain("Malformed PDF");
    expect(result.message).toContain("not a missing extractor");
    expect(result.message).not.toContain("brew install");
    expect(result.message).not.toContain("grant this worker");
  });

  test("unreadable file is filesystem permission, not a worker-tool gap", () => {
    const result = diagnoseBlockedFileInspection({
      path: PATH,
      kind: "unreadable",
      extractorAvailable: true,
      canExecuteHostCommands: true,
    });
    expect(result.code).toBe("unreadable");
    expect(result.message).toContain("Unreadable file");
    expect(result.message).toContain("filesystem permission");
    expect(result.message).not.toContain("grant this worker");
    expect(result.message.toLowerCase()).not.toContain("poppler");
  });

  test("ordinary binary is not a missing-tool failure", () => {
    const result = diagnoseBlockedFileInspection({
      path: "/tmp/blob.bin",
      kind: "binary",
      extractorAvailable: false,
      canExecuteHostCommands: false,
    });
    expect(result.code).toBe("binary");
    expect(result.message).toContain("refusing to read binary file");
    expect(result.message).toContain("Not a missing-tool");
  });

  test("the cause leads so a 72-character collapsed preview still names the gap", () => {
    const missing = diagnoseBlockedFileInspection({
      path: "/very/long/workspace/path/to/a/nested/report.pdf",
      kind: "pdf",
      extractorAvailable: false,
      canExecuteHostCommands: true,
    });
    expect(missing.message.slice(0, 72).toLowerCase()).toContain("extractor");

    const permission = diagnoseBlockedFileInspection({
      path: "/very/long/workspace/path/to/a/nested/report.pdf",
      kind: "pdf",
      extractorAvailable: true,
      canExecuteHostCommands: false,
    });
    expect(permission.message.slice(0, 72).toLowerCase()).toContain(
      "permission",
    );

    const malformed = diagnoseBlockedFileInspection({
      path: "/very/long/workspace/path/to/a/nested/report.pdf",
      kind: "pdf-malformed",
      extractorAvailable: false,
      canExecuteHostCommands: false,
    });
    expect(malformed.message.slice(0, 72).toLowerCase()).toContain("malformed");
  });
});
