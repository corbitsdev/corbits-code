import { CliRenderer } from "@opentui/core";

export function smokeOpenTUINativeLibrary(): void {
  const renderer = new CliRenderer(process.stdin, process.stdout, 1, 1, {
    useThread: false,
  });
  renderer.destroy();
}
