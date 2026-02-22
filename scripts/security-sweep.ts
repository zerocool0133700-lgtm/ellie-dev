#!/usr/bin/env bun
/**
 * Security Sweep — Automated security checks for the Ellie system.
 *
 * Checks file permissions, endpoint auth, secret hygiene, network surface,
 * dependency vulnerabilities, service hardening, Supabase RLS, MCP health,
 * SSL/TLS, and Cloudflare tunnel configuration.
 *
 * Usage: bun run scripts/security-sweep.ts
 * Also importable: import { runSecuritySweep } from "../scripts/security-sweep.ts"
 */

import { resolve } from "path";
import { execSync } from "child_process";
import { stat, readFile, access } from "fs/promises";
import { constants } from "fs";

// Types
type Severity = "critical" | "high" | "medium" | "low" | "info";

type Category =
  | "file_permissions"
  | "endpoint_auth"
  | "secret_hygiene"
  | "network_surface"
  | "dependency_audit"
  | "service_hardening"
  | "supabase_rls"
  | "mcp_health"
  | "ssl_tls"
  | "cloudflare_tunnel";

interface SecurityFinding {
  severity: Severity;
  category: Category;
  title: string;
  description: string;
  recommendation: string;
  current_value?: string;
  expected_value?: string;
}

export interface SecuritySweepResult {
  timestamp: string;
  duration_ms: number;
  findings: SecurityFinding[];
  summary: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    info: number;
    total: number;
  };
}

const HOME = process.env.HOME || "/home/ellie";
const PROJECT_ROOT = resolve(import.meta.dir, "..");
const DASHBOARD_ROOT = resolve(HOME, "ellie-home");

// === CHECK 1: File Permissions ===
async function checkFilePermissions(): Promise<SecurityFinding[]> {
  const findings: SecurityFinding[] = [];

  const files = [
    { path: resolve(PROJECT_ROOT, ".env"), label: "ellie-dev/.env", expected: "600" },
    { path: resolve(DASHBOARD_ROOT, ".env"), label: "ellie-home/.env", expected: "600" },
    { path: resolve(HOME, ".cloudflared/247d1cc4-71d9-4e42-996d-67b4974e2c67.json"), label: "Cloudflare tunnel credentials", expected: "600" },
  ];

  for (const file of files) {
    try {
      const s = await stat(file.path);
      const mode = (s.mode & 0o777).toString(8);
      const groupOther = s.mode & 0o077;

      if (groupOther !== 0) {
        findings.push({
          severity: file.path.endsWith(".env") ? "critical" : "high",
          category: "file_permissions",
          title: `${file.label} is world/group-readable`,
          description: `File permissions are ${mode}. Group and other users can read secrets.`,
          recommendation: `Run: chmod 600 ${file.path}`,
          current_value: mode,
          expected_value: file.expected,
        });
      } else {
        findings.push({
          severity: "info",
          category: "file_permissions",
          title: `${file.label} permissions OK`,
          description: `File permissions are ${mode}.`,
          recommendation: "No action needed.",
          current_value: mode,
          expected_value: file.expected,
        });
      }
    } catch {
      // File doesn't exist — not a finding
    }
  }

  // Check SSH keys
  try {
    const sshDir = resolve(HOME, ".ssh");
    await access(sshDir, constants.R_OK);
    const sshFiles = execSync(`ls -la ${sshDir} 2>/dev/null`, { encoding: "utf-8" });
    const keyLines = sshFiles.split("\n").filter((l) => l.includes("id_") && !l.includes(".pub"));
    for (const line of keyLines) {
      const perms = line.split(/\s+/)[0];
      if (perms && !perms.startsWith("-rw-------")) {
        findings.push({
          severity: "high",
          category: "file_permissions",
          title: "SSH private key has loose permissions",
          description: `Key file has permissions: ${perms}`,
          recommendation: "Run: chmod 600 on SSH private keys",
          current_value: perms,
          expected_value: "-rw-------",
        });
      }
    }
  } catch {
    // No SSH dir
  }

  return findings;
}

