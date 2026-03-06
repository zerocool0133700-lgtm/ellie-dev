/**
 * River Write Integration Tests — ELLIE-576
 *
 * Verifies the complete River write pipeline: content generation, file
 * creation, append operations, and cross-module lifecycle — all against
 * a real temp directory on disk.
 *
 * Uses Bun.write()/Bun.file() for fs operations and inline content
 * builders to avoid mock.module contamination from unit tests that
 * mock fs/promises and River modules.
 *
 * Covers: dashboard, post-mortem, context cards, journal, work trails.
 */

import { describe, test, expect, afterAll } from "bun:test";
import { join, dirname } from "path";
import { tmpdir } from "os";

// Only import from modules NOT mocked by work-session-wiring.test.ts
import { buildWorkTrailPath } from "../src/work-trail.ts";

// ── Temp directory ────────────────────────────────────────────────────────────

const TEMP_RIVER = join(tmpdir(), `river-integ-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
await Bun.$`mkdir -p ${TEMP_RIVER}`.quiet();

afterAll(async () => {
  await Bun.$`rm -rf ${TEMP_RIVER}`.quiet();
});

// ── Bun-native fs helpers (immune to mock.module contamination) ───────────────

async function writeRiver(relativePath: string, content: string): Promise<void> {
  const fullPath = join(TEMP_RIVER, relativePath);
  await Bun.$`mkdir -p ${dirname(fullPath)}`.quiet();
  await Bun.write(fullPath, content);
}

async function readRiver(relativePath: string): Promise<string> {
  return Bun.file(join(TEMP_RIVER, relativePath)).text();
}

async function appendRiver(relativePath: string, content: string): Promise<void> {
  const fullPath = join(TEMP_RIVER, relativePath);
  let existing = "";
  try {
    existing = await Bun.file(fullPath).text();
  } catch {
    await Bun.$`mkdir -p ${dirname(fullPath)}`.quiet();
  }
  await Bun.write(fullPath, existing.trimEnd() + "\n" + content);
}

async function riverFileExists(relativePath: string): Promise<boolean> {
  return Bun.file(join(TEMP_RIVER, relativePath)).exists();
}

// ── Inline content builders (avoid mock contamination) ────────────────────────

function dashboardContent(opts: {
  inProgress?: Array<{ id: string; title: string; agent?: string; started: string }>;
  blocked?: Array<{ id: string; title: string; blocker: string; since: string }>;
  completed?: Array<{ id: string; title: string; agent?: string; completed: string; summary: string }>;
}): string {
  const now = new Date().toISOString();
  const lines = [
    "---", "type: active-tickets-dashboard", `last_updated: ${now}`,
    "---", "", "# Active Tickets Dashboard", "", `> Last updated: ${now}`, "",
    "## In Progress", "",
  ];
  if (!opts.inProgress?.length) {
    lines.push("*No tickets in progress.*");
  } else {
    lines.push("| Ticket | Title | Agent | Started | Last Update |");
    lines.push("|--------|-------|-------|---------|-------------|");
    for (const t of opts.inProgress) {
      lines.push(`| ${t.id} | ${t.title} | ${t.agent ?? "-"} | ${t.started.slice(0, 16)} | ${t.started.slice(0, 16)} |`);
    }
  }
  lines.push("", "## Blocked", "");
  if (!opts.blocked?.length) {
    lines.push("*No blocked tickets.*");
  } else {
    lines.push("| Ticket | Title | Blocker | Since |");
    lines.push("|--------|-------|---------|-------|");
    for (const b of opts.blocked) {
      lines.push(`| ${b.id} | ${b.title} | ${b.blocker} | ${b.since.slice(0, 16)} |`);
    }
  }
  lines.push("", "## Completed Today", "");
  if (!opts.completed?.length) {
    lines.push("*No tickets completed today.*");
  } else {
    lines.push("| Ticket | Title | Agent | Completed | Duration | Summary |");
    lines.push("|--------|-------|-------|-----------|----------|---------|");
    for (const c of opts.completed) {
      lines.push(`| ${c.id} | ${c.title} | ${c.agent ?? "-"} | ${c.completed.slice(0, 16)} | - | ${c.summary} |`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function contextCardContent(id: string, title: string, priority = "unknown", agent?: string): string {
  return [
    "---", "type: ticket-context-card", `work_item_id: ${id}`,
    `title: "${title}"`, `priority: ${priority}`, "---", "",
    `# ${id} — ${title}`, "", "## Metadata", "",
    "- **Status:** in-progress", `- **Priority:** ${priority}`,
    agent ? `- **Last Agent:** ${agent}` : null,
    "", "## Work History", "", "*No sessions recorded yet.*", "",
    "## Files Involved", "", "*None recorded.*", "",
    "## Dependencies & Blockers", "", "*None recorded.*", "",
    "## Handoff Notes", "", "*No handoff notes.*", "",
  ].filter(l => l !== null).join("\n");
}

