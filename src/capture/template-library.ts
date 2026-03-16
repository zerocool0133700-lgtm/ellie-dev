/**
 * River Content Template Library — ELLIE-781
 * Structured templates for common River content types.
 * Used by refinement engine, brain dump processing, and template-prompted capture.
 */

import type { CaptureContentType } from "../capture-queue.ts";

// Types

export interface TemplateSection {
  heading: string;
  guide: string;
  required: boolean;
}

export interface RiverTemplate {
  id: string;
  name: string;
  content_type: CaptureContentType | "agent_prompt";
  description: string;
  sections: TemplateSection[];
  frontmatter_fields: Record<string, string>;
}

// Template definitions

const TEMPLATES: RiverTemplate[] = [
  {
    id: "workflow",
    name: "Workflow",
    content_type: "workflow",
    description: "A sequence of steps triggered by an event that produces an outcome",
    sections: [
      { heading: "Trigger", guide: "What event or condition starts this workflow?", required: true },
      { heading: "Steps", guide: "What are the ordered steps? Number each one.", required: true },
      { heading: "Outcomes", guide: "What is the expected result when the workflow completes successfully?", required: true },
      { heading: "Edge Cases", guide: "What can go wrong? What happens if a step fails?", required: false },
      { heading: "Owner", guide: "Who is responsible for this workflow? Who do you contact if it breaks?", required: false },
    ],
    frontmatter_fields: {
      type: "workflow",
      status: "draft",
      trigger: "",
      owner: "",
      frequency: "",
    },
  },
  {
    id: "decision",
    name: "Decision Record",
    content_type: "decision",
    description: "A record of a decision made, the options considered, and the reasoning",
    sections: [
      { heading: "Context", guide: "What situation or problem prompted this decision?", required: true },
      { heading: "Options Considered", guide: "What alternatives were evaluated? List each with brief pros/cons.", required: true },
      { heading: "Decision", guide: "What was decided? State it clearly in one sentence.", required: true },
      { heading: "Reasoning", guide: "Why was this option chosen over the others?", required: true },
      { heading: "Consequences", guide: "What are the expected outcomes, trade-offs, or follow-up actions?", required: false },
    ],
    frontmatter_fields: {
      type: "decision",
      status: "draft",
      decided_by: "",
      decided_on: "",
      revisit_date: "",
    },
  },
  {
    id: "process",
    name: "Process",
    content_type: "process",
    description: "A recurring procedure — when it happens, who does it, and how",
    sections: [
      { heading: "When", guide: "When does this process run? What triggers it or what schedule does it follow?", required: true },
      { heading: "Who", guide: "Who is responsible for executing this process?", required: true },
      { heading: "What", guide: "What does this process accomplish? What is its purpose?", required: true },
      { heading: "How", guide: "What are the step-by-step instructions for carrying out this process?", required: true },
      { heading: "Frequency", guide: "How often does this process run? Daily, weekly, on-demand?", required: false },
    ],
    frontmatter_fields: {
      type: "process",
      status: "draft",
      owner: "",
      frequency: "",
      last_run: "",
    },
  },
  {
    id: "policy",
    name: "Policy / Rule",
    content_type: "policy",
    description: "A rule, policy, or constraint that must be followed",
    sections: [
      { heading: "Rule", guide: "State the rule clearly. What must or must not happen?", required: true },
      { heading: "Scope", guide: "Who does this rule apply to? In what contexts?", required: true },
      { heading: "Exceptions", guide: "Are there any exceptions? Under what conditions can this rule be bypassed?", required: false },
      { heading: "Enforcement", guide: "How is this rule enforced? What happens if it's violated?", required: false },
    ],
    frontmatter_fields: {
      type: "policy",
      status: "draft",
      applies_to: "",
      effective_date: "",
      review_date: "",
    },
  },
  {
    id: "integration",
    name: "Integration Spec",
    content_type: "integration",
    description: "How two systems connect and exchange data",
    sections: [
      { heading: "Systems", guide: "What two systems are connected? (System A -> System B)", required: true },
      { heading: "Protocol", guide: "How do they communicate? (REST API, webhook, message queue, etc.)", required: true },
      { heading: "Data Format", guide: "What data is exchanged? What format? (JSON, XML, EDI, etc.)", required: true },
      { heading: "Authentication", guide: "How is the connection authenticated? (API key, OAuth, mTLS, etc.)", required: true },
      { heading: "Error Handling", guide: "What happens when the connection fails? Retry logic? Alerts?", required: false },
    ],
    frontmatter_fields: {
      type: "integration",
      status: "draft",
      system_a: "",
      system_b: "",
      protocol: "",
    },
  },
  {
    id: "reference",
    name: "Reference",
    content_type: "reference",
    description: "A reference document with key facts about a topic",
    sections: [
      { heading: "Topic", guide: "What is this reference about? Give a brief overview.", required: true },
      { heading: "Key Facts", guide: "What are the important facts, values, or details to remember?", required: true },
      { heading: "Links", guide: "What are the related URLs, documentation, or other references?", required: false },
      { heading: "Last Verified", guide: "When was this information last confirmed to be accurate?", required: false },
    ],
    frontmatter_fields: {
      type: "reference",
      status: "draft",
      last_verified: "",
    },
  },
  {
    id: "agent_prompt",
    name: "Agent Prompt",
    content_type: "reference",
    description: "A prompt template defining an agent's role and behavior",
    sections: [
      { heading: "Role", guide: "What is this agent's role? What persona does it adopt?", required: true },
      { heading: "Capabilities", guide: "What can this agent do? What tools or skills does it have?", required: true },
      { heading: "Constraints", guide: "What must this agent NOT do? What limits apply?", required: true },
      { heading: "Examples", guide: "What are some example interactions showing ideal behavior?", required: false },
    ],
    frontmatter_fields: {
      type: "agent-prompt",
      status: "draft",
      agent: "",
      version: "1",
    },
  },
];

