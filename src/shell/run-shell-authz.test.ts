import { describe, expect, test } from "bun:test";

import {
  commandHasRecursiveRm,
  expandShellSubjects,
  runShellAuthzBlockReason,
  segmentHasRecursiveRm,
} from "./run-shell-authz.js";

describe("recursive rm detection", () => {
  test("segmentHasRecursiveRm matches recursive flags only", () => {
    expect(segmentHasRecursiveRm("rm -rf build")).toBe(true);
    expect(segmentHasRecursiveRm("rm -r dist")).toBe(true);
    expect(segmentHasRecursiveRm("rm --recursive --force out")).toBe(true);
    expect(segmentHasRecursiveRm("rm -f stale.log")).toBe(false);
    expect(segmentHasRecursiveRm("git rm -rf file")).toBe(false);
  });

  test("commandHasRecursiveRm splits on chain boundaries", () => {
    expect(commandHasRecursiveRm("bun test && rm -rf ./tmp")).toBe(true);
    expect(commandHasRecursiveRm("ls; rm -rf node_modules")).toBe(true);
    expect(commandHasRecursiveRm("npm test")).toBe(false);
  });

  test("commandHasRecursiveRm peels shell -c and xargs wrappers", () => {
    expect(commandHasRecursiveRm("bash -c 'rm -rf build'")).toBe(true);
    expect(commandHasRecursiveRm('sh -c "rm -rf ./tmp"')).toBe(true);
    expect(commandHasRecursiveRm("zsh -c 'rm -rf node_modules'")).toBe(true);
    expect(commandHasRecursiveRm("/bin/bash -lc 'rm -rf dist'")).toBe(true);
    expect(commandHasRecursiveRm("echo build | xargs rm -rf")).toBe(true);
    expect(commandHasRecursiveRm("printf '%s\\n' tmp | xargs -n1 rm -rf")).toBe(true);
    expect(commandHasRecursiveRm("env bash -c 'rm -rf out'")).toBe(true);
    expect(commandHasRecursiveRm("bash -c 'echo hello'")).toBe(false);
    expect(commandHasRecursiveRm("bash -c 'rm -f stale.log'")).toBe(false);
  });

  test("commandHasRecursiveRm survives xargs feeding a shell -c payload", () => {
    // The quoted payload must survive the xargs peel intact: rejoining
    // dequoted tokens once re-split `-c 'rm -rf {}'` into fragments and lost
    // the classification.
    expect(commandHasRecursiveRm("xargs -I{} bash -c 'rm -rf {}'")).toBe(true);
    expect(commandHasRecursiveRm("echo x | xargs -I {} sh -c 'sudo rm -rf {}'")).toBe(true);
    expect(commandHasRecursiveRm("echo build | xargs -I{} bash -c 'rm -rf {}'")).toBe(true);
    expect(commandHasRecursiveRm("find . -name tmp | xargs -n1 sh -c 'rm -rf \"$0\"'")).toBe(true);
    expect(commandHasRecursiveRm("echo hi | xargs -I{} bash -c 'echo {}'")).toBe(false);
  });

  test("authz hard-blocks catastrophic rm behind xargs + shell -c", () => {
    expect(runShellAuthzBlockReason("echo / | xargs -I{} bash -c 'rm -rf {}'")).toBeUndefined();
    expect(runShellAuthzBlockReason("xargs -I{} bash -c 'rm -rf /'")).toMatch(
      /Destructive command blocked/,
    );
  });

  test("an embedded apostrophe in the payload does not drop the dangerous tail", () => {
    // The rejoin must round-trip through tokenize() (no backslash escapes), so a
    // payload token containing a literal quote is re-wrapped in the other quote
    // character rather than the POSIX '\'' idiom, which would re-split it.
    const cmd = "echo x | xargs -I{} sh -c \"don't stop; rm -rf /\"";
    expect(commandHasRecursiveRm(cmd)).toBe(true);
    expect(runShellAuthzBlockReason(cmd)).toMatch(/Destructive command blocked/);
  });

  test("authz still hard-blocks catastrophic recursive rm", () => {
    expect(runShellAuthzBlockReason("rm -rf /")).toMatch(/Destructive command blocked/);
    expect(runShellAuthzBlockReason("rm -rf node_modules")).toBeUndefined();
  });

  test("authz hard-blocks catastrophic recursive rm inside shell -c wrappers", () => {
    expect(runShellAuthzBlockReason("bash -c 'rm -rf /'")).toMatch(/Destructive command blocked/);
    expect(runShellAuthzBlockReason("sh -c \"rm -rf ~\"")).toMatch(/Destructive command blocked/);
    expect(runShellAuthzBlockReason("bash -c 'rm -rf $HOME'")).toMatch(/Destructive command blocked/);
    // Non-catastrophic recursive rm remains for the permission gate, not authz hard-deny.
    expect(runShellAuthzBlockReason("bash -c 'rm -rf node_modules'")).toBeUndefined();
  });
});

