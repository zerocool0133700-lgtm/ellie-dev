import { describe, test, expect } from "bun:test"
import { extractFindings } from "../src/creature-findings"

describe("extractFindings", () => {
  test("extracts response_preview as a finding", () => {
    const findings = extractFindings({
      response_preview: "The relay uses port 3001 and connects to Forest via Unix socket. The dashboard runs on port 3000.",
      duration_ms: 5000,
      work_item_id: "ELLIE-500",
    })
    expect(findings.length).toBe(1)
    expect(findings[0].content).toContain("relay uses port 3001")
    expect(findings[0].type).toBe("finding")
  })

  test("skips short previews (under 50 chars)", () => {
    const findings = extractFindings({
      response_preview: "Done.",
      duration_ms: 1000,
    })
    expect(findings.length).toBe(0)
  })

  test("skips error-like previews", () => {
    const findings = extractFindings({
      response_preview: "Something went wrong. I encountered an error while processing the request and could not complete the task.",
      duration_ms: 1000,
    })
    expect(findings.length).toBe(0)
  })

  test("extracts from decisions array if present", () => {
    const findings = extractFindings({
      response_preview: "Implemented the feature successfully and verified all tests pass in the CI pipeline",
      duration_ms: 3000,
      decisions: ["Used PostgreSQL advisory locks instead of Redis", "Chose TDD approach for reliability"],
    })
    expect(findings.length).toBe(3)
    expect(findings[1].type).toBe("decision")
    expect(findings[1].content).toContain("advisory locks")
  })
})
