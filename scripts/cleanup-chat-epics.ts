#!/usr/bin/env bun
/**
 * Clean up duplicate Ellie Chat epics (804/805) and create new Teams Chat epic
 */

import { resolveWorkItemId, getStateIdByGroup, updateIssueState, addIssueComment } from "../src/plane.ts";

const CANCELLED_STATE_ID = "3273d02b-7026-4848-8853-2711d6ba3c9b"; // From CLAUDE.md

async function archiveEpic(workItemId: string) {
  console.log(`\n📦 Archiving ${workItemId}...`);

  const resolved = await resolveWorkItemId(workItemId);
  if (!resolved) {
    console.log(`  ❌ ${workItemId} not found`);
    return;
  }

  const { projectId, issueId } = resolved;

  // Update state to Cancelled
  await updateIssueState(projectId, issueId, CANCELLED_STATE_ID);
  console.log(`  ✅ Moved to Cancelled`);

  // Add comment explaining why
  await addIssueComment(
    projectId,
    issueId,
    `<p>Closed as duplicate/mistake. This epic was created for process isolation, but Epic 804 was meant for the Teams Chat vision. Both archived to avoid confusion.</p><p>The Teams Chat vision is being created as a new epic with proper scope.</p>`
  );
  console.log(`  ✅ Comment added`);
}

async function main() {
  console.log("🧹 Cleaning up Ellie Chat epic confusion...\n");

  // Archive both epics
  await archiveEpic("ELLIE-804");
  await archiveEpic("ELLIE-805");

  console.log("\n✅ Done! Epic 804 and 805 have been archived.");
  console.log("\nNext: Create the new Ellie Teams Chat epic manually in Plane UI.");
  console.log("  Title: Ellie Teams Chat — Multi-Agent Collaboration Platform");
  console.log("  Description: See /home/ellie/ellie-dev/docs/ELLIE-804-breakdown.md");
}

main().catch(console.error);
