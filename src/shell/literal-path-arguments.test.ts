import { describe, expect, test } from "bun:test";
import {
  commandReferencesSensitivePath,
  inspectShellSecretReference,
} from "../plugins/secret-guard-plugin.js";
import {
  literalPathArgumentCommands,
  literalPathArguments,
  nativeShellDialect,
  type ShellDialect,
} from "./literal-path-arguments.js";
import {
  FILE_OPTION_GRAMMARS,
  isLongFileOption,
} from "./file-option-grammar.js";

describe("isLongFileOption", () => {
  test("accepts only unique GNU sed abbreviations", () => {
    const sed = FILE_OPTION_GRAMMARS["sed"];
    if (sed === undefined) throw new Error("missing sed option grammar");
    expect(isLongFileOption("--fi=.envrc", sed)).toBe(true);
    expect(isLongFileOption("--fil", sed)).toBe(true);
    expect(isLongFileOption("--file=.envrc", sed)).toBe(true);
    expect(isLongFileOption("--f=.envrc", sed)).toBe(false);
    expect(isLongFileOption("--fo=.envrc", sed)).toBe(false);
    expect(isLongFileOption("--follow-symlinks=.envrc", sed)).toBe(false);
  });

  test("keeps other utility grammars exact", () => {
    const grep = FILE_OPTION_GRAMMARS["grep"];
    if (grep === undefined) throw new Error("missing grep option grammar");
    expect(isLongFileOption("--file=.envrc", grep)).toBe(true);
    expect(isLongFileOption("--fil=.envrc", grep)).toBe(false);
  });
});

describe("nativeShellDialect", () => {
  test("selects cmd only for Windows", () => {
    expect(nativeShellDialect("win32")).toBe("cmd");
    expect(nativeShellDialect("darwin")).toBe("posix");
    expect(nativeShellDialect("linux")).toBe("posix");
  });
});

describe("literalPathArguments", () => {
  const cases: {
    dialect: ShellDialect;
    command: string;
    expected: string[];
  }[] = [
    {
      dialect: "posix",
      command: String.raw`cat .env''rc 'dir/\.envrc' "dir/\.envrc"`,
      expected: [
        "cat",
        ".envrc",
        String.raw`dir/\.envrc`,
        String.raw`dir/\.envrc`,
      ],
    },
    {
      dialect: "posix",
      command: String.raw`cat config\ .envrc .envrc\ copy`,
      expected: ["cat", "config .envrc", ".envrc copy"],
    },
    {
      dialect: "posix",
      command: 'printf "a\\$b\\`c\\"d\\\\e\\q"',
      expected: ["printf", 'a$b`c"d\\e\\q'],
    },
    {
      dialect: "posix",
      command: "cat .envrc; grep x /repo/.flaskenv\nwc -l README.md",
      expected: [
        "cat",
        ".envrc",
        "grep",
        "x",
        "/repo/.flaskenv",
        "wc",
        "-l",
        "README.md",
      ],
    },
    {
      dialect: "posix",
      command: 'echo `cat .envrc`; echo "`cat .flaskenv`"',
      expected: ["echo", "cat", ".envrc", "echo", "cat", ".flaskenv"],
    },
    {
      dialect: "posix",
      command: 'echo $(cat .envrc); echo "$(cat .flaskenv)"',
      expected: ["echo", "cat", ".envrc", "echo", "cat", ".flaskenv"],
    },
    {
      dialect: "posix",
      command: "echo '`cat .envrc`' '$(cat .flaskenv)'",
      expected: ["echo", "`cat .envrc`", "$(cat .flaskenv)"],
    },
    {
      dialect: "cmd",
      command: String.raw`type "C:\repo dir\.envrc" dir\ .flaskenv`,
      expected: ["type", String.raw`C:\repo dir\.envrc`, "dir\\", ".flaskenv"],
    },
    {
      dialect: "cmd",
      command: String.raw`type .env^rc .flask^env ^.envrc ordinary;.envrc`,
      expected: ["type", ".envrc", ".flaskenv", ".envrc", "ordinary;.envrc"],
    },
    {
      dialect: "cmd",
      command: "type .envrc&echo ok\r\ntype .flaskenv",
      expected: ["type", ".envrc", "echo", "ok", "type", ".flaskenv"],
    },
    {
      dialect: "cmd",
      command: "type .env^\nrc",
      expected: ["type", ".envrc"],
    },
    {
      dialect: "cmd",
      command: "type .env^\r\nrc",
      expected: ["type", ".envrc"],
    },
  ];

  for (const { dialect, command, expected } of cases) {
    test(`${dialect}: ${command}`, () => {
      expect(literalPathArguments(command, dialect)).toEqual(expected);
    });
  }
});