// === CHECK 2: Endpoint Auth (Static Analysis) ===
async function checkEndpointAuth(): Promise<SecurityFinding[]> {
  const findings: SecurityFinding[] = [];

  // Known endpoint map with auth status
  const endpoints: Array<{
    path: string;
    method: string;
    hasAuth: boolean;
    authType?: string;
    writesDB: boolean;
    runsCommands: boolean;
    severity: Severity;
  }> = [
    { path: "/voice", method: "POST", hasAuth: true, authType: "Twilio signature", writesDB: true, runsCommands: false, severity: "info" },
    { path: "/google-chat", method: "POST", hasAuth: true, authType: "Email allowlist", writesDB: true, runsCommands: false, severity: "info" },
    { path: "/health", method: "GET", hasAuth: false, writesDB: false, runsCommands: false, severity: "info" },
    { path: "/queue-status", method: "GET", hasAuth: false, writesDB: false, runsCommands: false, severity: "info" },
    { path: "/api/token-health", method: "GET", hasAuth: false, writesDB: false, runsCommands: false, severity: "low" },
    { path: "/api/consolidate", method: "POST", hasAuth: false, writesDB: true, runsCommands: false, severity: "medium" },
    { path: "/api/extract-ideas", method: "POST", hasAuth: false, writesDB: true, runsCommands: true, severity: "medium" },
    { path: "/api/work-session/start", method: "POST", hasAuth: false, writesDB: true, runsCommands: false, severity: "medium" },
    { path: "/api/work-session/update", method: "POST", hasAuth: false, writesDB: true, runsCommands: false, severity: "medium" },
    { path: "/api/work-session/complete", method: "POST", hasAuth: false, writesDB: true, runsCommands: false, severity: "medium" },
    { path: "/api/rollup/generate", method: "POST", hasAuth: false, writesDB: true, runsCommands: true, severity: "medium" },
    { path: "/api/rollup/latest", method: "GET", hasAuth: false, writesDB: false, runsCommands: false, severity: "low" },
    { path: "/api/security-sweep", method: "GET", hasAuth: false, writesDB: false, runsCommands: true, severity: "low" },
  ];

  // Load cloudflared tunnel config to check which paths are actually exposed
  let tunnelPaths: string[] = [];
  for (const cfgPath of ["/etc/cloudflared/config.yml", resolve(HOME, ".cloudflared/config.yml")]) {
    try {
      const cfgContent = await readFile(cfgPath, "utf-8");
      const pathMatches = cfgContent.match(/path:\s+(.+)/g) || [];
      tunnelPaths = pathMatches.map(m => m.replace("path:", "").trim().replace(/[\^$]/g, ""));
      break;
    } catch { /* try next */ }
  }

  const unauthed = endpoints.filter((e) => !e.hasAuth);
  const writeEndpoints = unauthed.filter((e) => e.writesDB || e.runsCommands);

  // Split into tunnel-exposed vs localhost-only
  const exposedWrite = writeEndpoints.filter(e => tunnelPaths.some(tp => e.path.startsWith(tp) || tp.startsWith(e.path.slice(1))));
  const localhostWrite = writeEndpoints.filter(e => !tunnelPaths.some(tp => e.path.startsWith(tp) || tp.startsWith(e.path.slice(1))));

  if (exposedWrite.length > 0) {
    findings.push({
      severity: "medium",
      category: "endpoint_auth",
      title: `${exposedWrite.length} tunnel-exposed write endpoints have no authentication`,
      description: `Endpoints: ${exposedWrite.map((e) => `${e.method} ${e.path}`).join(", ")}. These are reachable via the Cloudflare tunnel and modify database or spawn processes with no auth.`,
      recommendation: "Add a shared secret header check or application-level auth.",
    });
  }

  if (localhostWrite.length > 0) {
    findings.push({
      severity: "low",
      category: "endpoint_auth",
      title: `${localhostWrite.length} localhost-only write endpoints have no authentication`,
      description: `Endpoints: ${localhostWrite.map((e) => `${e.method} ${e.path}`).join(", ")}. These are NOT in the cloudflared tunnel config — only reachable from localhost. Called by the dashboard (which is behind CF Access).`,
      recommendation: "Consider adding a shared secret header for defense-in-depth, but risk is low.",
    });
  }

  // Check for authenticated endpoints
  const authed = endpoints.filter((e) => e.hasAuth);
  for (const ep of authed) {
    findings.push({
      severity: "info",
      category: "endpoint_auth",
      title: `${ep.method} ${ep.path} has ${ep.authType} auth`,
      description: `Properly authenticated via ${ep.authType}.`,
      recommendation: "No action needed.",
    });
  }

  // Scan relay.ts for any endpoints not in our map
  try {
    const relaySource = await readFile(resolve(PROJECT_ROOT, "src/relay.ts"), "utf-8");
    const pathMatches = relaySource.match(/url\.pathname\s*===?\s*["']([^"']+)["']/g) || [];
    const knownPaths = new Set(endpoints.map((e) => e.path));

    for (const match of pathMatches) {
      const pathMatch = match.match(/["']([^"']+)["']/);
      if (pathMatch) {
        const path = pathMatch[1];
        // Skip dynamic sub-paths
        if (!knownPaths.has(path) && !path.startsWith("/api/rollup/") && !path.startsWith("/api/work-session/") && path !== "/media-stream") {
          findings.push({
            severity: "medium",
            category: "endpoint_auth",
            title: `Unknown endpoint: ${path}`,
            description: "This endpoint was found in relay.ts but is not in the security sweep's known endpoint map.",
            recommendation: "Review this endpoint and add it to the security sweep map.",
            current_value: path,
          });
        }
      }
    }
  } catch {
    // Can't read relay.ts
  }

  return findings;
}

