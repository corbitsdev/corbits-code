import { afterEach, describe, expect, test } from "bun:test";
import type { CredentialMaterial } from "@intx/types";

import {
  clearSourceCredentials,
  findSourceCredentialRecord,
  registerSourceCredentialRecord,
  rotateSourceCredentialMaterialIfCurrent,
} from "./source-credentials.js";

const material: CredentialMaterial = {
  secret: "secret-value",
  headers: { "chatgpt-account-id": "account-a" },
};

afterEach(() => {
  clearSourceCredentials();
});

describe("credential material freeze at the source cell", () => {
  test("registered material and its headers are frozen", () => {
    registerSourceCredentialRecord("c1", {
      provenance: { kind: "api-key" },
      material,
    });
    const record = findSourceCredentialRecord("c1");
    expect(Object.isFrozen(record?.material)).toBe(true);
    expect(Object.isFrozen(record?.material.headers)).toBe(true);
  });

  test("the caller's headers object is copied, not aliased into the cell", () => {
    const headers = { "chatgpt-account-id": "account-a" };
    registerSourceCredentialRecord("c1", {
      provenance: { kind: "api-key" },
      material: { secret: "secret-value", headers },
    });
    headers["chatgpt-account-id"] = "attacker-a";
    expect(findSourceCredentialRecord("c1")?.material.headers).toEqual({
      "chatgpt-account-id": "account-a",
    });
  });

  test("an in-place mutation attempt after register never reaches the cell", () => {
    registerSourceCredentialRecord("c1", {
      provenance: { kind: "api-key" },
      material,
    });
    const stored = findSourceCredentialRecord("c1");
    const headers = stored?.material.headers as Record<string, string>;
    // Frozen headers make the mutation fail loudly in strict mode.
    expect(() => {
      headers["chatgpt-account-id"] = "attacker-a";
    }).toThrow();
    expect(stored?.material.headers).toEqual({
      "chatgpt-account-id": "account-a",
    });
  });

  test("a rotation stores a fresh frozen snapshot and releases the old record", () => {
    registerSourceCredentialRecord("c1", {
      provenance: { kind: "api-key" },
      material,
    });
    const expected = findSourceCredentialRecord("c1");
    const rotated = { secret: "next-token" };
    expect(
      rotateSourceCredentialMaterialIfCurrent("c1", expected as never, rotated),
    ).toBe(true);
    const record = findSourceCredentialRecord("c1");
    expect(Object.isFrozen(record?.material)).toBe(true);
    expect(record?.material.secret).toBe("next-token");
  });
});
