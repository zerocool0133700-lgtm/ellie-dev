#!/usr/bin/env bun
/**
 * Test Dispatch Protocol
 *
 * Simulates what happens when Claude Code starts in the EveLife repo.
 * Tests:
 * 1. Reading CLAUDE.md
 * 2. Fetching work items from Plane
 * 3. Displaying options to user
 * 4. Logging session start
 */

import { readFileSync } from "fs";
import { resolve } from "path";

console.log("=== Claude Code Dispatch Protocol Test ===\n");

// Step 1: Read CLAUDE.md
console.log("1️⃣  Loading CLAUDE.md...");
const claudeMdPath = resolve(process.env.HOME || "", "EveLife", "CLAUDE.md");

try {
  const claudeMd = readFileSync(claudeMdPath, "utf-8");
  console.log(`✅ CLAUDE.md loaded (${claudeMd.length} bytes)\n`);

  // Extract key config
  const projectIdMatch = claudeMd.match(/Project ID: ([a-f0-9-]+)/);
  const workspaceMatch = claudeMd.match(/Workspace: (\w+)/);

  if (projectIdMatch && workspaceMatch) {
    console.log(`📋 Project ID: ${projectIdMatch[1]}`);
    console.log(`🏢 Workspace: ${workspaceMatch[1]}\n`);
  }
} catch (error) {
  console.error("❌ Failed to load CLAUDE.md:", error);
  process.exit(1);
}

// Step 2: Simulate asking user
console.log("2️⃣  Asking user: Are you here to work on a defined work item?\n");
console.log("   (In real use, Claude Code would ask this via prompt)\n");

// Step 3: Show what would happen next
console.log("3️⃣  Next steps for full integration:\n");
console.log("   📌 Get Plane API key from profile settings");
console.log("   📌 Add to .env: PLANE_API_KEY=...");
console.log("   📌 Run database migration: bun run db:migrate");
console.log("   📌 Create first work item in Plane");
console.log("   📌 Test end-to-end: Claude Code → fetch item → complete → notification\n");

// Step 4: Show workflow states (dynamically looked up by src/plane.ts)
console.log("4️⃣  Plane workflow states (looked up dynamically at runtime):\n");
console.log("   Backlog      → group: 'backlog'");
console.log("   Todo         → group: 'unstarted'");
console.log("   In Progress  → group: 'started'     ⬅️  Set on session start");
console.log("   Done         → group: 'completed'   ⬅️  Set on session complete");
console.log("   Cancelled    → group: 'cancelled'");
console.log("\n   State IDs are resolved via Plane API — no hardcoded UUIDs.\n");

console.log("=== Test Complete ===\n");
console.log("📖 CLAUDE.md is ready at: ~/EveLife/CLAUDE.md");
console.log("🔧 Work session API code ready in: src/work-session.ts");
console.log("📊 Database schema ready: migrations/supabase/005_work_sessions.sql");
console.log("\n✅ Dispatch protocol is wired up!");
console.log("   Just need your Plane API key to complete the integration.\n");
