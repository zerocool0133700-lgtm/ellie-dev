#!/usr/bin/env bun
/**
 * Create Team-Oriented GTD Epic with all 24 tickets
 *
 * This script creates the full epic breakdown for transforming the personal GTD
 * system into a multi-agent collaborative workspace.
 */

const PLANE_API_KEY = process.env.PLANE_API_KEY;
const PLANE_BASE_URL = (process.env.PLANE_BASE_URL || "https://plane.ellie-labs.dev").replace(/\/api\/v1\/?$/, "");
const PLANE_WORKSPACE_SLUG = "evelife";
const PROJECT_ID = "7194ace4-b80e-4c83-8042-c925598accf2";

// State IDs
const STATE = {
  TODO: "92d0bdb9-cc96-41e0-b26f-47e82ea6dab8",
  IN_PROGRESS: "e551b5a8-8bad-43dc-868e-9b5fb48c3a9e",
  DONE: "41fddf8d-d937-4964-9888-b27f416dcafa",
};

if (!PLANE_API_KEY) {
  console.error("❌ PLANE_API_KEY not set in .env");
  process.exit(1);
}

async function planeRequest(path: string, options?: RequestInit) {
  const res = await fetch(`${PLANE_BASE_URL}/api/v1/workspaces/${PLANE_WORKSPACE_SLUG}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": PLANE_API_KEY!,
      ...options?.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Plane API ${res.status}: ${body}`);
  }

  return res.json();
}

async function createIssue(
  name: string,
  description: string,
  priority: string = "medium",
  parent?: string,
) {
  const body: Record<string, any> = {
    name,
    description_html: `<p>${description.replace(/\n/g, "<br>")}</p>`,
    priority,
    state: STATE.TODO,
  };

  if (parent) {
    body.parent = parent;
  }

  const issue = await planeRequest(`/projects/${PROJECT_ID}/issues/`, {
    method: "POST",
    body: JSON.stringify(body),
  });

  console.log(`✓ Created ELLIE-${issue.sequence_id}: ${name}`);
  return issue;
}

