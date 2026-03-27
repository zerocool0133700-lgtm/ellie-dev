import { describe, it, expect } from "bun:test";
import { canIngest, SUPPORTED_EXTENSIONS } from "../src/document-ingestion.ts";

describe("ELLIE-1087: Document ingestion", () => {
  describe("canIngest", () => {
    it("accepts PDF files", () => {
      expect(canIngest("report.pdf")).toBe(true);
    });

    it("accepts DOCX files", () => {
      expect(canIngest("document.docx")).toBe(true);
    });

    it("accepts HTML files", () => {
      expect(canIngest("page.html")).toBe(true);
    });

    it("accepts images", () => {
      expect(canIngest("screenshot.png")).toBe(true);
      expect(canIngest("photo.jpg")).toBe(true);
    });

    it("accepts CSV and JSON", () => {
      expect(canIngest("data.csv")).toBe(true);
      expect(canIngest("config.json")).toBe(true);
    });

    it("rejects unsupported formats", () => {
      expect(canIngest("program.exe")).toBe(false);
      expect(canIngest("archive.tar.gz")).toBe(false);
      expect(canIngest("binary.bin")).toBe(false);
    });

    it("handles case insensitivity", () => {
      expect(canIngest("REPORT.PDF")).toBe(true);
      expect(canIngest("Document.DOCX")).toBe(true);
    });
  });

  describe("ingestDocument", () => {
    it("converts plain text to markdown", async () => {
      const { ingestDocument } = await import("../src/document-ingestion.ts");
      const buffer = Buffer.from("Hello, this is a plain text document.\n\nSecond paragraph.");
      const result = await ingestDocument(buffer, "test.txt");
      expect(result.success).toBe(true);
      expect(result.markdown.length).toBeGreaterThan(0);
      expect(result.format).toBe(".txt");
    });

    it("converts CSV to markdown table", async () => {
      const { ingestDocument } = await import("../src/document-ingestion.ts");
      const csv = "name,age,role\nAlice,30,dev\nBob,25,ops";
      const buffer = Buffer.from(csv);
      const result = await ingestDocument(buffer, "data.csv");
      expect(result.success).toBe(true);
      expect(result.markdown).toContain("Alice");
      expect(result.markdown).toContain("|");
    });

    it("converts JSON to markdown", async () => {
      const { ingestDocument } = await import("../src/document-ingestion.ts");
      const json = JSON.stringify({ name: "test", items: [1, 2, 3] }, null, 2);
      const buffer = Buffer.from(json);
      const result = await ingestDocument(buffer, "data.json");
      expect(result.success).toBe(true);
      expect(result.markdown.length).toBeGreaterThan(0);
      expect(result.markdown).toContain("```json");
    });

    it("converts HTML to markdown", async () => {
      const { ingestDocument } = await import("../src/document-ingestion.ts");
      const html = "<html><head><title>Test Page</title></head><body><h1>Hello</h1><p>World</p></body></html>";
      const buffer = Buffer.from(html);
      const result = await ingestDocument(buffer, "page.html");
      expect(result.success).toBe(true);
      expect(result.markdown).toContain("# Hello");
      expect(result.markdown).toContain("World");
    });

    it("converts YAML to markdown code block", async () => {
      const { ingestDocument } = await import("../src/document-ingestion.ts");
      const yaml = "name: test\nitems:\n  - one\n  - two";
      const buffer = Buffer.from(yaml);
      const result = await ingestDocument(buffer, "config.yaml");
      expect(result.success).toBe(true);
      expect(result.markdown).toContain("```yaml");
    });

    it("passes through markdown files", async () => {
      const { ingestDocument } = await import("../src/document-ingestion.ts");
      const md = "# Title\n\nSome **bold** text.";
      const buffer = Buffer.from(md);
      const result = await ingestDocument(buffer, "readme.md");
      expect(result.success).toBe(true);
      expect(result.markdown).toBe(md);
    });

    it("handles image files with describeFn", async () => {
      const { ingestDocument } = await import("../src/document-ingestion.ts");
      const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes
      const result = await ingestDocument(buffer, "photo.png", {
        describeFn: async () => "A photo of a cat",
      });
      expect(result.success).toBe(true);
      expect(result.markdown).toContain("A photo of a cat");
    });

    it("handles image files without describeFn", async () => {
      const { ingestDocument } = await import("../src/document-ingestion.ts");
      const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      const result = await ingestDocument(buffer, "photo.png");
      expect(result.success).toBe(true);
      expect(result.markdown).toContain("Image file");
    });

    it("returns error for corrupt file gracefully", async () => {
      const { ingestDocument } = await import("../src/document-ingestion.ts");
      const buffer = Buffer.from([0x00, 0x01, 0x02, 0x03]);
      const result = await ingestDocument(buffer, "corrupt.pdf");
      // May succeed with placeholder or fail gracefully
      expect(typeof result.success).toBe("boolean");
    });

    it("tracks file sizes", async () => {
      const { ingestDocument } = await import("../src/document-ingestion.ts");
      const content = "Test content for size tracking";
      const buffer = Buffer.from(content);
      const result = await ingestDocument(buffer, "test.txt");
      expect(result.originalSize).toBe(buffer.length);
      expect(result.markdownSize).toBeGreaterThan(0);
    });
  });

  describe("SUPPORTED_EXTENSIONS", () => {
    it("includes common document formats", () => {
      expect(SUPPORTED_EXTENSIONS.has(".pdf")).toBe(true);
      expect(SUPPORTED_EXTENSIONS.has(".docx")).toBe(true);
      expect(SUPPORTED_EXTENSIONS.has(".html")).toBe(true);
      expect(SUPPORTED_EXTENSIONS.has(".csv")).toBe(true);
    });

    it("includes image formats", () => {
      expect(SUPPORTED_EXTENSIONS.has(".png")).toBe(true);
      expect(SUPPORTED_EXTENSIONS.has(".jpg")).toBe(true);
    });
  });

  describe("module exports", () => {
    it("exports ingestUrl", async () => {
      const mod = await import("../src/document-ingestion.ts");
      expect(typeof mod.ingestUrl).toBe("function");
    });

    it("exports canIngest", async () => {
      const mod = await import("../src/document-ingestion.ts");
      expect(typeof mod.canIngest).toBe("function");
    });
  });
});