describe("stdin-blocking with quote-aware tokenizeSegment", () => {
  test("unquoted readers with no file operand are blocked", () => {
    expect(runShellAuthzBlockReason("cat")).toMatch(/standard input/);
    expect(runShellAuthzBlockReason("grep pattern")).toMatch(/standard input/);
    expect(runShellAuthzBlockReason("tail -n 50")).toMatch(/standard input/);
  });

  test("unquoted readers with a file operand are allowed", () => {
    expect(runShellAuthzBlockReason("cat foo")).toBeUndefined();
    expect(runShellAuthzBlockReason("grep pat file")).toBeUndefined();
    expect(runShellAuthzBlockReason("tail -n 50 file.log")).toBeUndefined();
  });

  test("quoted path with spaces counts as one file operand", () => {
    // Naive whitespace split would see `"my` and `file.txt"` as two tokens and
    // still allow; quote-aware tokenize keeps one operand either way. The
    // important case is the single-file form must not hang.
    expect(runShellAuthzBlockReason('cat "my file.txt"')).toBeUndefined();
    expect(runShellAuthzBlockReason("cat 'my file.txt'")).toBeUndefined();
  });

  test("quoted grep pattern with spaces is one operand (still needs a file)", () => {
    // Naive split of `grep 'a b'` yields tokens ["grep", "'a", "b'"] — two
    // operands — and wrongly allows a command that would hang on stdin.
    expect(runShellAuthzBlockReason("grep 'a b'")).toMatch(/standard input/);
    expect(runShellAuthzBlockReason('grep "a b"')).toMatch(/standard input/);
    expect(runShellAuthzBlockReason("grep 'a b' file")).toBeUndefined();
    expect(runShellAuthzBlockReason('grep "a b" file')).toBeUndefined();
  });

  test("env assignment prefixes still strip before operand counting", () => {
    expect(runShellAuthzBlockReason('FOO=1 cat "x y"')).toBeUndefined();
    expect(runShellAuthzBlockReason("FOO=1 cat")).toMatch(/standard input/);
    expect(runShellAuthzBlockReason("FOO=1 BAR=2 grep 'a b'")).toMatch(/standard input/);
    expect(runShellAuthzBlockReason("FOO=1 grep 'a b' file")).toBeUndefined();
  });

  test("pipeline heads still apply; downstream stages do not", () => {
    expect(runShellAuthzBlockReason("echo hi | cat")).toBeUndefined();
    expect(runShellAuthzBlockReason("git log --oneline | tail -20")).toBeUndefined();
  });
});
// Hard-deny must see inside env -S / --split-string the same way expandShellSubjects
// peels bash -c and xargs. Auto-mode already classified these; authz previously left
// the payload inside one quoted token and allowed catastrophic rm past the gate.
describe("authz hard-deny peels env -S / --split-string payloads", () => {
  const destructive = /Destructive command blocked/;

  test("D1: env -S with assignment-bearing catastrophic rm is blocked", () => {
    expect(runShellAuthzBlockReason(`env -S "FOO=bar rm -rf /"`)).toMatch(destructive);
    expect(commandHasRecursiveRm(`env -S "FOO=bar rm -rf /"`)).toBe(true);
  });

  test("D2: env --split-string=PAYLOAD form is blocked", () => {
    expect(runShellAuthzBlockReason(`env --split-string="FOO=bar rm -rf /"`)).toMatch(destructive);
  });

  test("D3: env --split-string separate-arg form is blocked", () => {
    expect(runShellAuthzBlockReason(`env --split-string "FOO=bar rm -rf /"`)).toMatch(destructive);
  });

  test("D4: clustered short flags with S (-iS) are blocked", () => {
    expect(runShellAuthzBlockReason(`env -iS "FOO=bar rm -rf /"`)).toMatch(destructive);
  });

  test("D5: nested bash -c inside env -S is blocked", () => {
    expect(runShellAuthzBlockReason(`env -S "FOO=bar bash -c 'rm -rf /'"`)).toMatch(destructive);
  });

  test("D6: nested sh -c with mixed quotes inside env -S is blocked", () => {
    // tokenize() has no backslash escapes — nest by alternating quote styles.
    expect(runShellAuthzBlockReason(`env -S 'FOO=bar sh -c "rm -rf ~"'`)).toMatch(destructive);
  });

  test("D7: path-qualified /usr/bin/env -S is blocked", () => {
    expect(runShellAuthzBlockReason(`/usr/bin/env -S "FOO=bar rm -rf /"`)).toMatch(destructive);
  });

  test("D8: env -S without assignment still peels catastrophic rm", () => {
    // Peel-all, not assignment-only: the payload must not stay invisible just
    // because it lacks a leading NAME=value.
    expect(runShellAuthzBlockReason(`env -S "rm -rf /"`)).toMatch(destructive);
    expect(commandHasRecursiveRm(`env -S "rm -rf /"`)).toBe(true);
  });

  test("D9: outer shell assignment plus inner env -S is blocked", () => {
    expect(runShellAuthzBlockReason(`FOO=1 env -S "BAR=2 rm -rf /"`)).toMatch(destructive);
  });

  test("D10: catastrophic env -S in a chain still blocks the whole command", () => {
    expect(runShellAuthzBlockReason(`env -S "FOO=bar rm -rf /" && echo ok`)).toMatch(destructive);
  });

  test("D11: xargs feeding env -S peels through to catastrophic rm", () => {
    expect(runShellAuthzBlockReason(`echo x | xargs -I{} env -S "FOO=bar rm -rf /"`)).toMatch(
      destructive,
    );
  });

  test("B1: non-catastrophic recursive rm inside env -S is not hard-denied", () => {
    // Gate may still ask (recursive-rm); authz hard-deny is intentionally narrower.
    expect(runShellAuthzBlockReason(`env -S "FOO=bar rm -rf node_modules"`)).toBeUndefined();
    expect(commandHasRecursiveRm(`env -S "FOO=bar rm -rf node_modules"`)).toBe(true);
  });

  test("B2: benign env -S with assignment is not hard-denied", () => {
    expect(runShellAuthzBlockReason(`env -S "FOO=bar npm start"`)).toBeUndefined();
  });

  test("B3: env -S without assignment and no install pattern is not hard-denied", () => {
    expect(runShellAuthzBlockReason(`env -S "npm start"`)).toBeUndefined();
  });

  test("B4: fully benign env -S is not hard-denied", () => {
    expect(runShellAuthzBlockReason(`env -S "echo hello world"`)).toBeUndefined();
  });

  test("B5: non-S env FOO=bar form still hard-blocks catastrophic rm", () => {
    expect(runShellAuthzBlockReason("env FOO=bar rm -rf /")).toMatch(destructive);
  });

  test("B6: bare bash -c catastrophic rm still hard-blocks (regression)", () => {
    expect(runShellAuthzBlockReason("bash -c 'rm -rf /'")).toMatch(destructive);
  });

  test("N1: nested env -S payloads are blocked within peel depth", () => {
    // Alternating quotes so naive tokenize keeps each -S payload intact.
    expect(runShellAuthzBlockReason(`env -S "FOO=bar env -S 'BAZ=1 rm -rf /'"`)).toMatch(
      destructive,
    );
  });

  test("N2: deep nested env -S does not hang under the peel depth cap", () => {
    // Two-deep alternating quotes peels fully (covers recursion). A long
    // unpeelable nest must still return without hanging or throwing — the
    // depth cap / seen-set are the backstop, not perfect quote reconstruction.
    const twoDeep = `env -S "A=1 env -S 'B=2 rm -rf /'"`;
    expect(runShellAuthzBlockReason(twoDeep)).toMatch(destructive);

    // Pathological depth: many nested env -S tokens without valid quote
    // nesting. Must not loop forever.
    const deep = "env -S ".repeat(8) + `"rm -rf /"`;
    expect(() => runShellAuthzBlockReason(deep)).not.toThrow();
  });

  test("Q1: single-quoted env -S payload is blocked", () => {
    expect(runShellAuthzBlockReason(`env -S 'FOO=bar rm -rf /'`)).toMatch(destructive);
  });

  test("Q2: file-mutation inside env -S is not an authz hard-deny", () => {
    // Auto may deny (file-mutation); authz only blocks catastrophic / blocked patterns.
    expect(runShellAuthzBlockReason(`env -S "FOO=bar sh -c 'echo x > .env'"`)).toBeUndefined();
  });

  test("Q3: sensitive-path inside env -S is not an authz hard-deny", () => {
    expect(runShellAuthzBlockReason(`env -S "FOO=bar cat ~/.aws/credentials"`)).toBeUndefined();
  });

  test("Q4: embedded apostrophe in nested shell -c still reaches catastrophic rm", () => {
    // Outer single quotes hold a double-quoted -c body that itself contains `'`.
    const cmd = `env -S 'FOO=bar sh -c "don't; rm -rf /"'`;
    expect(commandHasRecursiveRm(cmd)).toBe(true);
    expect(runShellAuthzBlockReason(cmd)).toMatch(destructive);
  });

  test("Q5: opaque or empty env -S payload does not invent a hard-deny", () => {
    expect(runShellAuthzBlockReason(`env -S "$CMD"`)).toBeUndefined();
    expect(runShellAuthzBlockReason(`env -S ""`)).toBeUndefined();
  });
});