// === CHECK 3: Secret Hygiene ===
async function checkSecretHygiene(): Promise<SecurityFinding[]> {
  const findings: SecurityFinding[] = [];

  const criticalKeys = [
    "TELEGRAM_BOT_TOKEN",
    "SUPABASE_URL",
    "SUPABASE_ANON_KEY",
  ];

  const sensitiveKeys = [
    { key: "TWILIO_AUTH_TOKEN", note: "validateTwilioSignature() returns true when empty, bypassing webhook auth" },
    { key: "ELEVENLABS_API_KEY", note: "Voice features will fail" },
    { key: "ANTHROPIC_API_KEY", note: "Direct API calls will fail (CLI uses Max subscription instead)" },
    { key: "PLANE_API_KEY", note: "Plane integration will fail" },
    { key: "GOOGLE_CHAT_OAUTH_REFRESH_TOKEN", note: "Google Chat will be disabled" },
  ];

  const placeholders = ["your-key-here", "xxx", "changeme", "TODO", "FIXME", "replace-me", "sk-test"];

  try {
    const envContent = await readFile(resolve(PROJECT_ROOT, ".env"), "utf-8");
    const envVars: Record<string, string> = {};

    for (const line of envContent.split("\n")) {
      const match = line.match(/^([A-Z_]+)=(.*)$/);
      if (match) envVars[match[1]] = match[2].trim();
    }

    // Check critical keys
    for (const key of criticalKeys) {
      if (!envVars[key] || envVars[key] === "") {
        findings.push({
          severity: "critical",
          category: "secret_hygiene",
          title: `${key} is empty or missing`,
          description: `Critical environment variable ${key} is not set. Core functionality will not work.`,
          recommendation: `Set ${key} in .env`,
        });
      }
    }

    // Check sensitive keys
    for (const { key, note } of sensitiveKeys) {
      if (!envVars[key] || envVars[key] === "") {
        const isTwilio = key === "TWILIO_AUTH_TOKEN";
        findings.push({
          severity: isTwilio ? "critical" : "medium",
          category: "secret_hygiene",
          title: `${key} is empty`,
          description: `${note}`,
          recommendation: isTwilio
            ? "Set TWILIO_AUTH_TOKEN to enable webhook signature validation. Without it, anyone can send fake Twilio requests."
            : `Set ${key} in .env if this feature is needed.`,
        });
      }
    }

    // Check for placeholder values
    for (const [key, value] of Object.entries(envVars)) {
      if (placeholders.some((p) => value.toLowerCase().includes(p))) {
        findings.push({
          severity: "high",
          category: "secret_hygiene",
          title: `${key} contains a placeholder value`,
          description: `Value appears to be a placeholder: "${value.substring(0, 20)}..."`,
          recommendation: `Replace ${key} with a real value.`,
        });
      }
    }
  } catch {
    findings.push({
      severity: "high",
      category: "secret_hygiene",
      title: "Cannot read .env file",
      description: "The .env file could not be read for secret hygiene checks.",
      recommendation: "Ensure the .env file exists and is readable by the relay user.",
    });
  }

  return findings;
}

