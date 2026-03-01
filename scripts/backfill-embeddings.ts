/**
 * Backfill embeddings for messages and memory tables in Supabase.
 * Uses OpenAI batch embedding API (text-embedding-3-small, 1536 dims).
 * Processes in batches of 500 rows, 100 texts per OpenAI call.
 */

import fs from "fs";
import { createClient } from "@supabase/supabase-js";

// Load env
const envContent = fs.readFileSync(
  new URL("../.env", import.meta.url),
  "utf8",
);
for (const line of envContent.split("\n")) {
  const m = line.match(/^([^#=]+)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim();
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!,
);

const BATCH_SIZE = 100; // rows per OpenAI API call
const FETCH_SIZE = 500; // rows fetched from Supabase at once

async function getEmbeddings(texts: string[]): Promise<number[][]> {
  // Filter empty strings and truncate very long texts
  const truncated = texts.map((t) => (t && t.trim()) ? t.substring(0, 8000) : "empty");

  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: truncated,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI error: ${err}`);
  }

  const { data } = (await res.json()) as {
    data: { embedding: number[]; index: number }[];
  };
  return data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

async function backfillTable(table: string) {
  let totalProcessed = 0;
  let totalErrors = 0;

  while (true) {
    // Fetch rows without embeddings (exclude null/empty content)
    const { data: rows, error } = await supabase
      .from(table)
      .select("id, content")
      .is("embedding", null)
      .not("content", "is", null)
      .neq("content", "")
      .order("created_at", { ascending: true })
      .limit(FETCH_SIZE);

    if (error) {
      console.error(`[${table}] Fetch error:`, error.message);
      break;
    }
    if (!rows?.length) break;

    console.log(
      `[${table}] Fetched ${rows.length} rows without embeddings...`,
    );

    // Filter out rows with empty/null content
    const validRows = rows.filter((r) => r.content && r.content.trim().length > 0);
    if (validRows.length < rows.length) {
      console.log(`[${table}] Skipping ${rows.length - validRows.length} rows with empty content`);
      // Mark empty rows with a placeholder embedding to avoid re-fetching
      for (const row of rows.filter((r) => !r.content || r.content.trim().length === 0)) {
        await supabase.from(table).update({ embedding: JSON.stringify(new Array(1536).fill(0)) }).eq("id", row.id);
      }
    }

    // Process in batches
    for (let i = 0; i < validRows.length; i += BATCH_SIZE) {
      const batch = validRows.slice(i, i + BATCH_SIZE);
      const texts = batch.map((r) => r.content);

      try {
        const embeddings = await getEmbeddings(texts);

        // Update each row with its embedding
        const updates = batch.map((row, idx) =>
          supabase
            .from(table)
            .update({ embedding: JSON.stringify(embeddings[idx]) })
            .eq("id", row.id),
        );

        const results = await Promise.all(updates);
        const errors = results.filter((r) => r.error);
        if (errors.length) {
          console.error(
            `[${table}] ${errors.length} update errors in batch`,
          );
          totalErrors += errors.length;
        }

        totalProcessed += batch.length - errors.length;
        console.log(
          `[${table}] ${totalProcessed} embedded (batch ${Math.floor(i / BATCH_SIZE) + 1})`,
        );
      } catch (err: any) {
        console.error(`[${table}] Batch error:`, err.message);
        totalErrors += batch.length;
        // Brief pause before retry
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  console.log(
    `[${table}] Done: ${totalProcessed} embedded, ${totalErrors} errors`,
  );
  return { processed: totalProcessed, errors: totalErrors };
}

// Run backfill
const tables = process.argv[2] ? [process.argv[2]] : ["memory", "messages"];
console.log(`Starting embedding backfill for: ${tables.join(", ")}...\n`);
const start = Date.now();

const results: Record<string, { processed: number; errors: number }> = {};
for (const table of tables) {
  results[table] = await backfillTable(table);
}

const elapsed = ((Date.now() - start) / 1000).toFixed(1);
console.log(`\nBackfill complete in ${elapsed}s`);
for (const [table, result] of Object.entries(results)) {
  console.log(`  ${table}: ${result.processed} embedded, ${result.errors} errors`);
}

process.exit(0);
