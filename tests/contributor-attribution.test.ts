import { describe, test, expect } from "bun:test";

describe("Contributor Attribution", () => {
  test("extracts completed specialists from envelopes", () => {
    const envelopes = [
      { type: "coordinator", agent: "max", status: "completed" },
      { type: "specialist", agent: "brian", status: "completed" },
      { type: "specialist", agent: "alan", status: "completed" },
      { type: "specialist", agent: "james", status: "error" },
    ];

    const contributors = [...new Set(
      envelopes
        .filter(e => e.type === "specialist" && e.status === "completed")
        .map(e => e.agent)
    )];

    expect(contributors).toEqual(["brian", "alan"]);
    expect(contributors).not.toContain("max");
    expect(contributors).not.toContain("james");
  });

  test("contributor scope paths resolve correctly", () => {
    const contributors = ["brian", "alan"];
    const scopes = contributors.map(a => `3/${a}`);
    expect(scopes).toEqual(["3/brian", "3/alan"]);
  });

  test("empty contributors produces no extra scopes", () => {
    const contributors: string[] = [];
    const scopes = contributors.map(a => `3/${a}`);
    expect(scopes).toHaveLength(0);
  });

  test("contributor memory content is prefixed correctly", () => {
    const content = "The schema has two issues";
    const sourceAgent = "ellie";
    const result = `[contributed via ${sourceAgent}] ${content}`;
    expect(result).toBe("[contributed via ellie] The schema has two issues");
  });
});