// === CHECK 4: Network Surface ===
async function checkNetworkSurface(): Promise<SecurityFinding[]> {
  const findings: SecurityFinding[] = [];

  try {
    const output = execSync("ss -tlnp 2>/dev/null", { encoding: "utf-8" });
    const lines = output.split("\n").filter((l) => l.includes("LISTEN"));

    const knownPorts: Record<string, string> = {
      "3000": "Nuxt dashboard (ellie-home)",
      "3001": "Relay server (ellie-dev)",
      "5432": "PostgreSQL",
      "8082": "Plane",
      "9200": "Elasticsearch",
    };

    for (const line of lines) {
      const match = line.match(/(\*|0\.0\.0\.0|::):(\d+)/);
      if (match) {
        const port = match[2];
        const bindAddr = match[1];
        const isWildcard = bindAddr === "*" || bindAddr === "0.0.0.0" || bindAddr === "::";
        const service = knownPorts[port];

        if (isWildcard && service && ["3000", "3001"].includes(port)) {
          findings.push({
            severity: "medium",
            category: "network_surface",
            title: `${service} binds to all interfaces (port ${port})`,
            description: `Port ${port} listens on ${bindAddr}, accessible from any network interface. In production, should bind to 127.0.0.1.`,
            recommendation: `Configure ${service} to bind to 127.0.0.1. Cloudflare tunnel handles external access.`,
            current_value: `${bindAddr}:${port}`,
            expected_value: `127.0.0.1:${port}`,
          });
        }

        if (!service && isWildcard) {
          findings.push({
            severity: "low",
            category: "network_surface",
            title: `Unknown service on port ${port} (all interfaces)`,
            description: `Port ${port} is listening on ${bindAddr} but is not a known Ellie service.`,
            recommendation: "Verify this is expected. If not needed, stop the service or restrict to localhost.",
            current_value: `${bindAddr}:${port}`,
          });
        }
      }
    }
  } catch {
    findings.push({
      severity: "info",
      category: "network_surface",
      title: "Cannot check network ports",
      description: "ss command not available or failed.",
      recommendation: "Install iproute2 or check ports manually.",
    });
  }

  return findings;
}

