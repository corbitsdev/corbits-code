import { describe, expect, test } from "bun:test";

import { peelTransparentCommand } from "./transparent-command.js";

interface PeelCase {
  name: string;
  tokens: string[];
  executableIndex: number;
  assignmentValues?: string[];
  wrapperIndexes?: number[];
  terminal?: boolean;
}

function expected({
  executableIndex,
  assignmentValues = [],
  wrapperIndexes = [],
  terminal = false,
}: PeelCase) {
  return { executableIndex, assignmentValues, wrapperIndexes, terminal };
}

describe("peelTransparentCommand", () => {
  const cases: PeelCase[] = [
    {
      name: "collects assignments across an env wrapper",
      tokens: ["OUTER=one", "env", "INNER=two", "find", "."],
      executableIndex: 3,
      assignmentValues: ["one", "two"],
      wrapperIndexes: [1],
    },
    {
      name: "lets a clustered env value flag consume the next operand",
      tokens: ["env", "-iu", "PATH", "find", "."],
      executableIndex: 3,
      wrapperIndexes: [0],
    },
    {
      name: "lets a clustered time value flag consume the next operand",
      tokens: ["/usr/bin/time", "-ao", "report", "find", "."],
      executableIndex: 3,
      wrapperIndexes: [0],
    },
    {
      name: "lets a clustered timeout value flag consume the next operand",
      tokens: ["timeout", "-vs", "KILL", "1", "find", "."],
      executableIndex: 4,
      wrapperIndexes: [0],
    },
    {
      name: "ends env option parsing when assignments begin",
      tokens: ["env", "A=x", "--help", "find"],
      executableIndex: 2,
      assignmentValues: ["x"],
      wrapperIndexes: [0],
    },
    {
      name: "lets an env split payload own trailing help arguments",
      tokens: ["env", "-S", "find .", "--help"],
      executableIndex: 2,
      wrapperIndexes: [0],
    },
    {
      name: "lets a clustered env split payload own trailing version arguments",
      tokens: ["env", "-iS", "rm -rf /", "--version"],
      executableIndex: 2,
      wrapperIndexes: [0],
    },
    {
      name: "consumes exactly one timeout duration",
      tokens: ["timeout", "1", "2", "find", "."],
      executableIndex: 2,
      wrapperIndexes: [0],
    },
    {
      name: "does not accept an uppercase timeout suffix",
      tokens: ["timeout", "1S", "find", "."],
      executableIndex: 1,
      wrapperIndexes: [0],
    },
    ...["1e3", "1e3s", "0x1p4", "2.5", ".5s", "inf", "infinity"].map(
      (duration): PeelCase => ({
        name: `peels GNU timeout duration ${duration}`,
        tokens: ["timeout", duration, "find", "."],
        executableIndex: 2,
        wrapperIndexes: [0],
      }),
    ),
    ...["+1", "+1e3s", "+0x1p4", "+.5s"].map((duration): PeelCase => ({
      name: `peels leading-plus GNU timeout duration ${duration}`,
      tokens: ["timeout", duration, "find", "."],
      executableIndex: 2,
      wrapperIndexes: [0],
    })),
    ...["-u", "--unset", "-C", "--chdir", "--argv0", "-f", "--file", "-P"].map(
      (option): PeelCase => ({
        name: `treats ${option} terminal-looking operand as an env option value`,
        tokens: ["env", option, "--help", "find", "."],
        executableIndex: 3,
        wrapperIndexes: [0],
      }),
    ),
    {
      name: "recognizes env help after a value option",
      tokens: ["env", "-u", "NAME", "--help", "find", "."],
      executableIndex: 0,
      terminal: true,
    },
    {
      name: "does not treat S inside an env option value as split mode",
      tokens: ["env", "-uS", "--help", "find", "."],
      executableIndex: 0,
      terminal: true,
    },
    {
      name: "recognizes env version mode",
      tokens: ["env", "--version", "find", "."],
      executableIndex: 0,
      terminal: true,
    },
    {
      name: "does not treat an env option after end-of-options as terminal",
      tokens: ["env", "--", "--help", "find", "."],
      executableIndex: 2,
      wrapperIndexes: [0],
    },
    {
      name: "recognizes command help mode",
      tokens: ["command", "--help", "find", "."],
      executableIndex: 0,
      terminal: true,
    },
    ...[["-p", "-v"], ["-pv"]].map((options): PeelCase => ({
      name: `recognizes command query mode ${options.join(" ")}`,
      tokens: ["command", ...options, "find", "."],
      executableIndex: 0,
      terminal: true,
    })),
    {
      name: "peels command portability mode when it executes a utility",
      tokens: ["command", "-p", "find", "."],
      executableIndex: 2,
      wrapperIndexes: [0],
    },
    {
      name: "skips GNU time output operand",
      tokens: ["/usr/bin/time", "-o", "report", "find", "."],
      executableIndex: 3,
      wrapperIndexes: [0],
    },
    {
      name: "skips GNU time format operand",
      tokens: ["time", "-f", "%e", "find", "."],
      executableIndex: 3,
      wrapperIndexes: [0],
    },
    {
      name: "keeps time portability option transparent",
      tokens: ["time", "-p", "find", "."],
      executableIndex: 2,
      wrapperIndexes: [0],
    },
    {
      name: "keeps time end-of-options transparent",
      tokens: ["time", "--", "find", "."],
      executableIndex: 2,
      wrapperIndexes: [0],
    },
    {
      name: "peels busybox so the applet is the executable",
      tokens: ["busybox", "sh", "-c", "cat .envrc"],
      executableIndex: 1,
      wrapperIndexes: [0],
    },
  ];

  for (const entry of cases) {
    test(entry.name, () => {
      expect(peelTransparentCommand(entry.tokens)).toEqual(expected(entry));
    });
  }

  test("stops before wrappers rejected by the caller", () => {
    expect(
      peelTransparentCommand(["env", "nice", "find", "."], {
        acceptsWrapper: (_token, program) => program !== "nice",
      }),
    ).toEqual({
      executableIndex: 1,
      assignmentValues: [],
      wrapperIndexes: [0],
      terminal: false,
    });
  });
});
