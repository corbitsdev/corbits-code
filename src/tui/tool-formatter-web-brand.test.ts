import { test, expect, afterEach } from "bun:test";
import {
  humanizeToolName,
  setActiveWebProviderBrand,
} from "./tool-formatter.js";

afterEach(() => setActiveWebProviderBrand(undefined));

test("the active web provider brand swaps into the web tool names only", () => {
  const unbranded = humanizeToolName("read_file");
  setActiveWebProviderBrand("AcmeWeb");
  expect(humanizeToolName("web_search")).toContain("AcmeWeb");
  expect(humanizeToolName("web_fetch")).toContain("AcmeWeb");
  expect(humanizeToolName("read_file")).toBe(unbranded);
});
