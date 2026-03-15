/**
 * Formation Template Registry — ELLIE-733
 *
 * Curated collection of formation templates organized by use case.
 * Supports bundled, marketplace, and custom formations.
 * In-memory registry with discovery/filter/search API.
 *
 * Pure module — types, registry logic, discovery. No side effects.
 */

// ── Types ────────────────────────────────────────────────────

export type TemplateSource = "bundled" | "marketplace" | "custom";

export type TemplateCategory =
  | "operations"
  | "strategy"
  | "billing"
  | "content"
  | "support"
  | "engineering"
  | "finance"
  | "research";

export const VALID_TEMPLATE_CATEGORIES: TemplateCategory[] = [
  "operations", "strategy", "billing", "content",
  "support", "engineering", "finance", "research",
];

export const VALID_TEMPLATE_SOURCES: TemplateSource[] = [
  "bundled", "marketplace", "custom",
];

/** Standardised template metadata. */
export interface TemplateMetadata {
  name: string;
  slug: string;
  description: string;
  source: TemplateSource;
  categories: TemplateCategory[];
  agent_count: number;
  author: string;
  version: string;
  /** Path relative to registry root (e.g. bundled/boardroom/SKILL.md). */
  path: string;
  created_at: string;
  updated_at: string;
}

/** Search/filter options for discovery. */
export interface RegistryQueryOptions {
  category?: TemplateCategory;
  source?: TemplateSource;
  author?: string;
  min_agents?: number;
  max_agents?: number;
  search?: string;
}

/** A versioned template entry (current + history). */
export interface VersionedTemplate {
  current: TemplateMetadata;
  versions: TemplateVersion[];
}

export interface TemplateVersion {
  version: string;
  updated_at: string;
  changelog: string;
}

// ── Registry ────────────────────────────────────────────────

/**
 * In-memory formation template registry.
 * Templates are registered on startup and queryable via discovery API.
 */
export class FormationRegistry {
  private templates: Map<string, VersionedTemplate> = new Map();

  /** Register a template. Updates version if slug already exists. */
  register(meta: TemplateMetadata, changelog?: string): void {
    const existing = this.templates.get(meta.slug);

    if (existing) {
      // Push current to version history, update to new
      existing.versions.push({
        version: existing.current.version,
        updated_at: existing.current.updated_at,
        changelog: changelog ?? "",
      });
      existing.current = meta;
    } else {
      this.templates.set(meta.slug, {
        current: meta,
        versions: [],
      });
    }
  }

  /** Unregister a template by slug. */
  unregister(slug: string): boolean {
    return this.templates.delete(slug);
  }

  /** Get a template by slug. */
  get(slug: string): TemplateMetadata | null {
    return this.templates.get(slug)?.current ?? null;
  }

  /** Get a template with its version history. */
  getVersioned(slug: string): VersionedTemplate | null {
    return this.templates.get(slug) ?? null;
  }

  /** Get all registered template slugs. */
  slugs(): string[] {
    return Array.from(this.templates.keys());
  }

  /** Total number of registered templates. */
  size(): number {
    return this.templates.size;
  }

  /** Clear all templates. */
  clear(): void {
    this.templates.clear();
  }

  /**
   * Query the registry with flexible filters.
   * All filters combined with AND. Search matches name + description.
   */
  query(opts: RegistryQueryOptions = {}): TemplateMetadata[] {
    let results = Array.from(this.templates.values()).map(v => v.current);

    if (opts.category) {
      results = results.filter(t => t.categories.includes(opts.category!));
    }

    if (opts.source) {
      results = results.filter(t => t.source === opts.source);
    }

    if (opts.author) {
      results = results.filter(t =>
        t.author.toLowerCase() === opts.author!.toLowerCase(),
      );
    }

    if (opts.min_agents !== undefined) {
      results = results.filter(t => t.agent_count >= opts.min_agents!);
    }

    if (opts.max_agents !== undefined) {
      results = results.filter(t => t.agent_count <= opts.max_agents!);
    }

    if (opts.search) {
      const q = opts.search.toLowerCase();
      results = results.filter(t =>
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q),
      );
    }

