import { spawn } from "node:child_process";

// CI shards and `check:projects-dir-guard` pass bun-test path filters here.
// A zero-arg `bun test` walks the whole tree, including vendor/, so this
// script refuses to run without at least one path (not a flag).

const args = process.argv.slice(2);
const paths = args.filter((arg) => !arg.startsWith("-"));

if (paths.length === 0) {
  process.stderr.write(
    "test:paths requires at least one path filter (refusing a whole-tree scan of vendor/)\n",
  );
  process.exit(1);
}

const child = spawn("bun", ["test", "--randomize", "--seed", "424242", ...args], {
  stdio: "inherit",
});

child.on("exit", (code) => {
  process.exit(code ?? 1);
});
