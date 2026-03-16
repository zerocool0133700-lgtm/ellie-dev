/**
 * River Write Pipeline — ELLIE-771
 * Takes approved, refined content and writes it to the River vault as markdown files.
 * Pure functions with injected dependencies (fs, sql, qmd) for testability.
 */

import { join, dirname } from "path";

// Types

export interface WriteInput {
  capture_id: string;
  target_path: string;
  target_section: string | null;
  markdown: string;
  dry_run?: boolean;
}

export interface WriteResult {
  success: boolean;
  action: "created" | "merged" | "dry_run";
  file_path: string;
  bytes_written: number;
  error?: string;
}

export interface FileSystem {
  exists(path: string): Promise<boolean>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string): Promise<void>;
}

export interface SqlClient {
  (strings: TemplateStringsArray, ...values: any[]): Promise<any[]>;
}

export interface QmdClient {
  reindex(path: string): Promise<void>;
}

export interface ForestBridge {
  write(content: string, type: string, scopePath: string, metadata?: Record<string, any>): Promise<void>;
}

export interface WriterDeps {
  fs: FileSystem;
  sql: SqlClient;
  qmd: QmdClient;
  bridge: ForestBridge;
  vaultPath: string;
}

// Section merging

export function findSectionInsertPoint(fileContent: string, sectionName: string): { found: boolean; position: number } {
  const lines = fileContent.split("\n");
  const sectionPattern = new RegExp(`^##\\s+${escapeRegex(sectionName)}\\s*$`, "i");

  for (let i = 0; i < lines.length; i++) {
    if (sectionPattern.test(lines[i])) {
      // Find the end of this section (next ## heading or EOF)
      let insertLine = i + 1;
      for (let j = i + 1; j < lines.length; j++) {
        if (/^##\s/.test(lines[j])) {
          // Insert before the next section heading, with blank line
          insertLine = j;
          break;
        }
        insertLine = j + 1;
      }
      // Calculate character position
      let pos = 0;
      for (let k = 0; k < insertLine; k++) {
        pos += lines[k].length + 1; // +1 for \n
      }
      return { found: true, position: pos };
    }
  }

  return { found: false, position: fileContent.length };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function mergeIntoSection(existingContent: string, newContent: string, sectionName: string | null): string {
  if (!sectionName) {
    // Append to end of file
    const trimmed = existingContent.trimEnd();
    return trimmed + "\n\n" + newContent.trim() + "\n";
  }

  const { found, position } = findSectionInsertPoint(existingContent, sectionName);

  if (found) {
    const before = existingContent.slice(0, position).trimEnd();
    const after = existingContent.slice(position);
    return before + "\n\n" + newContent.trim() + "\n\n" + after.trimStart();
  }

  // Section not found — append new section at end
  const trimmed = existingContent.trimEnd();
  return trimmed + "\n\n## " + sectionName + "\n\n" + newContent.trim() + "\n";
}

// Strip frontmatter from content to merge (avoid duplicate frontmatter)

export function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith("---")) return markdown;
  const endIdx = markdown.indexOf("---", 3);
  if (endIdx === -1) return markdown;
  return markdown.slice(endIdx + 3).trim();
}

// Main write pipeline

export async function writeToRiver(input: WriteInput, deps: WriterDeps): Promise<WriteResult> {
  const fullPath = join(deps.vaultPath, input.target_path);

  if (input.dry_run) {
    return {
      success: true,
      action: "dry_run",
      file_path: fullPath,
      bytes_written: Buffer.byteLength(input.markdown, "utf-8"),
    };
  }

  try {
    const fileExists = await deps.fs.exists(fullPath);

    let finalContent: string;
    let action: "created" | "merged";

    if (fileExists) {
      const existing = await deps.fs.readFile(fullPath);
      const contentToMerge = stripFrontmatter(input.markdown);
      finalContent = mergeIntoSection(existing, contentToMerge, input.target_section);
      action = "merged";
    } else {
      // Ensure directory exists
      await deps.fs.mkdir(dirname(fullPath));
      finalContent = input.markdown;
      action = "created";
    }

    await deps.fs.writeFile(fullPath, finalContent);
    const bytesWritten = Buffer.byteLength(finalContent, "utf-8");

    // Update capture queue status
    await deps.sql`
      UPDATE capture_queue SET status = 'written', processed_at = NOW()
      WHERE id = ${input.capture_id}
    `;

    // Trigger QMD re-index
    try {
      await deps.qmd.reindex(input.target_path);
    } catch {
      // Non-fatal — file is written, reindex can be retried
    }

    // Log to Forest
    try {
      await deps.bridge.write(
        `River write: ${action} ${input.target_path}`,
        "fact",
        "2/1",
        { work_item_id: "ELLIE-771", file_path: input.target_path, action },
      );
    } catch {
      // Non-fatal
    }

    return { success: true, action, file_path: fullPath, bytes_written: bytesWritten };
  } catch (err: any) {
    return {
      success: false,
      action: "created",
      file_path: fullPath,
      bytes_written: 0,
      error: err.message ?? "Unknown error",
    };
  }
}