    return results.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** List all templates grouped by source. */
  listBySource(): Record<TemplateSource, TemplateMetadata[]> {
    const grouped: Record<TemplateSource, TemplateMetadata[]> = {
      bundled: [],
      marketplace: [],
      custom: [],
    };

    for (const vt of this.templates.values()) {
      grouped[vt.current.source].push(vt.current);
    }

    for (const source of VALID_TEMPLATE_SOURCES) {
      grouped[source].sort((a, b) => a.name.localeCompare(b.name));
    }

    return grouped;
  }

  /** List all unique categories in use. */
  categories(): TemplateCategory[] {
    const cats = new Set<TemplateCategory>();
    for (const vt of this.templates.values()) {
      for (const c of vt.current.categories) cats.add(c);
    }
    return Array.from(cats).sort();
  }
}

// ── Template Metadata Builder ───────────────────────────────

/**
 * Build template metadata from components.
 * Pure helper — does not register.
 */
export function buildTemplateMetadata(opts: {
  name: string;
  description: string;
  source: TemplateSource;
  categories: TemplateCategory[];
  agent_count: number;
  author: string;
  version?: string;
  path: string;
}): TemplateMetadata {
  const now = new Date().toISOString();
  return {
    name: opts.name,
    slug: slugifyTemplate(opts.name),
    description: opts.description,
    source: opts.source,
    categories: opts.categories,
    agent_count: opts.agent_count,
    author: opts.author,
    version: opts.version ?? "1.0.0",
    path: opts.path,
    created_at: now,
    updated_at: now,
  };
}

/**
 * Slugify a template name.
 */
export function slugifyTemplate(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ── Validation ──────────────────────────────────────────────

/**
 * Validate template metadata.
 */
export function validateTemplateMetadata(meta: TemplateMetadata): string[] {
  const errors: string[] = [];

  if (!meta.name?.trim()) errors.push("name is required");
  if (!meta.slug?.trim()) errors.push("slug is required");
  if (!meta.description?.trim()) errors.push("description is required");
  if (!VALID_TEMPLATE_SOURCES.includes(meta.source)) {
    errors.push(`source must be one of: ${VALID_TEMPLATE_SOURCES.join(", ")}`);
  }
  if (!meta.categories?.length) {
    errors.push("at least one category is required");
  } else {
    for (const cat of meta.categories) {
      if (!VALID_TEMPLATE_CATEGORIES.includes(cat)) {
        errors.push(`invalid category: ${cat}`);
      }
    }
  }
  if (typeof meta.agent_count !== "number" || meta.agent_count < 1) {
    errors.push("agent_count must be at least 1");
  }
  if (!meta.author?.trim()) errors.push("author is required");
  if (!meta.version?.trim()) errors.push("version is required");
  if (!meta.path?.trim()) errors.push("path is required");

  return errors;
}

// ── Bundled Template Definitions ────────────────────────────

/** The bundled templates that ship with Ellie OS. */
export const BUNDLED_TEMPLATES: TemplateMetadata[] = [
  buildTemplateMetadata({
    name: "Boardroom",
    description: "Executive strategy formation. All agents weigh in on high-level decisions.",
    source: "bundled",
    categories: ["strategy"],
    agent_count: 6,
    author: "ellie-os",
    path: "bundled/boardroom/SKILL.md",
  }),
  buildTemplateMetadata({
    name: "Think Tank",
    description: "Deep research and brainstorming formation for exploring complex topics.",
    source: "bundled",
    categories: ["research", "strategy"],
    agent_count: 4,
    author: "ellie-os",
    path: "bundled/think-tank/SKILL.md",
  }),
  buildTemplateMetadata({
    name: "Software Development",
    description: "Code review and implementation formation with dev, critic, and strategy agents.",
    source: "bundled",
    categories: ["engineering"],
    agent_count: 3,
    author: "ellie-os",
    path: "bundled/software-development/SKILL.md",
  }),
];

/**
 * Create a registry pre-loaded with bundled templates.
 */
export function createDefaultRegistry(): FormationRegistry {
  const registry = new FormationRegistry();
  for (const tmpl of BUNDLED_TEMPLATES) {
    registry.register(tmpl);
  }
  return registry;
}
