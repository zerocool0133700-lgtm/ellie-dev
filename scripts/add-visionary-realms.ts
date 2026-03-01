#!/usr/bin/env bun
/**
 * Add hierarchical knowledge realms under Visionary (path 1/1)
 *
 * Usage:
 *   bun scripts/add-visionary-realms.ts
 */

import { createScope } from "../../ellie-forest/src/knowledge-scopes";

const realms = [
  {
    name: "Personal Growth",
    level: "realm",
    description: "Self-development, learning, habits, mindfulness",
  },
  {
    name: "Professional",
    level: "realm",
    description: "Career, projects, business insights, technical knowledge",
  },
  {
    name: "Health & Wellness",
    level: "realm",
    description: "Physical health, mental health, nutrition, fitness",
  },
  {
    name: "Relationships",
    level: "realm",
    description: "Family, friends, mentors, professional relationships",
  },
  {
    name: "Reference Library",
    level: "realm",
    description: "Facts, how-tos, research, book notes, article summaries",
  },
];

async function main() {
  console.log("Adding knowledge realms under Visionary (path 1/1)...\n");

  for (const realm of realms) {
    try {
      const scope = await createScope({
        parentPath: "1/1", // Visionary
        ...realm,
      });
      console.log(`✓ Created: ${scope.path} — ${scope.name}`);
    } catch (err) {
      console.error(`✗ Failed to create ${realm.name}:`, err);
    }
  }

  console.log("\nDone! Check the dashboard to see your new realms.");
}

main();
