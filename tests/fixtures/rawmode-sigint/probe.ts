// Fixture for tests/integration/rawmode-sigint.test.ts. Proves, on the real
// Bun runtime rather than by assumption, whether a Ctrl+C keypress (0x03)
// generates a SIGINT deliverable to process.on("SIGINT") while stdin is in
// raw mode — the empirical claim src/index.ts's installSignalHandlers
// depends on to leave the in-session double-tap-to-quit gesture untouched.
process.stdin.setRawMode(true);
process.on("SIGINT", () => {
  process.stdout.write("GOT_SIGINT\n");
  process.exit(0);
});
process.stdin.resume();
process.stdin.on("data", (chunk: Buffer) => {
  if (chunk.includes(0x03)) process.stdout.write("GOT_CTRL_C_BYTE\n");
});
setTimeout(() => {
  process.stdout.write("NO_SIGINT_ON_CTRL_C\n");
  process.exit(0);
}, 3000);
