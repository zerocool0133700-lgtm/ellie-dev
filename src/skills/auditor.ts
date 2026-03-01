/**
 * Skill Auditor — Security Audit Engine
 *
 * Implements the skill-guard security audit procedure before installation.
 * Returns a risk verdict (SAFE/CAUTION/RISKY) with actionable recommendations.
 */

import { readFile, readdir, stat } from "fs/promises";
import { join, extname } from "path";
import { log } from "../logger.ts";

const logger = log.child("skill-auditor");

export type RiskRating = "SAFE" | "CAUTION" | "RISKY";
export type SandboxPolicy = "unrestricted" | "restricted" | "manual_approval" | "rate_limited" | "isolated" | "do_not_install";

export interface AuditFinding {
  severity: "critical" | "warning" | "info";
  category: string;
  message: string;
  location?: string;
}

export interface AuditReport {
  skillName: string;
  version?: string;
  author?: string;
  riskRating: RiskRating;
  sandboxPolicy: SandboxPolicy;
  summary: string;
  findings: {
    critical: AuditFinding[];
    warning: AuditFinding[];
    info: AuditFinding[];
  };
  claimsVsReality: "accurate" | "understated" | "misleading" | "deceptive";
  permissionsRequired: string[];
  recommendation: string;
  timestamp: string;
}

const INJECTION_PATTERNS = {
  directOverride: [
    "ignore previous",
    "disregard instructions",
    "forget what",
    "you are now",
    "your role is",
    "pretend you are",
    "act as if",
  ],
  personaHijack: [
    "act as",
    "pretend to be",
    "become a",
    "roleplay as",
    "your new role",
  ],
  socialEng: [
    "the user wants you to",
    "it's safe to",
    "you have permission to",
    "this is allowed",
    "bypass the",
    "disable the",
  ],
  coreModification: [
    "SOUL.md",
    "AGENTS.md",
    "USER.md",
    "MEMORY.md",
    "IDENTITY.md",
  ],
};

