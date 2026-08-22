import { describe, expect, test } from "bun:test";

import { PRIMARY_DENIED_PRODUCT_TOOLS } from "./tool-search.js";
import {
  PRODUCT_MUTATION_TOOLS,
  isProductMutationTool,
  productMutationPaths,
} from "./product-mutation-tools.js";
import { buildRequests } from "../permission/classify.js";

describe("PRODUCT_MUTATION_TOOLS", () => {
  test("includes apply_patch alongside path-arg mutation tools", () => {
    expect([...PRODUCT_MUTATION_TOOLS]).toEqual([
      "write_file",
      "edit_file",
      "delete_file",
      "apply_patch",
    ]);
  });

  test("primary deny membership shares the same set", () => {
    expect([...PRIMARY_DENIED_PRODUCT_TOOLS]).toEqual([...PRODUCT_MUTATION_TOOLS]);
    expect(isProductMutationTool("apply_patch")).toBe(true);
    expect(isProductMutationTool("read_file")).toBe(false);
  });

  test("productMutationPaths extracts apply_patch envelope subjects", () => {
    const input = `*** Begin Patch
*** Add File: hello.txt
+Hello
*** Update File: src/app.py
@@
-old
+new
*** End Patch
`;
    expect(productMutationPaths("apply_patch", { input })).toEqual([
      "hello.txt",
      "src/app.py",
    ]);
  });

  test("productMutationPaths returns [] for malformed apply_patch input", () => {
    expect(productMutationPaths("apply_patch", { input: "not a patch" })).toEqual([]);
    expect(productMutationPaths("apply_patch", {})).toEqual([]);
  });

  test("classify buildRequests recognizes apply_patch as a mutation tool", () => {
    const input = `*** Begin Patch
*** Add File: src/a.ts
+x
*** End Patch
`;
    const reqs = buildRequests({ id: "c", name: "apply_patch", arguments: { input } });
    expect(reqs).toHaveLength(1);
    expect(reqs[0]?.tool).toBe("apply_patch");
    expect(reqs[0]?.subject).toBe("src/a.ts");
    expect(reqs[0]?.action).toBe("Apply patch");
  });

  test("isProductMutationTool names are auto-allow candidates by shared membership", () => {
    for (const name of PRODUCT_MUTATION_TOOLS) {
      expect(isProductMutationTool(name)).toBe(true);
    }
  });
});
