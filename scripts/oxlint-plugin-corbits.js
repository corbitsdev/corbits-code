const noBareMockModule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow bare mock.module in test files; it leaks into later files in the same bun test process.",
    },
    messages: {
      noBare:
        "Use withMockedModule/withMockedModuleDuring from tests/helpers/mock-module.ts instead of bare mock.module — an un-restored mock.module leaks into every test file that runs after this one.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "MemberExpression") return;
        if (callee.computed) return;
        if (callee.object.type !== "Identifier" || callee.object.name !== "mock") {
          return;
        }
        if (callee.property.type !== "Identifier" || callee.property.name !== "module") {
          return;
        }
        context.report({ node, messageId: "noBare" });
      },
    };
  },
};

const plugin = {
  meta: {
    name: "corbits",
  },
  rules: {
    "no-bare-mock-module": noBareMockModule,
  },
};

export default plugin;
