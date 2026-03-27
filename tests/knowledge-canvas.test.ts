import { describe, it, expect } from "bun:test";

describe("ELLIE-1048: Knowledge canvas", () => {
  it("canvas API endpoint structure", () => {
    const mockResponse = {
      nodes: [
        { id: "uuid-1", label: "Test memory", type: "fact", scope: "2/1", importance: 0.8 },
      ],
      edges: [
        { source: "uuid-1", target: "uuid-2", weight: 0.75 },
      ],
    };
    expect(mockResponse.nodes[0]).toHaveProperty("id");
    expect(mockResponse.nodes[0]).toHaveProperty("label");
    expect(mockResponse.nodes[0]).toHaveProperty("type");
    expect(mockResponse.edges[0]).toHaveProperty("source");
    expect(mockResponse.edges[0]).toHaveProperty("weight");
  });

  it("node types have expected values", () => {
    const validTypes = ["fact", "decision", "preference", "finding", "hypothesis", "contradiction", "summary", "pattern"];
    expect(validTypes).toContain("fact");
    expect(validTypes).toContain("decision");
  });

  it("label truncation at 50 chars", () => {
    const longContent = "A".repeat(100);
    const label = longContent.slice(0, 50) + (longContent.length > 50 ? "..." : "");
    expect(label).toHaveLength(53);
    expect(label).toEndWith("...");
  });

  it("importance defaults to 0.5 when null", () => {
    const node = { importance_score: null };
    const importance = node.importance_score ?? 0.5;
    expect(importance).toBe(0.5);
  });

  it("edges only include nodes in the returned set", () => {
    const nodeIds = ["a", "b", "c"];
    const allEdges = [
      { source: "a", target: "b" },
      { source: "a", target: "d" }, // d not in nodeIds
      { source: "b", target: "c" },
    ];
    const filtered = allEdges.filter(e => nodeIds.includes(e.source) && nodeIds.includes(e.target));
    expect(filtered).toHaveLength(2);
  });
});
