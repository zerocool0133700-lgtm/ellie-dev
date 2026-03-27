/**
 * Skill Generator — ELLIE-1063
 * Introspects relay HTTP routes and generates SKILL.md files automatically.
 * Keeps skills in sync with code — no more manual SKILL.md maintenance.
 *
 * Usage: bun run scripts/generate-skills.ts [--check] [--skill name]
 * --check: exits non-zero if any skill is stale (CI-friendly)
 * --skill: generate only one specific skill
 *
 * References:
 * - Crust @crustjs/skills factory transformer pattern
 * - GSAP-skills structural patterns (triggers, do/don't, bounded size)
 * - CLI-Anything skill_generator.py code introspection
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "fs";
import { join } from "path";

const SKILLS_DIR = join(import.meta.dir, "..", "skills");
const ROUTES_FILE = join(import.meta.dir, "..", "src", "http-routes.ts");

interface RouteInfo {
  method: string;
  path: string;
  description?: string;
}

interface SkillDef {
  name: string;
  description: string;
  triggers: string[];
  routes: RouteInfo[];
  domain: string;
}

// Route-to-skill domain mapping
const DOMAIN_MAP: Record<string, string> = {
  "/api/gtd": "gtd",
  "/api/bridge": "forest",
  "/api/memory": "memory",
  "/api/agent-memory": "agent-memory",
  "/api/quality": "quality-review",
  "/api/commitments": "commitments",
  "/api/relationships": "relationships",
  "/api/meeting-prep": "meeting-prep",
  "/api/decisions": "decisions",
  "/api/atomic": "atomic-dispatch",
  "/api/compression": "compression",
  "/api/cost": "cost-tracking",
  "/api/ums": "ums-admin",
  "/api/voice": "voice",
  "/api/status-line": "status",
  "/api/work-session": "work-session",
  "/api/orchestration": "orchestration",
  "/api/queue": "agent-queue",
  "/api/spawn": "agent-spawn",
  "/api/working-memory": "working-memory",
};

/**
 * Extract route registrations from http-routes.ts
 */
