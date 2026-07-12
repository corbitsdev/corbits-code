import { test, expect } from "bun:test";
import { createSyncOutputWriter, supportsSynchronizedOutput } from "./sync-output.js";

function fakeStream(isTTY: boolean) {
  const writes: string[] = [];
  const stream = {
    isTTY,
    write: (chunk: string) => {
      writes.push(chunk);
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  return { stream, writes };
}

test("supportsSynchronizedOutput reflects the stream's TTY capability", () => {
  expect(supportsSynchronizedOutput(fakeStream(true).stream)).toBe(true);
  expect(supportsSynchronizedOutput(fakeStream(false).stream)).toBe(false);
});

test("withSyncOutput wraps a TTY write in begin/end synchronized-update sequences", () => {
  const { stream, writes } = fakeStream(true);
  const withSyncOutput = createSyncOutputWriter(stream);

  withSyncOutput(() => stream.write("payload"));

  expect(writes).toEqual(["\x1b[?2026h", "payload", "\x1b[?2026l"]);
});

test("withSyncOutput skips the wrapper entirely on a non-TTY stream", () => {
  const { stream, writes } = fakeStream(false);
  const withSyncOutput = createSyncOutputWriter(stream);

  withSyncOutput(() => stream.write("payload"));

  expect(writes).toEqual(["payload"]);
});

test("withSyncOutput does not double-wrap nested calls", () => {
  const { stream, writes } = fakeStream(true);
  const withSyncOutput = createSyncOutputWriter(stream);

  withSyncOutput(() => {
    stream.write("outer-start");
    withSyncOutput(() => stream.write("inner"));
    stream.write("outer-end");
  });

  expect(writes).toEqual(["\x1b[?2026h", "outer-start", "inner", "outer-end", "\x1b[?2026l"]);
});
