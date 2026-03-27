/**
 * Document Ingestion — ELLIE-1087
 * Converts uploaded files (PDF, DOCX, HTML, images, etc.) to markdown.
 * Uses markit library for markdown parsing, with built-in converters
 * for plain text formats (CSV, JSON, YAML, HTML, etc.).
 */

import { log } from "./logger.ts";

const logger = log.child("document-ingestion");

export interface IngestionResult {
  markdown: string;
  title?: string;
  format: string;
  originalSize: number;
  markdownSize: number;
  success: boolean;
  error?: string;
}

// Supported file extensions
const SUPPORTED_EXTENSIONS = new Set([
  ".pdf", ".docx", ".doc", ".pptx", ".xlsx", ".csv",
  ".html", ".htm", ".xml", ".json", ".yaml", ".yml",
  ".md", ".txt", ".rtf", ".epub",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg",
  ".mp3", ".wav", ".ogg", ".m4a",
]);

/**
 * Check if a file can be ingested.
 */
export function canIngest(filename: string): boolean {
  const ext = filename.toLowerCase().substring(filename.lastIndexOf("."));
  return SUPPORTED_EXTENSIONS.has(ext);
}

/**
 * Convert CSV content to a markdown table.
 */
function csvToMarkdown(text: string): string {
  const lines = text.trim().split("\n").map(l => l.split(",").map(c => c.trim()));
  if (lines.length === 0) return text;

  const header = lines[0];
  const separator = header.map(() => "---");
  const rows = [header, separator, ...lines.slice(1)];
  return rows.map(r => "| " + r.join(" | ") + " |").join("\n");
}

/**
 * Convert JSON content to a markdown code block.
 */
function jsonToMarkdown(text: string): string {
  try {
    const parsed = JSON.parse(text);
    const pretty = JSON.stringify(parsed, null, 2);
    return "```json\n" + pretty + "\n```";
  } catch {
    return "```\n" + text + "\n```";
  }
}

/**
 * Convert YAML content to a markdown code block.
 */
function yamlToMarkdown(text: string): string {
  return "```yaml\n" + text + "\n```";
}

/**
 * Convert XML content to a markdown code block.
 */
function xmlToMarkdown(text: string): string {
  return "```xml\n" + text + "\n```";
}

/**
 * Strip HTML tags and convert to plain markdown.
 * Handles common tags: headings, paragraphs, links, lists, bold, italic.
 */
function htmlToMarkdown(html: string): string {
  let md = html;

  // Remove script and style blocks
  md = md.replace(/<script[\s\S]*?<\/script>/gi, "");
  md = md.replace(/<style[\s\S]*?<\/style>/gi, "");

  // Extract title
  const titleMatch = md.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : "";

  // Headings
  md = md.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "# $1\n\n");
  md = md.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "## $1\n\n");
  md = md.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "### $1\n\n");
  md = md.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, "#### $1\n\n");
  md = md.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, "##### $1\n\n");
  md = md.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, "###### $1\n\n");

  // Bold and italic
  md = md.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**");
  md = md.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*");

  // Links
  md = md.replace(/<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");

  // Images
  md = md.replace(/<img[^>]+src="([^"]*)"[^>]*alt="([^"]*)"[^>]*\/?>/gi, "![$2]($1)");
  md = md.replace(/<img[^>]+src="([^"]*)"[^>]*\/?>/gi, "![]($1)");

  // List items
  md = md.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n");

  // Paragraphs and line breaks
  md = md.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, "$1\n\n");
  md = md.replace(/<br\s*\/?>/gi, "\n");
  md = md.replace(/<hr\s*\/?>/gi, "\n---\n\n");

  // Code blocks
  md = md.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, "```\n$1\n```\n\n");
  md = md.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");

  // Blockquotes
  md = md.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, "> $1\n\n");

  // Strip remaining tags
  md = md.replace(/<[^>]+>/g, "");

  // Decode common HTML entities
  md = md.replace(/&amp;/g, "&");
  md = md.replace(/&lt;/g, "<");
  md = md.replace(/&gt;/g, ">");
  md = md.replace(/&quot;/g, '"');
  md = md.replace(/&#39;/g, "'");
  md = md.replace(/&nbsp;/g, " ");

  // Clean up whitespace
  md = md.replace(/\n{3,}/g, "\n\n").trim();

  if (title) {
    md = `# ${title}\n\n${md}`;
  }

  return md;
}

/**
 * Convert a file buffer to markdown.
 */