const CRITICAL_PATTERNS = {
  rce: [
    /curl\s*\|.*sh/gi,
    /wget\s*\|.*bash/gi,
    /eval\s*\(/gi,
    /exec\s*\(/gi,
    /process\.exec/gi,
  ],
  exfiltration: [
    /send.*env/gi,
    /post.*key/gi,
    /fetch.*api_key/gi,
    /export.*credential/gi,
  ],
  credentials: [
    /ANTHROPIC_API_KEY/g,
    /OPENAI_API_KEY/g,
    /\.ssh/g,
    /\.openclaw/g,
  ],
  destructive: [
    /rm\s+-rf\s+\//g,
    /mkfs/gi,
    /dd\s+if=/gi,
    /shred/gi,
  ],
  obfuscation: [
    /atob/gi,
    /Buffer\.from.*base64/gi,
    /0x[0-9a-f]+/gi,
  ],
};

/**
 * Run full security audit on skill files.
 */
export async function auditSkill(
  skillDir: string,
  skillMdContent: string,
  extraFiles: Array<{ path: string; content: string }>
): Promise<AuditReport> {
  const findings: AuditFinding[] = [];
  const permissions: Set<string> = new Set();

  try {
    // Parse SKILL.md frontmatter
    const skillMd = parseSkillMd(skillMdContent);
    const skillName = skillMd.name || "unknown-skill";

    // Step 1: Inventory
    const invFindings = await checkInventory(skillDir, extraFiles);
    findings.push(...invFindings);

    // Step 2: SKILL.md injection scan
    const skillMdFindings = scanSkillMdForInjection(skillMdContent);
    findings.push(...skillMdFindings);

    // Step 3: Script deep scan
    const scriptFindings = scanScriptsForThreats(extraFiles);
    findings.push(...scriptFindings);

    // Step 4: Dependency audit
    const depFindings = auditDependencies(extraFiles);
    findings.push(...depFindings);

    // Categorize findings
    const critical = findings.filter((f) => f.severity === "critical");
    const warning = findings.filter((f) => f.severity === "warning");
    const info = findings.filter((f) => f.severity === "info");

    // Determine risk rating
    let riskRating: RiskRating = "SAFE";
    if (critical.length > 0) {
      riskRating = "RISKY";
    } else if (warning.length > 2) {
      riskRating = "CAUTION";
    }

    // Determine sandbox policy
    const sandboxPolicy = determineSandboxPolicy(riskRating, critical, warning);

    // Build summary
    const summary = buildSummary(skillName, riskRating, critical, warning);

    return {
      skillName,
      version: skillMd.version,
      author: skillMd.author,
      riskRating,
      sandboxPolicy,
      summary,
      findings: { critical, warning, info },
      claimsVsReality: "accurate", // TODO: implement deeper claims vs reality check
      permissionsRequired: Array.from(permissions),
      recommendation: getRecommendation(riskRating, sandboxPolicy),
      timestamp: new Date().toISOString(),
    };
  } catch (err: unknown) {
    logger.error("Audit failed", err);
    return {
      skillName: "error",
      riskRating: "RISKY",
      sandboxPolicy: "do_not_install",
      summary: `Audit error: ${err.message}`,
      findings: {
        critical: [
          {
            severity: "critical",
            category: "audit_error",
            message: `Failed to audit skill: ${err.message}`,
          },
        ],
        warning: [],
        info: [],
      },
      claimsVsReality: "accurate",
      permissionsRequired: [],
      recommendation: "Do not install — audit failed",
      timestamp: new Date().toISOString(),
    };
  }
}

/**
 * Check inventory: file counts, types, sizes, hidden files, binaries.
 */
async function checkInventory(
  skillDir: string,
  extraFiles: Array<{ path: string; content: string }>
): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];

  // Check for binaries and large files
  for (const file of extraFiles) {
    const size = Buffer.byteLength(file.content, "utf-8");

    // Flag large files
    if (size > 100 * 1024) {
      findings.push({
        severity: "warning",
        category: "inventory",
        message: `File exceeds 100KB: ${file.path} (${Math.round(size / 1024)}KB)`,
        location: file.path,
      });
    }

    // Flag binaries and dangerous extensions
    const ext = extname(file.path).toLowerCase();
    if ([".exe", ".bin", ".so", ".dylib", ".wasm", ".dll", ".class", ".jar"].includes(ext)) {
      findings.push({
        severity: "critical",
        category: "inventory",
        message: `Unexpected binary file: ${file.path}`,
        location: file.path,
      });
    }

    // Flag hidden files
    if (file.path.split("/").some((p) => p.startsWith("."))) {
      findings.push({
        severity: "warning",
        category: "inventory",
        message: `Hidden file detected: ${file.path}`,
        location: file.path,
      });
    }
  }

  return findings;
}

/**
 * Scan SKILL.md for prompt injection patterns.
 */
function scanSkillMdForInjection(content: string): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const lowerContent = content.toLowerCase();

  // Check direct override attempts
  for (const pattern of INJECTION_PATTERNS.directOverride) {
    if (lowerContent.includes(pattern)) {
      findings.push({
        severity: "critical",
        category: "injection",
        message: `Potential instruction override detected: "${pattern}"`,
      });
    }
  }

  // Check persona hijacking
  for (const pattern of INJECTION_PATTERNS.personaHijack) {
    if (lowerContent.includes(pattern)) {
      findings.push({
        severity: "critical",
        category: "injection",
        message: `Potential persona hijacking detected: "${pattern}"`,
      });
    }
  }

  // Check social engineering
  for (const pattern of INJECTION_PATTERNS.socialEng) {
    if (lowerContent.includes(pattern)) {
      findings.push({
        severity: "critical",
        category: "injection",
        message: `Potential social engineering detected: "${pattern}"`,
      });
    }
  }

  // Check core file modification attempts
  for (const coreFile of INJECTION_PATTERNS.coreModification) {
    if (lowerContent.includes(coreFile.toLowerCase())) {
      findings.push({
        severity: "critical",
        category: "injection",
        message: `Attempt to modify core system file: ${coreFile}`,
      });
    }
  }

  return findings;
}

/**
 * Scan scripts for RCE, exfiltration, credentials, and obfuscation.
 */