describe("literalPathArgumentCommands", () => {
  test("preserves POSIX simple-command boundaries", () => {
    expect(
      literalPathArgumentCommands(
        "echo grep --file=.envrc; grep --file=.flaskenv needle",
        "posix",
      ),
    ).toEqual([
      ["echo", "grep", "--file=.envrc"],
      ["grep", "--file=.flaskenv", "needle"],
    ]);
  });

  test("represents brace groups and reserved-word negation as control prefixes", () => {
    expect(
      literalPathArgumentCommands(
        "{ grep -f.envrc needle; } && ! sed -f.flaskenv input",
        "posix",
      ),
    ).toEqual([
      ["grep", "-f.envrc", "needle"],
      ["sed", "-f.flaskenv", "input"],
    ]);
  });

  test("preserves non-reserved braces and exclamation marks as words", () => {
    expect(
      literalPathArgumentCommands("printf %s {word} !word", "posix"),
    ).toEqual([["printf", "%s", "{word}", "!word"]]);
  });
});

const classificationCases: Record<
  ShellDialect,
  { ask: string[]; allow: string[] }
> = {
  posix: {
    ask: [
      "cat .envrc",
      "cat /repo/.flaskenv",
      "cat '.envrc'",
      'cat "/repo/.flaskenv"',
      "cat .env''rc",
      "bun --env-file=.envrc run app.ts",
      "FILE=.envrc cat $FILE",
      "env FILE=.envrc sh -c 'cat \"$FILE\"'",
      "/usr/bin/env FILE=.flaskenv sh -c 'cat \"$FILE\"'",
      "env -i FILE=.envrc sh -c 'cat \"$FILE\"'",
      "command env FILE=.flaskenv sh -c 'cat \"$FILE\"'",
      "grep --file=.envrc needle",
      "env grep --file=.envrc needle",
      "env -i grep --file=.flaskenv needle",
      "env -u OLD FILE=.envrc grep needle README.md",
      "command -p grep --file=.envrc needle",
      "nice -n 5 grep --file=.envrc needle",
      "timeout 5 dd if=.flaskenv of=/tmp/copy",
      "time -p grep --file=.envrc needle",
      "time -- dd if=.flaskenv of=/tmp/copy",
      "timeout .5s grep --file=.envrc needle",
      "timeout inf dd if=.flaskenv of=/tmp/copy",
      "env -- FILE=.envrc cat README.md",
      "env -i -- FILE=.flaskenv cat README.md",
      "grep -f.envrc needle",
      "grep -if.envrc needle",
      "sed -f.envrc input.txt",
      "sed -nf.envrc input.txt",
      "sed -Enf.flaskenv input.txt",
      "sed -f .envrc input.txt",
      "/usr/bin/sed --file=.flaskenv input.txt",
      "sed --fi=.envrc input.txt",
      "sed --fil=.flaskenv input.txt",
      "sed --fi .envrc input.txt",
      "sed --fil .flaskenv input.txt",
      "env awk -f.flaskenv input.txt",
      "awk --file .envrc input.txt",
      'bash -c "grep --file=.envrc needle"',
      "xargs grep --file=.envrc needle",
      'env -S "grep --file=.envrc needle"',
      "dd if=.envrc of=/tmp/copy",
      "dd if=/tmp/input of=.flaskenv",
      "echo `cat .envrc`",
      'echo "`cat .flaskenv`"',
      "echo $(cat .envrc)",
      'echo "$(cat .flaskenv)"',
      "echo ok; grep --file=.envrc needle",
      "echo ok && dd if=.flaskenv of=/tmp/copy",
    ],
    allow: [
      "cat C:.envrc",
      "cat ordinary=.envrc",
      String.raw`cat config\ .envrc`,
      String.raw`cat .envrc\ copy`,
      String.raw`cat 'dir/\.envrc'`,
      String.raw`cat "dir/\.envrc"`,
      'cat "ordinary .envrc"',
      "cat .env.example",
      "cat .env.sample",
      "cat .env.template",
      "cat .env.dist",
      "cat .ENV",
      "cat .EnVrC",
      "cat .FLASKENV",
      "grep.exe --file=.envrc needle",
      "echo grep --file=.envrc",
      "echo sed -f.envrc",
      "echo awk --file=.flaskenv",
      "mysed -f.envrc input.txt",
      "awk-helper -f.flaskenv input.txt",
      "grep -Xf.envrc needle",
      "grep -ef.envrc input.txt",
      "sed -if.envrc input.txt",
      "sed --f=.envrc input.txt",
      "sed --fo=.envrc input.txt",
      "sed --follow-symlinks=.envrc input.txt",
      "grep --fil=.envrc needle",
      "sed --fil=.env.example input.txt",
      "awk -Ff.envrc input.txt",
      "echo dd if=.flaskenv",
      "echo env FILE=.envrc",
      "/tmp/env FILE=.envrc echo ok",
      "echo 'env grep --file=.envrc'",
      "printf '%s' 'nice -n 5 grep --file=.envrc'",
      "echo '`cat .envrc`'",
      "echo '$(cat .flaskenv)'",
      "command -v grep --file=.envrc",
      "command -p -v grep --file=.envrc",
      "command -pv grep --file=.envrc",
      "env --help grep --file=.envrc",
      "nice --help grep --file=.envrc",
      "timeout --help grep --file=.envrc",
    ],
  },
  cmd: {
    ask: [
      String.raw`type dir\.envrc`,
      String.raw`type C:\repo\.flaskenv`,
      String.raw`type \\server\share\.envrc`,
      String.raw`type C:\repo/mixed\.flaskenv`,
      String.raw`type "C:\repo dir\.envrc"`,
      String.raw`type dir\ .envrc`,
      "type C:.envrc",
      "type D:.flaskenv",
      "type .env^rc",
      "type .flask^env",
      "type ^.envrc",
      "bun --env-file=.envrc run app.ts",
      "FILE=.envrc type README.md",
      "grep --file=.envrc needle",
      "dd if=.envrc of=NUL",
      "grep.exe --file=.envrc needle",
      "grep.exe -f.envrc needle",
      "grep.cmd -f.envrc needle",
      "grep.com -f.envrc needle",
      "grep.bat -f.envrc needle",
      String.raw`C:\tools\grep.exe -f.envrc needle`,
      "@GREP.EXE -f.envrc needle",
      "@EGREP.EXE -Jf.envrc needle",
      String.raw`C:\tools\fgrep.cmd -2f.flaskenv needle`,
      "sed.exe -f.envrc input.txt",
      "@AWK.CMD --file=.flaskenv input.txt",
      String.raw`C:\tools\sed.com -f .envrc input.txt`,
      "dd.exe if=.flaskenv of=NUL",
      "@grep.exe --file=.envrc needle",
      "@DD.EXE if=.flaskenv of=NUL",
      "echo ok & grep.exe --file=.envrc needle",
      "type .ENV",
      "type .EnV.LoCaL",
      "type .EnVrC",
      String.raw`type C:\.FLASKENV`,
      String.raw`type C:\repo\.corbits.\permissions.json`,
      String.raw`type C:\repo\.aws.\credentials`,
      String.raw`type C:\repo\.config\gcloud.\credentials.db`,
      "type %SECRET_PATH%",
      "type !SECRET_PATH!",
      'type ".env "',
      "type .envrc.",
      "type .flaskenv::$DATA",
      "type .EnV.LoCaL::$data",
      "type .env^\nrc",
      "type .env^\r\nrc",
    ],
    allow: [
      "type ordinary=.envrc",
      "type ordinary;.envrc",
      String.raw`type dir\'.envrc`,
      "type dir` .envrc-copy",
      'type "ordinary .envrc"',
      "type .envrc-copy",
      "type .flaskenv.bak",
      "type .env.example",
      "type .env.sample",
      "type .env.template",
      "type .env.dist",
      "echo grep.exe --file=.envrc",
      "mygrep.exe --file=.envrc needle",
      "mygrep.exe -f.envrc needle",
      "grep.exe-helper -f.envrc needle",
      "mysed.exe -f.envrc input.txt",
      "awk.exe-helper -f.flaskenv input.txt",
      "echo sed.exe -f.envrc",
      "dd.exe-helper if=.flaskenv of=NUL",
      "echo ok; grep.exe --file=.envrc needle",
      "type .ENV.EXAMPLE",
      "type .EnV.SaMpLe",
      "type .FLASKENV.bak",
      "type .env.example.",
      "type .env.sample::$DATA",
      "type .envrc:backup",
      String.raw`type \\?\C:\repo\.corbits.\permissions.json`,
    ],
  },
};

