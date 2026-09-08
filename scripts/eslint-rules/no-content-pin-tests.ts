import type { Rule } from "eslint";

// Heuristic guardrail against content-pin tests regrowing (CL-7516): tests
// whose assertions pin literal document wording, brand hex values, or palette
// indexes fail on copy/design edits and catch no behavior regression.
//
// This is a shape match, not a semantic check. It flags assertions whose
// receiver was loaded from a document asset via Bun.file (path names a
// document extension — .md, .json, .txt, … — so runtime round-trips of files
// a test just wrote, and source-structure locks on .ts, stay clean), exact
// hex-color pins, and numeric pins on palette-named callees. It does not
// understand test intent: it will not catch pins on wording inlined in the
// test source, assets read via node:fs, extension-less asset paths, reads
// wrapped in a TS as/satisfies cast, or index pins on callees without a
// palette-ish name — and a shape match is not proof a given test is worthless.

// Rule.Node carries the parent backlink; helpers take the parent-less estree
// node so expressions and visitor nodes are interchangeable.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type ContentNode = DistributiveOmit<Rule.Node, "parent">;
type AnyNode = ContentNode | null | undefined;
type IdentifierNode = Extract<ContentNode, { type: "Identifier" }>;
type CallNode = Extract<ContentNode, { type: "CallExpression" }>;

const HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/;
const PALETTE_CALLEE = /colou?r|palette|ansi/i;
const DOCUMENT_ASSET_PATH = /\.(?:md|markdown|json|txt|yaml|yml|toml|html|css|csv|xml|svg)$/i;

const EXACT_VALUE_MATCHERS = new Set(["toBe", "toEqual", "toStrictEqual"]);
const WORDING_MATCHERS = new Set(["toContain", "toBe", "toEqual", "toStrictEqual", "toMatch"]);
const ASSERTION_CHAIN_PROPERTIES = new Set(["not", "resolves", "rejects"]);
const BUN_FILE_CONTENT_METHODS = new Set(["text", "json"]);

const isIdentifierNamed = (node: AnyNode, name: string): boolean =>
  node !== null && node !== undefined && node.type === "Identifier" && node.name === name;

// Strip await expressions down to the underlying call.
const unwrap = (node: AnyNode): AnyNode => {
  let current = node;
  for (;;) {
    if (current === null || current === undefined) return current;
    if (current.type === "AwaitExpression") {
      current = current.argument;
    } else {
      return current;
    }
  }
};

// `const x = await Bun.file(<path>).text()/.json()` — returns the Bun.file
// call so the caller can inspect the path argument, else null.
const bunFileContentCall = (node: AnyNode): CallNode | null => {
  if (node === null || node === undefined || node.type !== "CallExpression") return null;
  const callee = node.callee;
  if (callee.type !== "MemberExpression") return null;
  if (
    callee.property.type !== "Identifier" ||
    !BUN_FILE_CONTENT_METHODS.has(callee.property.name)
  ) {
    return null;
  }
  const read = callee.object;
  if (read.type !== "CallExpression") return null;
  if (read.callee.type !== "MemberExpression") return null;
  return isIdentifierNamed(read.callee.object, "Bun") &&
    isIdentifierNamed(read.callee.property, "file")
    ? read
    : null;
};

// String pieces of a path expression — the literals inside join(...),
// new URL(...), and template chains — so an asset read is recognized no
// matter how the path is assembled.
const pathStrings = (node: AnyNode, out: string[]): void => {
  if (node === null || node === undefined) return;
  switch (node.type) {
    case "Literal":
      if (typeof node.value === "string") out.push(node.value);
      return;
    case "TemplateLiteral":
      for (const quasi of node.quasis) out.push(quasi.value.cooked ?? "");
      for (const expr of node.expressions) pathStrings(expr, out);
      return;
    case "BinaryExpression":
      pathStrings(node.left, out);
      pathStrings(node.right, out);
      return;
    case "ConditionalExpression":
      pathStrings(node.consequent, out);
      pathStrings(node.alternate, out);
      return;
    case "CallExpression":
    case "NewExpression":
      for (const arg of node.arguments) {
        if (arg.type !== "SpreadElement") pathStrings(arg, out);
      }
      return;
    default:
      return;
  }
};