function scanScriptsForThreats(
  files: Array<{ path: string; content: string }>
): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const scriptExts = [".sh", ".py", ".js", ".ts", ".rb", ".pl"];

  for (const file of files) {
    const ext = extname(file.path).toLowerCase();
    if (!scriptExts.includes(ext)) continue;

    const content = file.content;

    // Check critical patterns
    for (const [category, patterns] of Object.entries(CRITICAL_PATTERNS)) {
      for (const pattern of patterns) {
        if (pattern.test(content)) {
          findings.push({
            severity: "critical",
            category: "script_threat",
            message: `Critical pattern detected (${category}): ${pattern.source.substring(0, 50)}...`,
            location: file.path,
          });
        }
      }
    }

    // Check for base64 obfuscation
    const base64Match = content.match(/[A-Za-z0-9+/]{50,}/g);
    if (base64Match) {
      findings.push({
        severity: "warning",
        category: "obfuscation",
        message: `Potential base64-encoded content detected in ${file.path}`,
        location: file.path,
      });
    }
  }

  return findings;
}

/**
 * Audit dependencies listed in scripts.
 */
function auditDependencies(
  files: Array<{ path: string; content: string }>
): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const depPatterns = [
    /pip\s+install\s+(\S+)/gi,
    /npm\s+install\s+(\S+)/gi,
    /brew\s+install\s+(\S+)/gi,
    /apt\s+install\s+(\S+)/gi,
  ];

  for (const file of files) {
    for (const pattern of depPatterns) {
      let match;
      while ((match = pattern.exec(file.content))) {
        const pkg = match[1];

        // Check for typosquatting patterns
        const suspiciousPkgs = ["reqeusts", "colorsama", "scikit", "numpyy"];
        if (suspiciousPkgs.includes(pkg.toLowerCase())) {
          findings.push({
            severity: "critical",
            category: "dependency",
            message: `Suspicious package name (potential typosquatting): ${pkg}`,
            location: file.path,
          });
        }
      }
    }
  }

  return findings;
}

/**
 * Determine sandbox deployment policy based on risk rating.
 */
function determineSandboxPolicy(
  riskRating: RiskRating,
  critical: AuditFinding[],
  warning: AuditFinding[]
): SandboxPolicy {
  if (riskRating === "RISKY") {
    return "do_not_install";
  }
  if (riskRating === "CAUTION") {
    // If there are network calls or file access warnings
    const hasNetworkWarning = warning.some((w) =>
      w.category.includes("network") || w.message.includes("endpoint")
    );
    if (hasNetworkWarning) {
      return "manual_approval";
    }
    return "restricted";
  }
  return "unrestricted";
}

/**
 * Build human-readable summary.
 */
function buildSummary(
  skillName: string,
  riskRating: RiskRating,
  critical: AuditFinding[],
  warning: AuditFinding[]
): string {
  const criticalMsg = critical.length > 0 ? `${critical.length} critical issue(s)` : "no critical issues";
  const warningMsg = warning.length > 0 ? `${warning.length} warning(s)` : "no warnings";
  return `${skillName}: ${riskRating} — ${criticalMsg}, ${warningMsg}`;
}

/**
 * Get recommendation text based on risk level.
 */
function getRecommendation(riskRating: RiskRating, policy: SandboxPolicy): string {
  const recommendations: Record<SandboxPolicy, string> = {
    unrestricted: "Safe to install and use normally in any agent.",
    restricted: "Install with caution — use in a restricted agent or with rate limiting.",
    manual_approval: "Install with manual approval required before each execution.",
    rate_limited: "Install with execution rate limits (e.g., max 1 per minute).",
    isolated: "Install only in an isolated sandbox with network disabled.",
    do_not_install: "Do NOT install — critical security risks detected.",
  };
  return recommendations[policy] || "Review manually";
}

/**
 * Parse SKILL.md frontmatter.
 */
function parseSkillMd(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const fm: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const [key, ...valueParts] = line.split(":");
    if (key && valueParts.length > 0) {
      fm[key.trim()] = valueParts.join(":").trim();
    }
  }
  return fm;
}
