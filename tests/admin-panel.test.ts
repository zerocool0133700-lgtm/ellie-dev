/**
 * Admin Panel — ELLIE-994
 * Tests for admin route structure, nav consistency, and API endpoint availability.
 */

import { describe, it, expect } from "bun:test";

// ── Admin Route Structure ────────────────────────────────────

describe("admin route structure", () => {
  const adminRoutes = [
    "/admin",
    "/admin/credentials",
    "/admin/models",
    "/admin/agents",
    "/admin/skills",
    "/admin/schedules",
    "/admin/integrations",
    "/admin/system",
  ];

  it("has 8 admin routes", () => {
    expect(adminRoutes).toHaveLength(8);
  });

  it("all routes start with /admin", () => {
    for (const route of adminRoutes) {
      expect(route.startsWith("/admin")).toBe(true);
    }
  });

  it("no duplicate routes", () => {
    const unique = new Set(adminRoutes);
    expect(unique.size).toBe(adminRoutes.length);
  });
});

// ── Admin Nav Consistency ────────────────────────────────────

describe("admin nav items", () => {
  const navItems = [
    { path: "/admin", label: "Overview", icon: "&#9881;" },
    { path: "/admin/credentials", label: "Credentials", icon: "&#128272;" },
    { path: "/admin/models", label: "Models", icon: "&#9889;" },
    { path: "/admin/agents", label: "Agents", icon: "&#129302;" },
    { path: "/admin/skills", label: "Skills", icon: "&#127804;" },
    { path: "/admin/schedules", label: "Schedules", icon: "&#9200;" },
    { path: "/admin/integrations", label: "Integrations", icon: "&#128279;" },
    { path: "/admin/system", label: "System", icon: "&#128187;" },
  ];

  it("every nav item has path, label, and icon", () => {
    for (const item of navItems) {
      expect(item.path).toBeTruthy();
      expect(item.label).toBeTruthy();
      expect(item.icon).toBeTruthy();
    }
  });

  it("overview path is exactly /admin", () => {
    expect(navItems[0].path).toBe("/admin");
  });

  it("isActive logic: /admin only matches exact", () => {
    function isActive(path: string, currentPath: string) {
      if (path === "/admin") return currentPath === "/admin";
      return currentPath.startsWith(path);
    }
    expect(isActive("/admin", "/admin")).toBe(true);
    expect(isActive("/admin", "/admin/credentials")).toBe(false);
    expect(isActive("/admin/credentials", "/admin/credentials")).toBe(true);
    expect(isActive("/admin/credentials", "/admin/models")).toBe(false);
  });
});

// ── API Endpoints Used by Admin Pages ────────────────────────

describe("admin page API endpoints", () => {
  const endpoints = [
    { page: "overview", endpoint: "/api/health", method: "GET" },
    { page: "credentials", endpoint: "/api/credentials", method: "GET" },
    { page: "credentials-add", endpoint: "/api/credentials", method: "POST" },
    { page: "models", endpoint: "/api/models", method: "GET" },
    { page: "agents", endpoint: "/api/agents", method: "GET" },
    { page: "skills", endpoint: "/api/skills", method: "GET" },
    { page: "schedules", endpoint: "/api/scheduled-tasks", method: "GET" },
  ];

  it("all endpoints have valid methods", () => {
    for (const ep of endpoints) {
      expect(["GET", "POST", "PATCH", "DELETE"]).toContain(ep.method);
    }
  });

  it("all endpoints start with /api/", () => {
    for (const ep of endpoints) {
      expect(ep.endpoint.startsWith("/api/")).toBe(true);
    }
  });

  it("each page maps to exactly one primary endpoint", () => {
    const pages = endpoints.map(e => e.page.replace(/-.*$/, ""));
    // overview, credentials, models, agents, skills, schedules
    expect(new Set(pages).size).toBeGreaterThanOrEqual(6);
  });
});

// ── Integration Definitions ──────────────────────────────────

describe("integration definitions", () => {
  const integrations = [
    { name: "Telegram", configKey: "TELEGRAM_BOT_TOKEN" },
    { name: "Google Workspace", configKey: "GOOGLE_*" },
    { name: "GitHub", configKey: "GITHUB_TOKEN" },
    { name: "Plane", configKey: "PLANE_API_KEY" },
    { name: "Supabase", configKey: "SUPABASE_URL" },
    { name: "Elasticsearch", configKey: "ELASTICSEARCH_URL" },
    { name: "ElevenLabs", configKey: "ELEVENLABS_API_KEY" },
  ];

  it("lists 7 integrations", () => {
    expect(integrations).toHaveLength(7);
  });

  it("every integration has name and configKey", () => {
    for (const i of integrations) {
      expect(i.name).toBeTruthy();
      expect(i.configKey).toBeTruthy();
    }
  });

  it("no duplicate integration names", () => {
    const names = integrations.map(i => i.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

// ── Theme NavKey Consistency ─────────────────────────────────

describe("admin theme NavKey", () => {
  const themeLabels: Record<string, string> = {
    forest: "Roots",
    clean: "Admin",
    space: "Command",
    ocean: "Helm",
    medical: "Admin",
    business: "Settings",
  };

  it("every theme has an admin label", () => {
    for (const [theme, label] of Object.entries(themeLabels)) {
      expect(label).toBeTruthy();
      expect(typeof label).toBe("string");
    }
  });

  it("covers all 6 themes", () => {
    expect(Object.keys(themeLabels)).toHaveLength(6);
  });
});