const isDocumentAssetRead = (pathArg: AnyNode): boolean => {
  const strings: string[] = [];
  pathStrings(pathArg, strings);
  return strings.some((value) => DOCUMENT_ASSET_PATH.test(value));
};

// `expect(x).not/resolves/rejects.toContain(y)` — strip chain links back to
// the expect call itself.
const resolveExpectCall = (start: ContentNode): CallNode | null => {
  let current: ContentNode = start;
  while (current.type === "MemberExpression") {
    if (
      current.property.type !== "Identifier" ||
      !ASSERTION_CHAIN_PROPERTIES.has(current.property.name)
    ) {
      return null;
    }
    current = current.object;
  }
  if (current.type === "CallExpression" && isIdentifierNamed(current.callee, "expect")) {
    return current;
  }
  return null;
};

const isPaletteCall = (node: AnyNode): boolean =>
  node !== null &&
  node !== undefined &&
  node.type === "CallExpression" &&
  node.callee.type === "Identifier" &&
  PALETTE_CALLEE.test(node.callee.name);

// Base identifier of `x`, `x.y`, or `x[y].z` — null for calls and literals.
const baseIdentifier = (node: AnyNode): IdentifierNode | null => {
  let current = node;
  for (;;) {
    if (current === null || current === undefined || current.type !== "MemberExpression") {
      return current !== null && current !== undefined && current.type === "Identifier"
        ? current
        : null;
    }
    current = current.object;
  }
};

const isPinnedWording = (arg: AnyNode): boolean => {
  if (arg === null || arg === undefined) return false;
  if (arg.type === "Literal") {
    return typeof arg.value === "string" || "regex" in arg;
  }
  return arg.type === "TemplateLiteral" && arg.expressions.length === 0;
};

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow test assertions that pin literal document wording, brand hex values, or palette indexes",
    },
    messages: {
      wordingPin:
        "Content-pin test: this asserts literal wording of a document asset loaded from disk. It fails on copy edits and catches no behavior regression — assert on code behavior instead, or validate the document's structure rather than pinning its text.",
      hexPin:
        "Content-pin test: this pins an exact brand hex value. Palette literals change with design edits and the pin catches no behavior regression — assert the contract instead (the role resolves, aliases hold, contrast stays in bounds).",
      ansiIndexPin:
        "Content-pin test: this pins an exact ANSI-256 palette index. Indexes shift with palette edits and the pin catches no behavior regression — assert the contract instead (the index is in range, distinct roles stay distinct).",
    },
    schema: [],
  },
  create(context: Rule.RuleContext): Rule.RuleListener {
    const contentBindings = new Set<string>();

    return {
      VariableDeclarator(node): void {
        if (node.id.type !== "Identifier" || node.init === null) return;
        const read = bunFileContentCall(unwrap(node.init));
        if (read === null || !isDocumentAssetRead(read.arguments[0])) return;
        contentBindings.add(node.id.name);
      },

      CallExpression(node): void {
        if (node.callee.type !== "MemberExpression") return;
        const matcher = node.callee.property;
        if (matcher.type !== "Identifier") return;
        const expectCall = resolveExpectCall(node.callee.object);
        if (expectCall === null) return;
        const subject = expectCall.arguments[0];
        if (subject === undefined || subject.type === "SpreadElement") return;

        if (EXACT_VALUE_MATCHERS.has(matcher.name)) {
          const arg = node.arguments[0];
          if (arg !== undefined && arg.type === "Literal") {
            if (typeof arg.value === "string" && HEX_COLOR.test(arg.value)) {
              context.report({ node, messageId: "hexPin" });
              return;
            }
            if (typeof arg.value === "number" && isPaletteCall(unwrap(subject))) {
              context.report({ node, messageId: "ansiIndexPin" });
              return;
            }
          }
        }

        const receiver = baseIdentifier(unwrap(subject));
        if (
          WORDING_MATCHERS.has(matcher.name) &&
          receiver !== null &&
          contentBindings.has(receiver.name) &&
          isPinnedWording(node.arguments[0])
        ) {
          context.report({ node, messageId: "wordingPin" });
        }
      },
    };
  },
} satisfies Rule.RuleModule;
