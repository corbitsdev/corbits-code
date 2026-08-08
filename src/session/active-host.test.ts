import { afterEach, describe, expect, test } from "bun:test";

import { clearActiveDisposeHost, getActiveDisposeHost, setActiveDisposeHost } from "./active-host.js";

describe("active-host", () => {
  afterEach(() => {
    clearActiveDisposeHost();
  });

  test("starts with no active dispose handle", () => {
    expect(getActiveDisposeHost()).toBeNull();
  });

  test("returns the handle set by setActiveDisposeHost", () => {
    const disposeHost = () => {};
    setActiveDisposeHost(disposeHost);
    expect(getActiveDisposeHost()).toBe(disposeHost);
  });

  test("clearActiveDisposeHost removes the handle", () => {
    setActiveDisposeHost(() => {});
    clearActiveDisposeHost();
    expect(getActiveDisposeHost()).toBeNull();
  });

  test("setActiveDisposeHost overwrites a previously set handle", () => {
    setActiveDisposeHost(() => {});
    const second = () => {};
    setActiveDisposeHost(second);
    expect(getActiveDisposeHost()).toBe(second);
  });
});
