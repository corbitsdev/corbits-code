import { describe, expect, test } from "bun:test";
import { extractPastedImagePaths, findImagePathMentions, imageMimeTypeForPath } from "./image-attachments.js";

describe("image attachment helpers", () => {
  test("detects supported image MIME types from paths", () => {
    expect(imageMimeTypeForPath("shot.png")).toBe("image/png");
    expect(imageMimeTypeForPath("photo.JPEG")).toBe("image/jpeg");
    expect(imageMimeTypeForPath("animation.gif")).toBe("image/gif");
    expect(imageMimeTypeForPath("notes.txt")).toBeUndefined();
  });

  test("extracts absolute image paths from bracketed paste text", () => {
    expect(extractPastedImagePaths("/tmp/screenshot.png\n/var/tmp/photo.jpg", "/repo")).toEqual([
      "/tmp/screenshot.png",
      "/var/tmp/photo.jpg",
    ]);
  });

  test("resolves relative and file-url image paths", () => {
    expect(extractPastedImagePaths("assets/shot.webp", "/repo")).toEqual(["/repo/assets/shot.webp"]);
    expect(extractPastedImagePaths("file:///tmp/my%20shot.png", "/repo")).toEqual(["/tmp/my shot.png"]);
  });

  test("rejects mixed text and non-image paths", () => {
    expect(extractPastedImagePaths("please see /tmp/shot.png", "/repo")).toEqual([]);
    expect(extractPastedImagePaths("/tmp/readme.md", "/repo")).toEqual([]);
  });

  test("accepts unescaped spaces and home-relative pasted image paths", () => {
    expect(extractPastedImagePaths("/tmp/Screenshot 2026-01-01 at 1.23.45 PM.png", "/repo")).toEqual([
      "/tmp/Screenshot 2026-01-01 at 1.23.45 PM.png",
    ]);
    expect(extractPastedImagePaths("~/Desktop/shot.png", "/repo")[0]).toContain("/Desktop/shot.png");
  });

  test("finds image paths embedded in instructions", () => {
    expect(findImagePathMentions("what is in /tmp/Screenshot 2026-01-01.png please", "/repo")).toEqual([
      { raw: "/tmp/Screenshot 2026-01-01.png", path: "/tmp/Screenshot 2026-01-01.png" },
    ]);
    expect(findImagePathMentions("look at file:///tmp/my%20shot.png", "/repo")).toEqual([
      { raw: "file:///tmp/my%20shot.png", path: "/tmp/my shot.png" },
    ]);
  });
});