async function main() {
  console.log("Creating Team-Oriented GTD Epic...\n");

  // Create parent epic
  const epic = await createIssue(
    "Team-Oriented GTD System",
    `Transform the personal GTD system into a multi-agent collaborative workspace.

**Phases:**
- Phase 1: Multi-Agent Foundation (5 tickets)
- Phase 2: Team Dashboard (4 tickets)
- Phase 3: Delegation Flow (6 tickets)
- Phase 4: Team Projects & Dependencies (5 tickets)
- Phase 5: Workload & Reporting (4 tickets)

**Total:** 24 tickets across 5 phases

**Parallelization strategy:**
- Phase 1 (foundation) must complete first
- Phases 2-3 can run in parallel after Phase 1
- Phases 4-5 can run in parallel after Phases 2-3`,
    "high",
  );

  const epicId = epic.id;

  console.log(`\n📦 Epic created: ELLIE-${epic.sequence_id}\n`);
  console.log("Creating child tickets...\n");

  // Phase 1: Multi-Agent Foundation
  console.log("--- Phase 1: Multi-Agent Foundation ---");

  await createIssue(
    "Schema — Add assignment columns to todos",
    `Add multi-agent assignment fields to the todos table:
- assigned_to (agent name)
- assigned_by (delegator agent name)
- delegated_at (timestamp)
- due_back (deadline for delegated task)

Write migration + seed with sample data for Brian and Amy assignments.
Test with Brian and Amy assignment scenarios.`,
    "high",
    epicId,
  );

  await createIssue(
    "Schema — Create project_collaborators table",
    `Define project team membership table:
- project_id
- agent_name
- role (owner/contributor/reviewer)
- added_at
- added_by

Write migration with RLS policies to ensure only project members can view/edit.`,
    "high",
    epicId,
  );

  await createIssue(
    "Schema — Create todo_dependencies table",
    `Track blocking relationships between tasks:
- blocker_id (the task that's blocking)
- blocked_id (the task being blocked)
- created_at

Add constraint to prevent circular dependencies.
Write migration + validation logic.`,
    "medium",
    epicId,
  );

  await createIssue(
    "API — Add agent filtering to GTD endpoints",
    `Update GTD API endpoints:
- GET /api/gtd/todos — filter by assigned_to
- GET /api/gtd/projects — include collaborator lists
- Add agent context to all responses

Test filtering by Dave/Brian/Amy.`,
    "high",
    epicId,
  );

  await createIssue(
    "UI — Add agent filter dropdown to GTD page",
    `Add agent filter UI:
- Dropdown: Dave / Brian / Amy / All
- Persist selection in URL query params
- Color-code todos by assigned agent
- Update breadcrumb to show active filter`,
    "medium",
    epicId,
  );

  // Phase 2: Team Dashboard
  console.log("\n--- Phase 2: Team Dashboard ---");

  await createIssue(
    "API — Team overview endpoint",
    `Create team overview endpoints:
- GET /api/gtd/team/overview — all agents' workload stats
- GET /api/gtd/team/agent/:name — specific agent's full GTD view

Include: next actions count, waiting count, overdue count, priority distribution.`,
    "high",
    epicId,
  );

  await createIssue(
    "UI — Team dashboard page",
    `Create /gtd/team route:
- AgentWorkloadCard component (shows stats per agent)
- Grid layout for all agents
- Click agent → navigate to their lane view
- Visual indicators for overdue/blocked tasks`,
    "medium",
    epicId,
  );

  await createIssue(
    "UI — Next actions across team widget",
    `Combined next actions view:
- List all agents' top-priority next actions
- Sort by priority + due date
- Color-code by agent
- Click action → navigate to that agent's GTD
- Show agent avatar next to each task`,
    "medium",
    epicId,
  );

  await createIssue(
    "UI — Agent lane navigation",
    `Improve navigation:
- Add "Team View" button to main GTD page
- Breadcrumb nav: Team → Agent → Todo
- Persist agent context across navigation
- Quick-switch dropdown in header`,
    "low",
    epicId,
  );

  // Phase 3: Delegation Flow
  console.log("\n--- Phase 3: Delegation Flow ---");

  await createIssue(
    "API — Delegation endpoint",
    `POST /api/gtd/todos/:id/delegate:
- Assign task to target agent
- Move todo to assignee's inbox
- Create waiting-for entry for delegator
- Return delegation record with context
- Validate target agent exists`,
    "high",
    epicId,
  );

  await createIssue(
    "API — Complete delegation endpoint",
    `PATCH /api/gtd/todos/:id/complete-delegation:
- Mark delegated work as done
- Return todo to delegator's inbox for review
- Attach completion notes from agent
- Remove from delegator's waiting-for list
- Update task state`,
    "high",
    epicId,
  );

  await createIssue(
    "UI — Delegation modal",
    `Delegation UI:
- "Delegate" button on todo cards
- Modal: assign to agent, set due_back date, add context note
- Confirm delegation → trigger API + success toast
- Close modal → refresh GTD view
- Show delegation status on card`,
    "medium",
    epicId,
  );

  await createIssue(
    "UI — Waiting-for list enhancements",
    `Enhance waiting-for tab:
- Show delegated tasks with delegate info
- Display: assignee, due back date, days waiting
- Visual indicator for overdue delegations
- Click → view delegation details
- Filter by agent`,
    "medium",
    epicId,
  );

  await createIssue(
    "Relay — Delegation notifications",
    `Notification system for delegations:
- When task delegated → notify assignee (Telegram/Google Chat)
- Include task content + delegator's context note
- When task completed → notify delegator
- Include agent's completion notes
- Support @mentions in notes`,
    "medium",
    epicId,
  );

  await createIssue(
    "Agent prompts — GTD context injection",
    `GTD awareness for agents:
- Auto-inject agent's open tasks into prompt
- Include next action, waiting list, overdue count
- Add "check my tasks" capability
- Test with Brian and Amy
- Update soul files if needed`,
    "medium",
    epicId,
  );

  // Phase 4: Team Projects & Dependencies
  console.log("\n--- Phase 4: Team Projects & Dependencies ---");

  await createIssue(
    "API — Project collaborator management",
    `Collaborator management endpoints:
- POST /api/gtd/projects/:id/collaborators — add agent
- DELETE /api/gtd/projects/:id/collaborators/:agent — remove
- PATCH /api/gtd/projects/:id/collaborators/:agent — update role
- Return full collaborator list with roles`,
    "medium",
    epicId,
  );

  await createIssue(
    "UI — Project collaborator picker",
    `Team section in project editor:
- Multi-select for agents (Brian, Amy, Strategy, etc.)
- Role picker: owner / contributor / reviewer
- Display collaborator avatars on project cards
- Show role badges
- Filter projects by collaborator`,
    "medium",
    epicId,
  );

  await createIssue(
    "API — Task dependencies",
    `Dependency management:
- POST /api/gtd/todos/:id/block — mark as blocked by another task
- GET /api/gtd/todos/:id/blockers — return blocking chain
- Validate no circular dependencies
- Auto-hide blocked tasks from next actions
- Auto-unhide when blockers complete`,
    "high",
    epicId,
  );

  await createIssue(
    "UI — Dependency visualization",
    `Dependency UI:
- "Blocked by" tag on todo cards
- Click tag → navigate to blocking task
- Show dependency chain in todo detail modal
- Visual indicator when blockers complete
- Drag to create dependencies`,
    "low",
    epicId,
  );

  await createIssue(
    "UI — Team project Kanban view",
    `Kanban for shared projects:
- Columns by agent (Dave / Brian / Amy / etc.)
- Drag-drop to reassign between agents
- Show task counts per column
- Filter by project
- Swimlanes option (by priority)`,
    "medium",
    epicId,
  );

  // Phase 5: Workload & Reporting
  console.log("\n--- Phase 5: Workload & Reporting ---");

  await createIssue(
    "API — Agent workload snapshots",
    `Workload tracking:
- Daily snapshot of each agent's open/overdue/waiting counts
- GET /api/gtd/team/workload/history — time series
- GET /api/gtd/team/workload/current — live stats
- Calculate estimated hours if agents report time
- Store in workload_snapshots table`,
    "medium",
    epicId,
  );

  await createIssue(
    "UI — Workload trends chart",
    `Workload visualization:
- Line chart: each agent's open count over time
- Filter by date range (7d / 30d / 90d)
- Stacked area chart option (all agents combined)
- Export to CSV
- Hover tooltips with details`,
    "low",
    epicId,
  );

  await createIssue(
    "UI — Capacity planning view",
    `Capacity management:
- Agent capacity bars (open tasks / max capacity)
- Alerts for overloaded agents (>8 open tasks)
- "Suggest rebalance" button (recommends redistribution)
- Filter by high-priority only
- Set per-agent capacity limits`,
    "low",
    epicId,
  );

  await createIssue(
    "API — Team reporting endpoints",
    `Analytics endpoints:
- GET /api/gtd/team/completed — completed tasks by agent + week
- GET /api/gtd/team/velocity — avg completion time per agent
- GET /api/gtd/team/handoffs — delegation stats
- Export all reports to CSV/JSON
- Date range filtering`,
    "low",
    epicId,
  );

  console.log(`\n✅ Epic created successfully!`);
  console.log(`\n📊 Summary:`);
  console.log(`   Epic: ELLIE-${epic.sequence_id} "Team-Oriented GTD System"`);
  console.log(`   Total tickets: 24`);
  console.log(`   - Phase 1: Multi-Agent Foundation (5 tickets)`);
  console.log(`   - Phase 2: Team Dashboard (4 tickets)`);
  console.log(`   - Phase 3: Delegation Flow (6 tickets)`);
  console.log(`   - Phase 4: Team Projects & Dependencies (5 tickets)`);
  console.log(`   - Phase 5: Workload & Reporting (4 tickets)`);
  console.log(`\n   View in Plane: ${PLANE_BASE_URL}/evelife/projects/ELLIE/issues/${epic.sequence_id}`);
}

main().catch(console.error);