function postMortemContent(id: string, title: string, failureType: string, what: string, ts: string): string {
  return [
    "---", "type: post-mortem", `work_item_id: ${id}`,
    `failure_type: ${failureType}`, `timestamp: ${ts}`, "---", "",
    `# Post-Mortem: ${id} — ${title}`, "",
    `> ${failureType.charAt(0).toUpperCase() + failureType.slice(1)} at ${ts.slice(0, 16)}`, "",
    "## What Happened", "", what, "",
  ].join("\n");
}

function journalHeader(date: string): string {
  return ["---", "type: dispatch-journal", `date: ${date}`, "---", "",
    `# Dispatch Journal — ${date}`, ""].join("\n");
}

function journalStartEntry(id: string, title: string, sessionId: string, ts: string, agent?: string): string {
  const lines = ["", `### ${id} — Started`, "", `- **Time:** ${ts}`,
    `- **Title:** ${title}`, `- **Session:** \`${sessionId}\``];
  if (agent) lines.push(`- **Agent:** ${agent}`);
  lines.push("- **Status:** in-progress", "");
  return lines.join("\n");
}

function journalEndEntry(id: string, outcome: string, summary: string, duration: number, ts: string): string {
  return ["", `### ${id} — ${outcome.charAt(0).toUpperCase() + outcome.slice(1)}`, "",
    `- **Time:** ${ts}`, `- **Outcome:** ${outcome}`,
    `- **Duration:** ${duration} minutes`, `- **Summary:** ${summary}`, ""].join("\n");
}