// === CHECK 5: Dependency Audit ===
async function checkDependencyAudit(): Promise<SecurityFinding[]> {
  const findings: SecurityFinding[] = [];

  for (const { root, name } of [
    { root: PROJECT_ROOT, name: "ellie-dev" },
    { root: DASHBOARD_ROOT, name: "ellie-home" },
  ]) {
    try {
      const output = execSync("npm audit --json --omit=dev 2>/dev/null", {
        cwd: root,
        encoding: "utf-8",
        timeout: 20_000,
      });
      const audit = JSON.parse(output);
      const vulns = audit.metadata?.vulnerabilities || {};
      const total = (vulns.critical || 0) + (vulns.high || 0) + (vulns.moderate || 0) + (vulns.low || 0);

      if (vulns.critical > 0) {
        findings.push({
          severity: "critical",
          category: "dependency_audit",
          title: `${name}: ${vulns.critical} critical dependency vulnerabilities`,
          description: `npm audit found ${total} total vulnerabilities (${vulns.critical} critical, ${vulns.high || 0} high).`,
          recommendation: `Run: cd ${root} && npm audit fix`,
        });
      } else if (vulns.high > 0) {
        findings.push({
          severity: "high",
          category: "dependency_audit",
          title: `${name}: ${vulns.high} high dependency vulnerabilities`,
          description: `npm audit found ${total} total vulnerabilities (${vulns.high} high, ${vulns.moderate || 0} moderate).`,
          recommendation: `Run: cd ${root} && npm audit fix`,
        });
      } else if (total > 0) {
        findings.push({
          severity: "low",
          category: "dependency_audit",
          title: `${name}: ${total} dependency vulnerabilities (low/moderate)`,
          description: `npm audit found ${total} total (${vulns.moderate || 0} moderate, ${vulns.low || 0} low).`,
          recommendation: `Run: cd ${root} && npm audit fix`,
        });
      } else {
        findings.push({
          severity: "info",
          category: "dependency_audit",
          title: `${name}: No known vulnerabilities`,
          description: "npm audit found 0 vulnerabilities.",
          recommendation: "No action needed.",
        });
      }
    } catch {
      findings.push({
        severity: "info",
        category: "dependency_audit",
        title: `${name}: Dependency audit unavailable`,
        description: "npm audit failed or is not available. Bun does not natively support audit.",
        recommendation: "Run npm audit manually or use a dedicated vulnerability scanner.",
      });
    }
  }

  return findings;
}

// === CHECK 6: Service Hardening ===
async function checkServiceHardening(): Promise<SecurityFinding[]> {
  const findings: SecurityFinding[] = [];

  const unitPath = resolve(HOME, ".config/systemd/user/claude-telegram-relay.service");

  try {
    const content = await readFile(unitPath, "utf-8");

    const hardeningChecks = [
      { directive: "PrivateTmp=true", description: "Isolates /tmp to prevent tmp file attacks" },
      { directive: "NoNewPrivileges=true", description: "Prevents privilege escalation" },
      { directive: "ProtectSystem=strict", description: "Makes system directories read-only" },
    ];

    for (const check of hardeningChecks) {
      if (!content.includes(check.directive.split("=")[0])) {
        findings.push({
          severity: "medium",
          category: "service_hardening",
          title: `Missing ${check.directive} in relay service`,
          description: `${check.description}. Not present in systemd unit file.`,
          recommendation: `Add ${check.directive} to [Service] section of ${unitPath}`,
          expected_value: check.directive,
        });
      }
    }

    // Check restart policy
    if (content.includes("Restart=on-failure")) {
      findings.push({
        severity: "info",
        category: "service_hardening",
        title: "Relay service has restart policy",
        description: "Service is configured to restart on failure with RestartSec delay.",
        recommendation: "No action needed.",
      });
    }
  } catch {
    findings.push({
      severity: "info",
      category: "service_hardening",
      title: "Cannot read systemd unit file",
      description: `Unit file not found at ${unitPath}`,
      recommendation: "Verify the relay service is configured correctly.",
    });
  }

  return findings;
}

