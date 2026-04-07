/**
 * Markdown chunker — paragraph-aware splitting with sentence fallback.
 *
 * Splits a markdown document into chunks of ~targetTokens each, never bleeding
 * sentence-split content across paragraph boundaries.
 *
 * See: docs/superpowers/specs/2026-04-06-knowledge-surface-and-ingestion-design.md
 */

const DEFAULT_TARGET_TOKENS = 500;

export function estimateTokens(s: string): number {
  if (!s) return 0;
  return Math.ceil(s.length / 4);
}

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 0);
}

export function chunkMarkdown(md: string, targetTokens: number = DEFAULT_TARGET_TOKENS): string[] {
  if (!md || md.trim().length === 0) return [];

  const paragraphs = md.split(/\n\n+/).map(p => p.trim()).filter(p => p.length > 0);
  const chunks: string[] = [];
  let buffer = "";

  function flush() {
    if (buffer.trim()) {
      chunks.push(buffer.trim());
    }
    buffer = "";
  }

  for (const p of paragraphs) {
    const pTokens = estimateTokens(p);

    if (pTokens > targetTokens * 1.5) {
      flush();
      const sentences = splitSentences(p);
      let sentBuffer = "";
      for (const s of sentences) {
        const candidate = sentBuffer ? sentBuffer + " " + s : s;
        if (estimateTokens(candidate) > targetTokens && sentBuffer !== "") {
          chunks.push(sentBuffer.trim());
          sentBuffer = s;
        } else {
          sentBuffer = candidate;
        }
      }
      if (sentBuffer.trim()) {
        chunks.push(sentBuffer.trim());
      }
      continue;
    }

    const candidate = buffer ? buffer + "\n\n" + p : p;
    if (estimateTokens(candidate) > targetTokens && buffer !== "") {
      flush();
      buffer = p;
    } else {
      buffer = candidate;
    }
  }

  flush();
  return chunks;
}
