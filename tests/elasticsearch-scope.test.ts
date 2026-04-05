import { describe, test, expect } from "bun:test";
import { classifyDomain } from "../src/elasticsearch";

describe("indexMemory scope_path support", () => {
  test("classifyDomain still works for domain classification", () => {
    expect(classifyDomain("relay server architecture")).toBe("architecture");
    expect(classifyDomain("Dave's morning routine")).toBe("personal");
    expect(classifyDomain("quarterly revenue targets")).toBe("business");
  });
});