// Security-review peel gaps: glued -S forms, trailing utility after the -S
// argument, value-flag soup before -S, and open-ended / never-terminating /
// stdin hard-deny through expanded subjects (not just catastrophic rm).
describe("authz hard-deny peels glued and trailing env -S forms", () => {
  const openEnded = /Open-ended shell search blocked/;
  const neverTerm = /Never-terminating command blocked/;
  const stdinHang = /reads standard input/;
  const destructive = /Destructive command blocked/;

  test("unmodeled -S backslash escapes make the payload opaque, never garbled", () => {
    // GNU env's -S escape grammar (\\, \", \n, \#, ...) is wider than the \_
    // separator this parser models. A pass-through would produce garbled
    // subjects that miss the hard-deny matchers; opaque routes to ask instead.
    expect(expandShellSubjects(`env -S "rm \\-rf \\/"`).opaque).toBe(true);
    expect(expandShellSubjects(`env -S 'x' && env -S "rm -rf \\"/\\""`).opaque).toBe(true);
    expect(runShellAuthzBlockReason(`env -S "rm \\-rf /"`)).toBeUndefined();
    // The modeled separator still expands rather than going opaque.
    expect(expandShellSubjects(`env -S "find\\_/"`).opaque).toBe(false);
  });

  test("G1: open-ended find inside quoted -S is hard-denied", () => {
    expect(runShellAuthzBlockReason(`env -S "find /"`)).toMatch(openEnded);
    expect(expandShellSubjects(`env -S "find /"`).subjects).toContain("find /");
  });

  test("open-ended block reason cites OOM risk rather than tool-routing purity", () => {
    const reason = runShellAuthzBlockReason("find . -name '*.ts'");
    expect(reason).toMatch(openEnded);
    expect(reason).toMatch(/OOM the host/);
    expect(reason).toMatch(/walk huge trees/);
    expect(reason).toMatch(/Prefer the bounded grep\/search_files tools/);
    expect(reason).toMatch(/not substitute another unbounded walk \(fd, ls -R, scripted os\.walk\)/);
    expect(reason).not.toMatch(/Do not use find/);
  });

  test("G2: never-terminating watch inside quoted -S is hard-denied", () => {
    expect(runShellAuthzBlockReason(`env -S "watch ls"`)).toMatch(neverTerm);
    expect(expandShellSubjects(`env -S "watch ls"`).subjects).toContain("watch ls");
  });

  test("G3: bare cat inside quoted -S is hard-denied as stdin hang", () => {
    expect(runShellAuthzBlockReason(`env -S "cat"`)).toMatch(stdinHang);
    expect(expandShellSubjects(`env -S "cat"`).subjects).toContain("cat");
  });

  test("G4: glued -S\"find /\" peels and hard-denies", () => {
    expect(runShellAuthzBlockReason(`env -S"find /"`)).toMatch(openEnded);
    expect(expandShellSubjects(`env -S"find /"`).subjects.some((s) => /\bfind\b/.test(s))).toBe(
      true,
    );
  });

  test("G5: glued -Sfind peels and hard-denies", () => {
    expect(runShellAuthzBlockReason(`env -Sfind`)).toMatch(openEnded);
    expect(expandShellSubjects(`env -Sfind`).subjects.some((s) => s === "find" || s.startsWith("find "))).toBe(
      true,
    );
  });

  test("G6: trailing utility after -S arg is visible (env -S FOO=bar find /)", () => {
    const cmd = `env -S FOO=bar find /`;
    expect(runShellAuthzBlockReason(cmd)).toMatch(openEnded);
    const subjects = expandShellSubjects(cmd).subjects;
    expect(subjects.some((s) => /\bfind\b/.test(s) && s.includes("/"))).toBe(true);
  });

  test("G7: soft-allow non-catastrophic rm inside -S is not hard-denied", () => {
    expect(runShellAuthzBlockReason(`env -S "rm -rf node_modules"`)).toBeUndefined();
    expect(commandHasRecursiveRm(`env -S "rm -rf node_modules"`)).toBe(true);
  });

  test("G8: soft-deny catastrophic rm inside -S is hard-denied", () => {
    expect(runShellAuthzBlockReason(`env -S "rm -rf /"`)).toMatch(destructive);
  });

  test("G9: flag soup before -S still peels (env -i -u HOME -S)", () => {
    expect(runShellAuthzBlockReason(`env -i -u HOME -S "find /"`)).toMatch(openEnded);
    expect(runShellAuthzBlockReason(`/usr/bin/env -S "find /"`)).toMatch(openEnded);
  });

  test("G10: glued --split-string without equals peels when one token", () => {
    // tokenize keeps --split-string"find /" as one token without `=`.
    expect(runShellAuthzBlockReason(`env --split-string"find /"`)).toMatch(openEnded);
  });

  test("G11: clustered -iS with next-token payload still peels", () => {
    expect(runShellAuthzBlockReason(`env -iS "find /"`)).toMatch(openEnded);
    expect(runShellAuthzBlockReason(`env -Si "find /"`)).toMatch(openEnded);
  });

  test("G12: transparent env --argv0 peels past the value to open-ended find", () => {
    // Shared value-flag walker must skip --argv0 NAME so hard-deny sees `find /`.
    expect(runShellAuthzBlockReason(`env --argv0 name find /`)).toMatch(openEnded);
    expect(runShellAuthzBlockReason(`env --argv0=name find /`)).toMatch(openEnded);
    expect(expandShellSubjects(`env --argv0 name find /`).subjects).toContain("find /");
  });

  test("G13: empty/whitespace -S payload with trailing utility is hard-denied", () => {
    // Runtime still executes the trailing utility; do not opaque-drop it.
    expect(runShellAuthzBlockReason(`env -S " " find /`)).toMatch(openEnded);
    expect(runShellAuthzBlockReason(`env -S "   " rm -rf /`)).toMatch(destructive);
    expect(runShellAuthzBlockReason(`env -S" " find /`)).toMatch(openEnded);
    expect(runShellAuthzBlockReason(`env --split-string= find /`)).toMatch(openEnded);
  });

  test("G14: end-of-options marker before utility inside -S is hard-denied", () => {
    expect(runShellAuthzBlockReason(`env -S "-- find /"`)).toMatch(openEnded);
    expect(runShellAuthzBlockReason(`env -S "-- rm -rf /"`)).toMatch(destructive);
    expect(runShellAuthzBlockReason(`env -S -- find /`)).toMatch(openEnded);
    expect(runShellAuthzBlockReason(`env -S - find /`)).toMatch(openEnded);
    expect(runShellAuthzBlockReason(`env -S "-- cat"`)).toMatch(stdinHang);
  });

  test("G15: env flags inside -S payload are skipped to the utility", () => {
    expect(runShellAuthzBlockReason(`env -S -v find /`)).toMatch(openEnded);
    expect(runShellAuthzBlockReason(`env -S-v find /`)).toMatch(openEnded);
    expect(runShellAuthzBlockReason(`env -S '-i find /'`)).toMatch(openEnded);
    expect(runShellAuthzBlockReason(`env -S -v rm -rf /`)).toMatch(destructive);
    expect(runShellAuthzBlockReason(`env -S -v cat`)).toMatch(stdinHang);
  });

  test("G16: env -S quoted rm flags still hard-deny catastrophic targets", () => {
    expect(runShellAuthzBlockReason(`env -S "rm '-rf' '/'"`)).toMatch(destructive);
    expect(runShellAuthzBlockReason(`env -S 'rm "-rf" "/"'`)).toMatch(destructive);
  });

  test("G17: env -S backslash-underscore is an argv separator", () => {
    // Outside env's own quotes, `\_` separates argv (`rm\_-rf\_/` → rm -rf /).
    expect(runShellAuthzBlockReason(`env -S "rm\\_-rf\\_/"`)).toMatch(destructive);
  });

  test("G18: Darwin -P altpath is a value flag so -S still peels", () => {
    expect(runShellAuthzBlockReason(`env -P /usr/bin -S "find /"`)).toMatch(openEnded);
    expect(runShellAuthzBlockReason(`env -P /bin -S "rm -rf /"`)).toMatch(destructive);
  });
});