export async function ingestDocument(
  buffer: Buffer | Uint8Array,
  filename: string,
  opts?: { describeFn?: (buf: Buffer) => Promise<string> }
): Promise<IngestionResult> {
  const ext = filename.toLowerCase().substring(filename.lastIndexOf("."));

  try {
    const text = Buffer.from(buffer).toString("utf-8");
    let markdown = "";
    let title: string | undefined;

    switch (ext) {
      case ".md":
        // Already markdown — pass through
        markdown = text;
        break;

      case ".txt":
      case ".rtf":
        // Plain text — wrap as-is
        markdown = text;
        break;

      case ".csv":
        markdown = csvToMarkdown(text);
        break;

      case ".json":
        markdown = jsonToMarkdown(text);
        break;

      case ".yaml":
      case ".yml":
        markdown = yamlToMarkdown(text);
        break;

      case ".xml":
        markdown = xmlToMarkdown(text);
        break;

      case ".html":
      case ".htm":
        markdown = htmlToMarkdown(text);
        break;

      case ".png":
      case ".jpg":
      case ".jpeg":
      case ".gif":
      case ".webp":
      case ".svg":
        if (opts?.describeFn) {
          const description = await opts.describeFn(Buffer.from(buffer));
          markdown = `![${filename}](attachment)\n\n**Description:** ${description}`;
          title = filename;
        } else {
          markdown = `![${filename}](attachment)\n\n*Image file — ${buffer.length} bytes*`;
          title = filename;
        }
        break;

      case ".mp3":
      case ".wav":
      case ".ogg":
      case ".m4a":
        markdown = `*Audio file: ${filename} — ${buffer.length} bytes*\n\n*Audio transcription not available inline. Use voice transcription service.*`;
        title = filename;
        break;

      case ".pdf": {
        // PDF text extraction via unpdf
        try {
          const { extractText } = await import("unpdf");
          const { text: pdfText, totalPages } = await extractText(new Uint8Array(buffer));
          markdown = pdfText || "";
          title = filename.replace(/\.pdf$/i, "");
          if (totalPages) markdown = `*${totalPages} page(s)*\n\n${markdown}`;
          logger.info("PDF extracted", { filename, pages: totalPages, chars: markdown.length });
        } catch (pdfErr) {
          logger.warn("PDF extraction failed, falling back", { filename, error: String(pdfErr) });
          markdown = `*PDF: ${filename} — ${buffer.length} bytes. Text extraction failed.*`;
        }
        break;
      }

      case ".docx":
      case ".doc": {
        // Word document via mammoth → HTML → markdown
        try {
          const mammoth = await import("mammoth");
          const result = await mammoth.convertToHtml({ buffer: Buffer.from(buffer) });
          markdown = htmlToMarkdown(result.value);
          title = filename.replace(/\.docx?$/i, "");
          if (result.messages?.length) {
            const warnings = result.messages.filter((m: any) => m.type === "warning").length;
            if (warnings > 0) logger.info("DOCX conversion warnings", { filename, warnings });
          }
          logger.info("DOCX extracted", { filename, chars: markdown.length });
        } catch (docErr) {
          logger.warn("DOCX extraction failed", { filename, error: String(docErr) });
          markdown = `*Word document: ${filename} — ${buffer.length} bytes. Extraction failed.*`;
        }
        break;
      }

      case ".pptx":
      case ".xlsx":
      case ".epub":
        markdown = `*Binary document: ${filename} (${ext}) — ${buffer.length} bytes*\n\n*Full text extraction for ${ext} files is not yet supported.*`;
        title = filename;
        break;

      default:
        markdown = text;
        break;
    }

    logger.info("Document ingested", {
      filename,
      format: ext,
      originalSize: buffer.length,
      markdownSize: markdown.length,
      hasTitle: !!title,
    });

    return {
      markdown,
      title,
      format: ext,
      originalSize: buffer.length,
      markdownSize: markdown.length,
      success: true,
    };
  } catch (err) {
    logger.error("Document ingestion failed", { filename, error: String(err) });
    return {
      markdown: "",
      format: ext,
      originalSize: buffer.length,
      markdownSize: 0,
      success: false,
      error: String(err),
    };
  }
}

/**
 * Convert a URL to markdown by fetching and converting its content.
 */
export async function ingestUrl(url: string): Promise<IngestionResult> {
  try {
    const response = await fetch(url, {
      headers: { "Accept": "text/html, text/plain, */*" },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get("content-type") || "";

    // Determine filename from URL
    const urlPath = new URL(url).pathname;
    let filename = urlPath.split("/").pop() || "page.html";

    // If no extension, infer from content-type
    if (!filename.includes(".")) {
      if (contentType.includes("html")) filename += ".html";
      else if (contentType.includes("json")) filename += ".json";
      else if (contentType.includes("xml")) filename += ".xml";
      else if (contentType.includes("plain")) filename += ".txt";
      else filename += ".html";
    }

    const result = await ingestDocument(buffer, filename);

    logger.info("URL ingested", { url, markdownSize: result.markdown.length });

    return {
      ...result,
      format: contentType.split(";")[0] || result.format,
    };
  } catch (err) {
    logger.error("URL ingestion failed", { url, error: String(err) });
    return {
      markdown: "",
      format: "url",
      originalSize: 0,
      markdownSize: 0,
      success: false,
      error: String(err),
    };
  }
}

// Export for testing
export { SUPPORTED_EXTENSIONS };
