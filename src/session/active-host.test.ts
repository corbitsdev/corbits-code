import { afterEach, describe, expect, test } from "bun:test";

import {
  clearActiveDisposeHost,
  getActiveDisposeHost,
  setActiveDisposeHost,
} from "./active-host.js";

describe("active-host", () => {
  afterEach(() => {
    clearActiveDisposeHost();
  });

  test("starts with no active dispose handle", () => {
    expect(getActiveDisposeHost()).toBeNull();
  });

  test("returns the handle set by setActiveDisposeHost", () => {
    const disposeHost = () => undefined;
    setActiveDisposeHost(disposeHost);
    expect(getActiveDisposeHost()).toBe(disposeHost);
  });

  test("clearActiveDisposeHost removes the handle", () => {
    setActiveDisposeHost(() => undefined);
    clearActiveDisposeHost();
    expect(getActiveDisposeHost()).toBeNull();
  });

  test("setActiveDisposeHost overwrites a previously set handle", () => {
    setActiveDisposeHost(() => undefined);
    const second = () => undefined;
    setActiveDisposeHost(second);
    expect(getActiveDisposeHost()).toBe(second);
  });

  test("accepts an async dispose handle", async () => {
    let ran = false;
    const handle = async () => {
      ran = true;
    };
    setActiveDisposeHost(handle);
    const active = getActiveDisposeHost();
    expect(active).toBe(handle);
    await active?.();
    expect(ran).toBe(true);
  });
});