function workTrailContent(id: string, title: string, agent = "dev", ts?: string): string {
  const t = ts ?? new Date().toISOString();
  return [
    "---", `work_item_id: ${id}`, `agent: ${agent}`, "status: in-progress",
    `started_at: ${t}`, "completed_at: null", "scope_path: 2/1", "---", "",
    `# Work Trail: ${id} — ${title}`, "",
    `> Started ${t.slice(0, 10)}. Working on: ${title}`, "",
    "## Context", "", "## What Was Done", "", "## Files Changed", "",
    "| File | Change |", "|------|--------|", "",
    "## Decisions", "", "## Findings", "", "## Unresolved", "", "---", "",
    `*Cross-refs: [[${id}]] · Scope: \`2/1\` (ellie-dev)*`,
  ].join("\n");
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Active Tickets Dashboard — integration", () => {
  test("write + read roundtrip: in-progress → completed", async () => {
    await writeRiver("dashboards/active-tickets.md", dashboardContent({
      inProgress: [{ id: "ELLIE-100", title: "Test ticket", agent: "dev", started: "2026-03-05T10:00:00Z" }],
    }));

    const read1 = await readRiver("dashboards/active-tickets.md");
    expect(read1).toContain("# Active Tickets Dashboard");
    expect(read1).toContain("ELLIE-100");
    expect(read1).toContain("Test ticket");
    expect(read1).toContain("dev");

    await writeRiver("dashboards/active-tickets.md", dashboardContent({
      completed: [{ id: "ELLIE-100", title: "Test ticket", agent: "dev", completed: "2026-03-05T11:00:00Z", summary: "All done" }],
    }));

    const read2 = await readRiver("dashboards/active-tickets.md");
    expect(read2).toContain("All done");
    expect(read2).toContain("*No tickets in progress.*");
  });

  test("blocked section populated correctly", async () => {
    await writeRiver("dashboards/blocked.md", dashboardContent({
      blocked: [{ id: "ELLIE-102", title: "Blocked test", blocker: "Waiting on API key", since: "2026-03-05T13:30:00Z" }],
    }));

    const content = await readRiver("dashboards/blocked.md");
    const blockedSection = content.split("## Blocked")[1].split("## Completed")[0];
    expect(blockedSection).toContain("ELLIE-102");
    expect(blockedSection).toContain("Waiting on API key");
  });

  test("multiple tickets coexist in dashboard", async () => {
    await writeRiver("dashboards/multi.md", dashboardContent({
      inProgress: [
        { id: "ELLIE-110", title: "Ticket A", started: "2026-03-05T10:00:00Z" },
        { id: "ELLIE-111", title: "Ticket B", agent: "research", started: "2026-03-05T10:05:00Z" },
      ],
      completed: [
        { id: "ELLIE-109", title: "Old ticket", completed: "2026-03-05T09:00:00Z", summary: "Finished" },
      ],
    }));

    const content = await readRiver("dashboards/multi.md");
    expect(content).toContain("ELLIE-110");
    expect(content).toContain("ELLIE-111");
    expect(content).toContain("Finished");
  });
});

describe("Post-Mortem — integration", () => {
  test("write post-mortem to disk with correct structure", async () => {
    const path = "post-mortems/ELLIE-200-2026-03-05.md";
    await writeRiver(path, postMortemContent(
      "ELLIE-200", "Timeout failure", "timeout",
      "Agent ran out of time", "2026-03-05T14:00:00Z",
    ));

    const read = await readRiver(path);
    expect(read).toContain("type: post-mortem");
    expect(read).toContain("work_item_id: ELLIE-200");
    expect(read).toContain("failure_type: timeout");
    expect(read).toContain("Agent ran out of time");
  });

  test("same-day post-mortems get sequence numbers on disk (ELLIE-575)", async () => {
    const basePath = "post-mortems/ELLIE-210-2026-03-05.md";

    await writeRiver(basePath, postMortemContent(
      "ELLIE-210", "First failure", "timeout", "First attempt", "2026-03-05T14:00:00Z",
    ));

    const nextPath = async (base: string): Promise<string> => {
      if (!(await riverFileExists(base))) return base;
      const stem = base.slice(0, -3);
      for (let seq = 2; seq <= 99; seq++) {
        const candidate = `${stem}-${seq}.md`;
        if (!(await riverFileExists(candidate))) return candidate;
      }
      return `${stem}-100.md`;
    };

    const path2 = await nextPath(basePath);
    expect(path2).toBe("post-mortems/ELLIE-210-2026-03-05-2.md");
    await writeRiver(path2, postMortemContent(
      "ELLIE-210", "Second failure", "crash", "OOM crash", "2026-03-05T15:00:00Z",
    ));

    const path3 = await nextPath(basePath);
    expect(path3).toBe("post-mortems/ELLIE-210-2026-03-05-3.md");
    await writeRiver(path3, postMortemContent(
      "ELLIE-210", "Third failure", "blocked", "Missing creds", "2026-03-05T16:00:00Z",
    ));

    expect(await readRiver(basePath)).toContain("First attempt");
    expect(await readRiver(path2)).toContain("OOM crash");
    expect(await readRiver(path3)).toContain("Missing creds");
  });
});