// === CHECK 7: Supabase RLS ===
async function checkSupabaseRLS(): Promise<SecurityFinding[]> {
  const findings: SecurityFinding[] = [];

  try {
    const schemaPath = resolve(PROJECT_ROOT, "db/schema.sql");
    const content = await readFile(schemaPath, "utf-8");

    // Find all RLS-enabled tables
    const rlsTables = content.match(/ALTER TABLE (\w+) ENABLE ROW LEVEL SECURITY/g) || [];
    const permissivePolicies = content.match(/CREATE POLICY .* USING \(true\)/g) || [];

    if (permissivePolicies.length > 0) {
      findings.push({
        severity: "medium",
        category: "supabase_rls",
        title: `${permissivePolicies.length} Supabase RLS policies use USING (true)`,
        description: `Tables have RLS enabled but policies grant full access to all roles including anon. The anon key in .env grants unrestricted CRUD.`,
        recommendation: "Change policies to USING (auth.role() = 'service_role') or use the service role key for the relay connection.",
      });
    }

    if (rlsTables.length > 0) {
      findings.push({
        severity: "info",
        category: "supabase_rls",
        title: `${rlsTables.length} tables have RLS enabled`,
        description: `Row Level Security is active on: ${rlsTables.map((t) => t.match(/TABLE (\w+)/)?.[1]).join(", ")}`,
        recommendation: "No action needed — RLS is enabled. Review policies for strictness.",
      });
    }
  } catch {
    findings.push({
      severity: "info",
      category: "supabase_rls",
      title: "Cannot read schema.sql",
      description: "Schema file not found. Cannot verify RLS policies.",
      recommendation: "Verify RLS policies in the Supabase dashboard.",
    });
  }

  return findings;
}

// === CHECK 8: MCP Server Health ===
async function checkMCPHealth(): Promise<SecurityFinding[]> {
  const findings: SecurityFinding[] = [];

  try {
    const claudePath = process.env.CLAUDE_PATH || resolve(HOME, ".local/bin/claude");
    const output = execSync(`CLAUDECODE= ${claudePath} mcp list 2>&1`, {
      encoding: "utf-8",
      timeout: 15_000,
      env: { ...process.env, CLAUDECODE: "" },
    });

    const lines = output.split("\n").filter((l) => l.includes(" - "));
    let connected = 0;
    let failed = 0;

    for (const line of lines) {
      if (line.includes("✓ Connected")) {
        connected++;
      } else if (line.includes("✗ Failed")) {
        failed++;
        const name = line.split(":")[0].trim();
        findings.push({
          severity: "low",
          category: "mcp_health",
          title: `MCP server "${name}" is not connected`,
          description: `Server failed health check. It may need to be started or reconfigured.`,
          recommendation: "Run: claude mcp list — check server configuration and dependencies.",
        });
      }
    }

    if (connected > 0) {
      findings.push({
        severity: "info",
        category: "mcp_health",
        title: `${connected} MCP servers connected, ${failed} failed`,
        description: `${connected + failed} total MCP servers configured.`,
        recommendation: failed > 0 ? "Review failed servers above." : "All servers healthy.",
      });
    }
  } catch {
    findings.push({
      severity: "info",
      category: "mcp_health",
      title: "Cannot check MCP server health",
      description: "Claude CLI not available or timed out.",
      recommendation: "Run: claude mcp list — manually verify server status.",
    });
  }

  return findings;
}

// === CHECK 9: SSL/TLS ===
async function checkSSLTLS(): Promise<SecurityFinding[]> {
  const findings: SecurityFinding[] = [];

  try {
    const envContent = await readFile(resolve(PROJECT_ROOT, ".env"), "utf-8");
    const publicUrl = envContent.match(/^PUBLIC_URL=(.*)$/m)?.[1]?.trim();

    if (publicUrl && !publicUrl.startsWith("https://")) {
      findings.push({
        severity: "medium",
        category: "ssl_tls",
        title: "PUBLIC_URL does not use HTTPS",
        description: `PUBLIC_URL is set to "${publicUrl}". Twilio callbacks and webhooks should use HTTPS.`,
        recommendation: "Change PUBLIC_URL to use https:// (Cloudflare tunnel provides TLS termination).",
        current_value: publicUrl,
        expected_value: publicUrl.replace("http://", "https://"),
      });
    } else if (publicUrl) {
      findings.push({
        severity: "info",
        category: "ssl_tls",
        title: "PUBLIC_URL uses HTTPS",
        description: `PUBLIC_URL: ${publicUrl}. TLS is handled by Cloudflare tunnel.`,
        recommendation: "No action needed.",
      });
    }
  } catch {
    // Can't read .env
  }

  return findings;
}