// Lookup

export function getTemplate(id: string): RiverTemplate | null {
  return TEMPLATES.find(t => t.id === id) ?? null;
}

export function getTemplateByContentType(contentType: CaptureContentType | "agent_prompt"): RiverTemplate | null {
  return TEMPLATES.find(t => t.content_type === contentType || t.id === contentType) ?? null;
}

export function getAllTemplates(): RiverTemplate[] {
  return [...TEMPLATES];
}

export function getTemplateIds(): string[] {
  return TEMPLATES.map(t => t.id);
}

// Render template to markdown

export function renderTemplate(template: RiverTemplate, content: Record<string, string> = {}): string {
  const fm = renderFrontmatter(template, content);
  const body = renderBody(template, content);
  return fm + "\n\n" + body;
}

export function renderFrontmatter(template: RiverTemplate, overrides: Record<string, string> = {}): string {
  const fields = { ...template.frontmatter_fields };
  const title = overrides.title ?? template.name;
  const lines = ["---", `title: ${title}`];

  for (const [key, defaultVal] of Object.entries(fields)) {
    const value = overrides[key] ?? defaultVal;
    lines.push(`${key}: ${value}`);
  }

  lines.push(`created: ${new Date().toISOString().slice(0, 10)}`);
  lines.push("---");
  return lines.join("\n");
}

export function renderBody(template: RiverTemplate, content: Record<string, string> = {}): string {
  const title = content.title ?? template.name;
  const lines = [`# ${title}`, ""];

  for (const section of template.sections) {
    lines.push(`## ${section.heading}`);
    lines.push("");
    const sectionContent = content[section.heading.toLowerCase()];
    if (sectionContent) {
      lines.push(sectionContent);
    } else {
      lines.push(`<!-- ${section.guide} -->`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// Build guided questions for interactive capture

export function getGuidedQuestions(templateId: string): { heading: string; question: string; required: boolean }[] {
  const template = getTemplate(templateId);
  if (!template) return [];
  return template.sections.map(s => ({
    heading: s.heading,
    question: s.guide,
    required: s.required,
  }));
}

// Select best template for content

export function selectTemplate(contentType: CaptureContentType, hint?: string): RiverTemplate {
  if (hint) {
    const byHint = getTemplate(hint);
    if (byHint) return byHint;
  }

  const byType = getTemplateByContentType(contentType);
  if (byType) return byType;

  // Fallback to reference
  return getTemplate("reference")!;
}