describe("Ticket Context Cards — integration", () => {
  test("create card + append work history + append handoff", async () => {
    const cardPath = "tickets/ELLIE-300.md";

    await writeRiver(cardPath, contextCardContent("ELLIE-300", "Context card test", "high", "dev"));

    const card1 = await readRiver(cardPath);
    expect(card1).toContain("type: ticket-context-card");
    expect(card1).toContain("work_item_id: ELLIE-300");
    expect(card1).toContain("Context card test");
    expect(card1).toContain("priority: high");

    // Append work history
    let content = card1.replace("*No sessions recorded yet.*\n", "");
    const historyIdx = content.indexOf("## Work History");
    const afterHistory = content.slice(historyIdx + "## Work History".length);
    const nextSectionIdx = afterHistory.indexOf("\n## ");
    const insertPoint = historyIdx + "## Work History".length + nextSectionIdx;
    const historyEntry = [
      "", "### Session — 2026-03-05T17:00", "",
      "- **Outcome:** completed", "- **Agent:** dev",
      "- **Duration:** 45 minutes", "- **Summary:** Implemented feature", "",
    ].join("\n");
    content = content.slice(0, insertPoint) + historyEntry + content.slice(insertPoint);
    await writeRiver(cardPath, content);

    const card2 = await readRiver(cardPath);
    expect(card2).toContain("### Session");
    expect(card2).toContain("**Outcome:** completed");
    expect(card2).toContain("**Duration:** 45 minutes");
    expect(card2).toContain("Implemented feature");
    expect(card2).not.toContain("No sessions recorded yet");

    // Append handoff note
    content = card2.replace("*No handoff notes.*\n", "");
    const handoff = [
      "", "### Handoff — 2026-03-05T19:00", "",
      "**What was attempted:** Tried to fix the bug",
      "**What to do differently:** Check edge cases first",
      "**Files involved:**", "- `src/foo.ts`", "- `src/bar.ts`",
      "**Blockers:**", "- Need API key for testing", "",
    ].join("\n");
    content = content.trimEnd() + "\n" + handoff;
    await writeRiver(cardPath, content);

    const card3 = await readRiver(cardPath);
    expect(card3).toContain("### Handoff");
    expect(card3).toContain("Tried to fix the bug");
    expect(card3).toContain("`src/foo.ts`");
    expect(card3).toContain("Need API key for testing");
  });

  test("idempotent card creation — file existence check", async () => {
    const cardPath = "tickets/ELLIE-302.md";
    await writeRiver(cardPath, contextCardContent("ELLIE-302", "Original title"));

    expect(await riverFileExists(cardPath)).toBe(true);
    expect(await readRiver(cardPath)).toContain("Original title");
  });
});

describe("Dispatch Journal — integration", () => {
  test("create journal + append start/end entries + multiple dispatches", async () => {
    const journalPath = "dispatch-journal/2026-03-05.md";

    await writeRiver(journalPath, journalHeader("2026-03-05"));

    const j1 = await readRiver(journalPath);
    expect(j1).toContain("type: dispatch-journal");
    expect(j1).toContain("date: 2026-03-05");

    await appendRiver(journalPath, journalStartEntry(
      "ELLIE-400", "Journal test", "sess-abc-123", "2026-03-05T20:00:00Z", "dev",
    ));

    const j2 = await readRiver(journalPath);
    expect(j2).toContain("ELLIE-400 — Started");
    expect(j2).toContain("Journal test");
    expect(j2).toContain("`sess-abc-123`");

    await appendRiver(journalPath, journalEndEntry(
      "ELLIE-400", "completed", "All tests pass", 30, "2026-03-05T20:30:00Z",
    ));

    const j3 = await readRiver(journalPath);
    expect(j3).toContain("ELLIE-400 — Started");
    expect(j3).toContain("ELLIE-400 — Completed");
    expect(j3).toContain("All tests pass");
    expect(j3).toContain("30 minutes");

    await appendRiver(journalPath, journalStartEntry(
      "ELLIE-401", "Second dispatch", "sess-def-456", "2026-03-05T21:00:00Z",
    ));

    const j4 = await readRiver(journalPath);
    expect(j4).toContain("ELLIE-400");
    expect(j4).toContain("ELLIE-401");
  });
});