// === CHECK 10: Cloudflare Tunnel ===
async function checkCloudflareTunnel(): Promise<SecurityFinding[]> {
  const findings: SecurityFinding[] = [];

  const configPaths = [
    "/etc/cloudflared/config.yml",
    resolve(HOME, ".cloudflared/config.yml"),
  ];

  let content: string | null = null;
  for (const path of configPaths) {
    try {
      content = await readFile(path, "utf-8");
      break;
    } catch {
      // Try next
    }
  }

  if (!content) {
    findings.push({
      severity: "info",
      category: "cloudflare_tunnel",
      title: "Cannot read cloudflared config",
      description: "Config file not found at expected locations.",
      recommendation: "Verify cloudflared is configured correctly.",
    });
    return findings;
  }

  // Check for catch-all route to dashboard
  // A catch-all is dangerous when it routes ellie.ellie-labs.dev (the public domain)
  // to the dashboard. If the dashboard is on its own subdomain (e.g. dashboard.ellie-labs.dev),
  // that's fine — CF Access protects it at the edge.
  const dashboardLines = content.split("\n");
  let hasDangerousCatchAll = false;
  for (let i = 0; i < dashboardLines.length; i++) {
    const line = dashboardLines[i].trim();
    if (line === "service: http://localhost:3000") {
      // Check if the preceding hostname is NOT a dedicated dashboard subdomain
      const prevHostname = dashboardLines.slice(Math.max(0, i - 3), i)
        .map(l => l.trim())
        .find(l => l.includes("hostname:"));
      const hostname = prevHostname?.replace("hostname:", "").trim() || "";
      if (!hostname.includes("dashboard")) {
        hasDangerousCatchAll = true;
      }
    }
  }
  if (hasDangerousCatchAll) {
    findings.push({
      severity: "high",
      category: "cloudflare_tunnel",
      title: "Catch-all tunnel rule exposes all dashboard APIs",
      description: "The cloudflared config routes all unmatched paths to the dashboard (port 3000). This means every dashboard API endpoint (including restart-relay, restart-service) is publicly accessible.",
      recommendation: "Move the dashboard to a dedicated subdomain (e.g. dashboard.ellie-labs.dev) and add Cloudflare Access policy.",
    });
  }

  // Check for unanchored path rules
  const pathRules = content.match(/path:\s+(.+)/g) || [];
  for (const rule of pathRules) {
    const path = rule.replace("path:", "").trim();
    if (!path.startsWith("^") && !path.startsWith("regex:")) {
      findings.push({
        severity: "medium",
        category: "cloudflare_tunnel",
        title: `Tunnel path rule may match too broadly: ${path}`,
        description: `Path "${path}" is not anchored with ^ regex. It may match unintended URLs containing this substring.`,
        recommendation: `Use anchored regex: ^${path}$ or ^${path}`,
        current_value: path,
        expected_value: `^${path}$`,
      });
    }
  }

  // Check for Cloudflare Access — verify via dashboard env vars and middleware
  // CF Access vars live in the dashboard's .env, not the relay's
  let cfTeam = process.env.CF_ACCESS_TEAM;
  let cfAud = process.env.CF_ACCESS_AUD;
  if (!cfTeam || !cfAud) {
    try {
      const dashEnv = await readFile(resolve(DASHBOARD_ROOT, ".env"), "utf-8");
      for (const line of dashEnv.split("\n")) {
        const m = line.match(/^(CF_ACCESS_TEAM|CF_ACCESS_AUD)=(.+)$/);
        if (m) {
          if (m[1] === "CF_ACCESS_TEAM") cfTeam = m[2].trim();
          if (m[1] === "CF_ACCESS_AUD") cfAud = m[2].trim();
        }
      }
    } catch {
      // Can't read dashboard .env
    }
  }
  let dashboardHasTunnelGuard = false;
  try {
    const guardPath = resolve(DASHBOARD_ROOT, "server/middleware/tunnel-guard.ts");
    const guardContent = await readFile(guardPath, "utf-8");
    dashboardHasTunnelGuard = guardContent.includes("validateCfAccessJwt") || guardContent.includes("cf-access-jwt-assertion");
  } catch {
    // tunnel-guard.ts doesn't exist
  }

  if (cfTeam && cfAud && dashboardHasTunnelGuard) {
    findings.push({
      severity: "info",
      category: "cloudflare_tunnel",
      title: "Cloudflare Access configured for dashboard",
      description: `CF Access team "${cfTeam}" with JWT validation in tunnel-guard middleware. Dashboard requires authenticated CF Access session.`,
      recommendation: "No action needed. Verify the Access policy is active in the CF Zero Trust dashboard.",
    });
  } else if (cfTeam && cfAud) {
    findings.push({
      severity: "medium",
      category: "cloudflare_tunnel",
      title: "CF Access env vars set but no JWT validation middleware",
      description: `CF_ACCESS_TEAM and CF_ACCESS_AUD are set, but tunnel-guard.ts doesn't appear to validate CF Access JWTs.`,
      recommendation: "Add CF Access JWT validation to the dashboard middleware (tunnel-guard.ts).",
    });
  } else {
    findings.push({
      severity: "high",
      category: "cloudflare_tunnel",
      title: "No Cloudflare Access policy detected",
      description: "CF_ACCESS_TEAM and CF_ACCESS_AUD are not set. Anyone with the tunnel URL can access the dashboard.",
      recommendation: "Configure Cloudflare Access with email OTP or SSO and set CF_ACCESS_TEAM + CF_ACCESS_AUD env vars.",
    });
  }

  return findings;
}

