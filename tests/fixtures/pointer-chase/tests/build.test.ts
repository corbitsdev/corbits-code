import { describe, expect, test } from "bun:test";
import { isReady, loadBuildToken } from "../src/build.ts";

describe("build token", () => {
  test("production token is the release value", () => {
    expect(loadBuildToken()).toBe("ok-7f3a");
  });

  test("isReady when production token matches", () => {
    expect(isReady()).toBe(true);
  });
});