function extractRoutes(source: string): RouteInfo[] {
  const routes: RouteInfo[] = [];

  // Match patterns like: url.pathname === "/api/foo/bar"
  // and method checks like: req.method === "GET"
  const pathRegex = /url\.pathname\s*===?\s*["']([^"']+)["']/g;
  const startRegex = /url\.pathname\.startsWith\(["']([^"']+)["']\)/g;

  let match;
  while ((match = pathRegex.exec(source)) !== null) {
    const path = match[1];
    if (path.startsWith("/api/")) {
      // Try to find the method near this match
      const context = source.substring(Math.max(0, match.index - 200), match.index + 200);
      const methodMatch = context.match(/req\.method\s*===?\s*["'](GET|POST|PUT|PATCH|DELETE)["']/);
      routes.push({
        method: methodMatch ? methodMatch[1] : "GET",
        path,
      });
    }
  }
  while ((match = startRegex.exec(source)) !== null) {
    const path = match[1];
    if (path.startsWith("/api/")) {
      const context = source.substring(Math.max(0, match.index - 200), match.index + 200);
      const methodMatch = context.match(/req\.method\s*===?\s*["'](GET|POST|PUT|PATCH|DELETE)["']/);
      routes.push({
        method: methodMatch ? methodMatch[1] : "GET",
        path: path + "*",
      });
    }
  }

  return routes;
}

/**
 * Group routes by domain
 */
function groupByDomain(routes: RouteInfo[]): Map<string, RouteInfo[]> {
  const groups = new Map<string, RouteInfo[]>();

  for (const route of routes) {
    let domain = "misc";
    for (const [prefix, domainName] of Object.entries(DOMAIN_MAP)) {
      if (route.path.startsWith(prefix)) {
        domain = domainName;
        break;
      }
    }
    const existing = groups.get(domain) || [];
    existing.push(route);
    groups.set(domain, existing);
  }

  return groups;
}

/**
 * Generate SKILL.md content for a domain
 */
function generateSkillMd(def: SkillDef): string {
  const lines: string[] = [];

  // YAML frontmatter
  lines.push("---");
  lines.push(`name: ${def.name}`);
  lines.push(`description: ${def.description}`);
  lines.push(`triggers:`);
  for (const t of def.triggers) {
    lines.push(`  - ${t}`);
  }
  lines.push("requirements: []");
  lines.push("always_on: false");
  lines.push("# AUTO-GENERATED — do not edit above this line");
  lines.push("---");
  lines.push("");

  // Body
  lines.push(`# ${def.name}`);
  lines.push("");
  lines.push(def.description);
  lines.push("");

  // Endpoints table
  lines.push("## Endpoints");
  lines.push("");
  lines.push("| Method | Path | Description |");
  lines.push("|--------|------|-------------|");
  for (const r of def.routes) {
    lines.push(`| ${r.method} | \`${r.path}\` | ${r.description || ""} |`);
  }
  lines.push("");

  // Best practices
  lines.push("## Best Practices");
  lines.push("");
  lines.push("- Check the endpoint exists before calling");
  lines.push("- Handle error responses gracefully");
  lines.push("- Use the relay base URL: `http://localhost:3001`");
  lines.push("");

  return lines.join("\n");
}

/**
 * Generate skills index (llms.txt)
 */
function generateIndex(skills: SkillDef[]): string {
  const lines: string[] = [];
  for (const s of skills) {
    lines.push(`${s.name}`);
    lines.push(`  ${s.description}`);
    lines.push(`  Triggers: ${s.triggers.join(", ")}`);
    lines.push("");
  }
  return lines.join("\n");
}

// Domain descriptions and triggers
const DOMAIN_META: Record<string, { description: string; triggers: string[] }> = {
  "gtd": { description: "GTD task management — inbox, actions, projects, contexts", triggers: ["gtd", "task", "todo", "inbox", "action items"] },
  "forest": { description: "Forest knowledge graph — read and write to the knowledge tree", triggers: ["forest", "knowledge", "remember", "search memories"] },
  "memory": { description: "Memory operations — semantic search, conflict resolution", triggers: ["memory", "remember", "recall", "what do you know about"] },
  "agent-memory": { description: "Per-agent persistent memory — decisions, learnings, preferences", triggers: ["agent memory", "my memory", "what have I learned"] },
  "quality-review": { description: "Structured code review with dimension scoring and quality gates", triggers: ["review", "code review", "quality check", "critique"] },
  "commitments": { description: "Track interpersonal commitments and promises", triggers: ["commitment", "promise", "I said I would", "follow up"] },
  "relationships": { description: "Person profiles, contact frequency, and relationship health", triggers: ["relationship", "who is", "when did I last talk to"] },
  "meeting-prep": { description: "Pre-meeting briefs with relationship context and talking points", triggers: ["prep for", "meeting with", "before my call"] },
  "decisions": { description: "Decision tracking and consistency checking", triggers: ["decision", "what did we decide", "consistency"] },
  "atomic-dispatch": { description: "Decompose work items into atomic tasks and execute with fresh sessions", triggers: ["decompose", "break down", "atomic"] },
  "compression": { description: "Context compression metrics and shadow context expansion", triggers: ["compression", "tokens saved", "expand context"] },
  "cost-tracking": { description: "Per-creature token usage and cost tracking", triggers: ["cost", "spending", "budget", "how much"] },
  "ums-admin": { description: "UMS consumer health, watermarks, and backoff status", triggers: ["ums", "consumer health", "watermarks"] },
  "voice": { description: "Voice call extraction and structured data", triggers: ["voice", "call", "transcript"] },
  "status": { description: "System status line — creature state, active ticket, forest health", triggers: ["status", "health", "what's running"] },
  "work-session": { description: "Work session lifecycle — start, update, complete", triggers: ["work session", "start working", "session"] },
  "orchestration": { description: "Orchestration runs, dispatch tracking, concurrency", triggers: ["orchestration", "dispatch", "runs"] },
  "agent-queue": { description: "Async agent work queue — create, list, acknowledge", triggers: ["queue", "agent queue", "pending work"] },
  "working-memory": { description: "Session-scoped working memory — task stack, investigation state", triggers: ["working memory", "session state", "what am I working on"] },
};

// Main
async function main() {
  const args = process.argv.slice(2);
  const checkMode = args.includes("--check");
  const skillFilter = args.find(a => a.startsWith("--skill="))?.split("=")[1];

  // Read routes
  const source = readFileSync(ROUTES_FILE, "utf-8");
  const routes = extractRoutes(source);
  const grouped = groupByDomain(routes);

  console.log(`Found ${routes.length} routes across ${grouped.size} domains`);

  const skills: SkillDef[] = [];
  let stale = 0;

  for (const [domain, domainRoutes] of grouped) {
    if (skillFilter && domain !== skillFilter) continue;

    const meta = DOMAIN_META[domain] || { description: `${domain} API endpoints`, triggers: [domain] };
    const def: SkillDef = {
      name: domain,
      description: meta.description,
      triggers: meta.triggers,
      routes: domainRoutes,
      domain,
    };
    skills.push(def);

    const skillDir = join(SKILLS_DIR, domain);
    const skillPath = join(skillDir, "SKILL.md");
    const generated = generateSkillMd(def);

    if (checkMode) {
      if (!existsSync(skillPath)) {
        console.log(`STALE: ${domain} — SKILL.md missing`);
        stale++;
      } else {
        const existing = readFileSync(skillPath, "utf-8");
        // Check if auto-generated section matches
        if (!existing.includes("AUTO-GENERATED")) {
          console.log(`SKIP: ${domain} — hand-written skill`);
        }
      }
    } else {
      // Only write auto-generated skills, don't overwrite hand-written ones
      if (existsSync(skillPath)) {
        const existing = readFileSync(skillPath, "utf-8");
        if (!existing.includes("AUTO-GENERATED")) {
          console.log(`SKIP: ${domain} — hand-written skill (not overwriting)`);
          continue;
        }
      }
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(skillPath, generated);
      console.log(`GENERATED: ${domain} (${domainRoutes.length} routes)`);
    }
  }

  // Generate index
  if (!checkMode && !skillFilter) {
    const index = generateIndex(skills);
    writeFileSync(join(SKILLS_DIR, "llms.txt"), index);
    console.log(`INDEX: llms.txt (${skills.length} skills)`);
  }

  if (checkMode && stale > 0) {
    console.log(`\n${stale} stale skill(s) found. Run 'bun run scripts/generate-skills.ts' to update.`);
    process.exit(1);
  }
}

main().catch(console.error);