for (const dialect of ["posix", "cmd"] as const) {
  describe(`commandReferencesSensitivePath (${dialect})`, () => {
    for (const command of classificationCases[dialect].ask) {
      test(`asks: ${command}`, () => {
        expect(
          commandReferencesSensitivePath(command, process.cwd(), dialect),
        ).toBeDefined();
      });
    }

    for (const command of classificationCases[dialect].allow) {
      test(`allows: ${command}`, () => {
        expect(
          commandReferencesSensitivePath(command, process.cwd(), dialect),
        ).toBeUndefined();
      });
    }
  });
}

describe("inspectShellSecretReference", () => {
  test("decodes bounded ANSI-C quoted path literals", () => {
    expect(literalPathArguments("cat $'.envrc'", "posix")).toEqual([
      "cat",
      ".envrc",
    ]);
    for (const command of [
      "cat $'.envrc'",
      "cat $'.flaskenv'",
      "bash -c \"cat \\$'.envrc'\"",
      "bash -lc \"cat \\$'.envrc'\"",
      "bash -lc \"cat \\$'.flaskenv'\"",
    ]) {
      expect(inspectShellSecretReference(command)).toMatchObject({
        reference: expect.any(String),
        opaque: false,
      });
    }
  });

  test("reconstructs clustered bash command payloads at exact fidelity", () => {
    for (const [command, reference] of [
      ["bash -lc \"cat \\$'.envrc'\"", ".envrc"],
      ["bash -lc \"cat \\$'.flaskenv'\"", ".flaskenv"],
    ] as const) {
      expect(inspectShellSecretReference(command)).toMatchObject({
        reference,
        opaque: false,
      });
    }
  });

  test("fails closed on ANSI-C escapes that cannot be decoded safely", () => {
    expect(inspectShellSecretReference("cat $'notes\\cQ'")).toEqual({
      reference: undefined,
      opaque: true,
    });
  });

  test("keeps ordinary ANSI-C strings and single-quoted dollar text benign", () => {
    for (const command of ["printf '%s' $'hello\\n'", "cat '$'.envrc"]) {
      expect(inspectShellSecretReference(command)).toEqual({
        reference: undefined,
        opaque: false,
      });
    }
  });

  test("scans statically expanded wrapper subjects", () => {
    expect(
      inspectShellSecretReference('bash -c "grep --file=.envrc needle"'),
    ).toMatchObject({ reference: ".envrc", opaque: false });
  });

  test("reports dynamic wrapper payloads as opaque without inventing a reference", () => {
    expect(inspectShellSecretReference('bash -c "$CMD"')).toEqual({
      reference: undefined,
      opaque: true,
    });
  });

  test("recognizes grep aliases and proven file-option clusters", () => {
    for (const command of [
      "egrep -Jf.envrc needle",
      "/usr/bin/fgrep -Tf.flaskenv needle",
      "grep -2f.flaskenv needle",
      "sed -anf.envrc input.txt",
      "{ grep -Jf.envrc needle; }",
      "! sed -anf.flaskenv input.txt",
      "{ awk -f.envrc input.txt; }",
    ]) {
      expect(inspectShellSecretReference(command)).toMatchObject({
        opaque: false,
      });
      expect(commandReferencesSensitivePath(command)).toBeDefined();
    }
  });

  test("fails closed when unknown flags make a possible f operand ambiguous", () => {
    for (const command of [
      "grep -Xf.envrc needle",
      "grep -uf.envrc needle",
      "sed -Qf.flaskenv input.txt",
      "awk -Qf.envrc input.txt",
    ]) {
      expect(inspectShellSecretReference(command)).toEqual({
        reference: undefined,
        opaque: true,
      });
    }
  });

  test("keeps proven non-file lookalikes and ordinary punctuation transparent", () => {
    for (const command of [
      "grep -Af.envrc needle file.txt",
      "sed -if.envrc input.txt",
      "awk -Ff.envrc input.txt",
      "grep -X needle file.txt",
      "printf '%s' '{' '}' '!'",
    ]) {
      expect(inspectShellSecretReference(command)).toEqual({
        reference: undefined,
        opaque: false,
      });
    }
  });

  test("peels nested interpreters so quoted secret payloads are visible", () => {
    for (const command of [
      'fish -c "cat .envrc"',
      'fish -c "cat .env"',
      'busybox sh -c "cat .envrc"',
      'csh -c "cat .envrc"',
      'tcsh -c "cat .envrc"',
      'pwsh -c "cat .envrc"',
    ]) {
      expect(inspectShellSecretReference(command)).toMatchObject({
        reference: expect.any(String),
        opaque: false,
      });
    }
  });

  test("cmd dialect peels interpreter and cmd /c payloads", () => {
    expect(
      inspectShellSecretReference('bash -c "cat .envrc"', process.cwd(), "cmd"),
    ).toMatchObject({ reference: ".envrc", opaque: false });
    expect(
      inspectShellSecretReference('cmd /c "type .envrc"', process.cwd(), "cmd"),
    ).toMatchObject({ reference: ".envrc", opaque: false });
  });

  test("keeps nested-interpreter template reads unsensitive", () => {
    for (const command of [
      'fish -c "cat .env.example"',
      'busybox sh -c "cat .env.template"',
      'bash -c "cat .env.sample"',
    ]) {
      expect(inspectShellSecretReference(command)).toEqual({
        reference: undefined,
        opaque: false,
      });
    }
  });
});
