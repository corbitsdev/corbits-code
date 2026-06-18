import { test, expect, afterEach } from "bun:test";
import { humanizeToolName, setActiveWebProviderBrand } from "../../../src/tui/tool-formatter.js";

afterEach(() => setActiveWebProviderBrand(undefined));

test("web tools use the default names with no active web brand", () => {
  expect(humanizeToolName("web_search")).toBe("Web Search");
  expect(humanizeToolName("web_fetch")).toBe("Web Fetch");
});

test("web tools render with the active web plugin brand", () => {
  setActiveWebProviderBrand("Exa");
  expect(humanizeToolName("web_search")).toBe("Exa Search");
  expect(humanizeToolName("web_fetch")).toBe("Exa Fetch");
});

test("non-web tools are unaffected by the web brand", () => {
  setActiveWebProviderBrand("Exa");
  expect(humanizeToolName("read_file")).toBe("Read");
});
