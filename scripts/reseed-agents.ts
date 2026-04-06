#!/usr/bin/env bun
/**
 * Reseed agents table — execute seeds/supabase/001_agents.sql
 */

import { readFile } from "fs/promises";

const projectRef = process.env.SUPABASE_PROJECT_REF!;
const accessToken = process.env.SUPABASE_ACCESS_TOKEN!;

if (!projectRef || !accessToken) {
  console.error("Missing SUPABASE_PROJECT_REF or SUPABASE_ACCESS_TOKEN");
  process.exit(1);
}

async function executeSQL(query: string): Promise<unknown> {
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase API error (${res.status}): ${text}`);
  }

  return await res.json();
}

async function main() {
  console.log("Reading seed file...");
  const sql = await readFile("seeds/supabase/001_agents.sql", "utf-8");

  console.log("Executing seed...");
  try {
    await executeSQL(sql);
    console.log("✅ Agents reseeded successfully");
  } catch (error) {
    console.error("❌ Seed failed:", error);
    process.exit(1);
  }
}

main();