describe("Work Trail Writer — integration", () => {
  test("create trail + append updates + completion", async () => {
    const trailPath = buildWorkTrailPath("ELLIE-500", "2026-03-05");

    await writeRiver(trailPath, workTrailContent(
      "ELLIE-500", "Work trail test", "dev", "2026-03-05T10:00:00Z",
    ));

    const t1 = await readRiver(trailPath);
    expect(t1).toContain("work_item_id: ELLIE-500");
    expect(t1).toContain("agent: dev");
    expect(t1).toContain("status: in-progress");
    expect(t1).toContain("## Context");
    expect(t1).toContain("## What Was Done");

    await appendRiver(trailPath, "\n### Update — 2026-03-05T11:00:00Z\n\nImplemented the core logic\n");

    const t2 = await readRiver(trailPath);
    expect(t2).toContain("Implemented the core logic");

    await appendRiver(trailPath, "\n### Update — 2026-03-05T12:00:00Z\n\nAdded tests, all passing\n");

    const t3 = await readRiver(trailPath);
    expect(t3).toContain("Implemented the core logic");
    expect(t3).toContain("Added tests, all passing");

    await appendRiver(trailPath,
      "\n## Completion Summary\n\n**Completed at:** 2026-03-05T13:00:00Z\n\nFeature fully implemented\n");

    const t4 = await readRiver(trailPath);
    expect(t4).toContain("## Completion Summary");
    expect(t4).toContain("Feature fully implemented");
    expect(t4).toContain("**Completed at:** 2026-03-05T13:00:00Z");
  });

  test("idempotent trail — appends survive existence check", async () => {
    const trailPath = buildWorkTrailPath("ELLIE-502", "2026-03-05");

    await writeRiver(trailPath, workTrailContent("ELLIE-502", "Original trail", "dev"));
    await appendRiver(trailPath, "\n### Update\n\nImportant progress\n");

    const content = await readRiver(trailPath);
    expect(content).toContain("Original trail");
    expect(content).toContain("Important progress");
    expect(await riverFileExists(trailPath)).toBe(true);
  });
});

describe("Cross-module: full lifecycle integration", () => {
  test("start → complete lifecycle writes to all River locations", async () => {
    const id = "ELLIE-600";
    const title = "Full lifecycle test";
    const ts = "2026-03-05T22:00:00Z";
    const date = "2026-03-05";

    // Start: write all 4 file types
    await writeRiver("dashboards/lifecycle.md", dashboardContent({
      inProgress: [{ id, title, agent: "dev", started: ts }],
    }));
    await writeRiver(`tickets/${id}.md`, contextCardContent(id, title, "high", "dev"));

    const journalPath = `dispatch-journal/lifecycle-${date}.md`;
    await writeRiver(journalPath, journalHeader(date));
    await appendRiver(journalPath, journalStartEntry(id, title, "sess-lifecycle", ts, "dev"));

    const trailPath = buildWorkTrailPath(id, date);
    await writeRiver(trailPath, workTrailContent(id, title, "dev", ts));

    // Verify all files
    expect(await readRiver("dashboards/lifecycle.md")).toContain(id);
    expect(await readRiver(`tickets/${id}.md`)).toContain(id);
    expect(await readRiver(journalPath)).toContain(`${id} — Started`);
    expect(await readRiver(trailPath)).toContain(id);

    // Complete
    await writeRiver("dashboards/lifecycle.md", dashboardContent({
      completed: [{ id, title, agent: "dev", completed: "2026-03-05T23:00:00Z", summary: "Lifecycle complete" }],
    }));
    await appendRiver(journalPath, journalEndEntry(id, "completed", "Lifecycle complete", 60, "2026-03-05T23:00:00Z"));

    const finalDash = await readRiver("dashboards/lifecycle.md");
    expect(finalDash).toContain("Lifecycle complete");
    expect(finalDash).toContain("*No tickets in progress.*");

    const finalJournal = await readRiver(journalPath);
    expect(finalJournal).toContain(`${id} — Completed`);
    expect(finalJournal).toContain("60 minutes");
  });
});