// === MAIN ===
export async function runSecuritySweep(): Promise<SecuritySweepResult> {
  const start = Date.now();

  const results = await Promise.all([
    checkFilePermissions(),
    checkEndpointAuth(),
    checkSecretHygiene(),
    checkNetworkSurface(),
    checkDependencyAudit(),
    checkServiceHardening(),
    checkSupabaseRLS(),
    checkMCPHealth(),
    checkSSLTLS(),
    checkCloudflareTunnel(),
  ]);

  const findings = results.flat();

  // Sort by severity
  const order: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);

  const summary = {
    critical: findings.filter((f) => f.severity === "critical").length,
    high: findings.filter((f) => f.severity === "high").length,
    medium: findings.filter((f) => f.severity === "medium").length,
    low: findings.filter((f) => f.severity === "low").length,
    info: findings.filter((f) => f.severity === "info").length,
    total: findings.length,
  };

  return {
    timestamp: new Date().toISOString(),
    duration_ms: Date.now() - start,
    findings,
    summary,
  };
}

// CLI entry point
if (import.meta.main) {
  const result = await runSecuritySweep();

  // Print findings
  for (const f of result.findings) {
    const tag = f.severity.toUpperCase().padEnd(8);
    console.log(`[${tag}] ${f.title}`);
    console.log(`           ${f.description}`);
    if (f.recommendation !== "No action needed.") {
      console.log(`           → ${f.recommendation}`);
    }
    console.log();
  }

  // Summary
  const { summary } = result;
  console.log("─".repeat(60));
  console.log(
    `Security Sweep Complete (${result.duration_ms}ms): ` +
      `${summary.critical} critical, ${summary.high} high, ${summary.medium} medium, ${summary.low} low, ${summary.info} info`
  );
}
