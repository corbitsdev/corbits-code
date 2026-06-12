import { describe, test, expect } from "bun:test";
import { formatElapsed } from "./status-bar.js";

describe("formatElapsed", () => {
  test("formats under a minute as M:SS", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(5000)).toBe("0:05");
    expect(formatElapsed(30000)).toBe("0:30");
    expect(formatElapsed(59000)).toBe("0:59");
  });

  test("formats minutes without hours as M:SS", () => {
    expect(formatElapsed(60000)).toBe("1:00");
    expect(formatElapsed(90000)).toBe("1:30");
    expect(formatElapsed(599000)).toBe("9:59");
  });

  test("formats over an hour as H:MM:SS", () => {
    expect(formatElapsed(3600000)).toBe("1:00:00");
    expect(formatElapsed(3661000)).toBe("1:01:01");
    expect(formatElapsed(6548000)).toBe("1:49:08");
  });

  test("formats multiple hours as H:MM:SS", () => {
    expect(formatElapsed(7200000)).toBe("2:00:00");
    expect(formatElapsed(10800000)).toBe("3:00:00");
  });
});
