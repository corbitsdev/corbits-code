#!/usr/bin/env python3
# Drives tests/fixtures/rawmode-sigint/probe.ts inside a real forked pty
# (stdlib `pty`/`os`/`select`, no third-party deps) so the fixture's stdin
# is a genuine tty rather than a pipe -- `setRawMode` only has the raw-mode
# vs. cooked-mode distinction this test cares about on a real tty.
import os
import pty
import select
import sys
import time

def main() -> int:
    probe_path = sys.argv[1]
    pid, fd = pty.fork()
    if pid == 0:
        os.execvp("bun", ["bun", "run", probe_path])
        os._exit(127)

    time.sleep(1)
    os.write(fd, b"\x03")

    out = b""
    deadline = time.time() + 4
    while time.time() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.5)
        if fd not in ready:
            continue
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            break
        if not chunk:
            break
        out += chunk
        if b"NO_SIGINT_ON_CTRL_C" in out or b"GOT_SIGINT" in out:
            break

    try:
        os.kill(pid, 9)
    except OSError:
        pass
    os.waitpid(pid, 0)

    sys.stdout.write(out.decode(errors="replace"))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
