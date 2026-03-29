/**
 * Docker Executor — ELLIE-1136
 * Tests for env whitelist, host config, and resource limits.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  buildContainerEnv,
  buildHostConfig,
  CONSTANTS,
} from "../src/overnight/docker-executor.ts";

// ── buildContainerEnv ────────────────────────────────────────

describe("buildContainerEnv", () => {
  it("always includes RUNTIME=agent-job and AGENT=claude-code", () => {
    const env = buildContainerEnv({});
    expect(env).toContain("RUNTIME=agent-job");
    expect(env).toContain("AGENT=claude-code");
  });

  it("includes whitelisted vars when provided", () => {
    const env = buildContainerEnv({
      GH_TOKEN: "ghp_abc123",
      REPO_URL: "https://github.com/test/repo",
      FEATURE_BRANCH: "feat/thing",
      AGENT_JOB_ID: "job-42",
      PROMPT: "do the thing",
      SYSTEM_PROMPT: "be helpful",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth_xyz",
    });

    expect(env).toContain("GH_TOKEN=ghp_abc123");
    expect(env).toContain("REPO_URL=https://github.com/test/repo");
    expect(env).toContain("FEATURE_BRANCH=feat/thing");
    expect(env).toContain("AGENT_JOB_ID=job-42");
    expect(env).toContain("PROMPT=do the thing");
    expect(env).toContain("SYSTEM_PROMPT=be helpful");
    expect(env).toContain("CLAUDE_CODE_OAUTH_TOKEN=oauth_xyz");
  });

  it("rejects ANTHROPIC_API_KEY", () => {
    const env = buildContainerEnv({ ANTHROPIC_API_KEY: "sk-ant-secret" } as any);
    const hasKey = env.some((e) => e.includes("ANTHROPIC_API_KEY"));
    expect(hasKey).toBe(false);
  });

  it("rejects SUPABASE_URL", () => {
    const env = buildContainerEnv({ SUPABASE_URL: "https://db.supabase.co" } as any);
    const hasKey = env.some((e) => e.includes("SUPABASE_URL"));
    expect(hasKey).toBe(false);
  });

  it("rejects DATABASE_URL", () => {
    const env = buildContainerEnv({ DATABASE_URL: "postgres://localhost/db" } as any);
    const hasKey = env.some((e) => e.includes("DATABASE_URL"));
    expect(hasKey).toBe(false);
  });

  it("rejects BRIDGE_KEY", () => {
    const env = buildContainerEnv({ BRIDGE_KEY: "bk_secret123" } as any);
    const hasKey = env.some((e) => e.includes("BRIDGE_KEY"));
    expect(hasKey).toBe(false);
  });

  it("rejects arbitrary unknown env vars", () => {
    const env = buildContainerEnv({
      SECRET_SAUCE: "hidden",
      AWS_SECRET_ACCESS_KEY: "aws123",
      TELEGRAM_BOT_TOKEN: "tg_token",
    } as any);
    expect(env).toEqual(["RUNTIME=agent-job", "AGENT=claude-code"]);
  });

  it("skips undefined values", () => {
    const env = buildContainerEnv({ GH_TOKEN: undefined });
    const hasToken = env.some((e) => e.includes("GH_TOKEN"));
    expect(hasToken).toBe(false);
  });

  it("does not allow overriding RUNTIME or AGENT", () => {
    const env = buildContainerEnv({ RUNTIME: "hacked", AGENT: "evil" } as any);
    const runtimeEntries = env.filter((e) => e.startsWith("RUNTIME="));
    const agentEntries = env.filter((e) => e.startsWith("AGENT="));
    expect(runtimeEntries).toEqual(["RUNTIME=agent-job"]);
    expect(agentEntries).toEqual(["AGENT=claude-code"]);
  });
});

// ── buildHostConfig ──────────────────────────────────────────

describe("buildHostConfig", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore original env
    delete process.env.OVERNIGHT_MEMORY_LIMIT;
    delete process.env.OVERNIGHT_CPU_LIMIT;
  });

  it("returns correct default memory limit (512MB)", () => {
    const config = buildHostConfig("test-vol");
    expect(config.Memory).toBe(536870912);
  });

  it("returns correct default NanoCpus (1 CPU)", () => {
    const config = buildHostConfig("test-vol");
    expect(config.NanoCpus).toBe(1000000000);
  });

  it("sets AutoRemove to true", () => {
    const config = buildHostConfig("test-vol");
    expect(config.AutoRemove).toBe(true);
  });

  it("includes no-new-privileges security opt", () => {
    const config = buildHostConfig("test-vol");
    expect(config.SecurityOpt).toEqual(["no-new-privileges"]);
  });

  it("binds volume to /home/coding-agent", () => {
    const config = buildHostConfig("my-task-vol");
    expect(config.Binds).toEqual(["my-task-vol:/home/coding-agent"]);
  });

  it("respects OVERNIGHT_MEMORY_LIMIT env override", () => {
    process.env.OVERNIGHT_MEMORY_LIMIT = "1073741824"; // 1GB
    const config = buildHostConfig("test-vol");
    expect(config.Memory).toBe(1073741824);
  });

  it("respects OVERNIGHT_CPU_LIMIT env override", () => {
    process.env.OVERNIGHT_CPU_LIMIT = "2000000000"; // 2 CPUs
    const config = buildHostConfig("test-vol");
    expect(config.NanoCpus).toBe(2000000000);
  });
});

// ── Constants ────────────────────────────────────────────────

describe("docker executor constants", () => {
  it("container prefix is ellie-overnight-", () => {
    expect(CONSTANTS.CONTAINER_PREFIX).toBe("ellie-overnight-");
  });

  it("default memory limit is 512MB", () => {
    expect(CONSTANTS.DEFAULT_MEMORY_LIMIT).toBe(536870912);
  });

  it("default NanoCpus is 1 CPU", () => {
    expect(CONSTANTS.DEFAULT_NANOCPUS).toBe(1000000000);
  });

  it("env whitelist contains expected vars", () => {
    expect(CONSTANTS.ENV_WHITELIST).toContain("GH_TOKEN");
    expect(CONSTANTS.ENV_WHITELIST).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(CONSTANTS.ENV_WHITELIST).toContain("REPO_URL");
    expect(CONSTANTS.ENV_WHITELIST).toContain("FEATURE_BRANCH");
    expect(CONSTANTS.ENV_WHITELIST).toContain("AGENT_JOB_ID");
    expect(CONSTANTS.ENV_WHITELIST).toContain("PROMPT");
    expect(CONSTANTS.ENV_WHITELIST).toContain("SYSTEM_PROMPT");
    expect(CONSTANTS.ENV_WHITELIST).toContain("RUNTIME");
    expect(CONSTANTS.ENV_WHITELIST).toContain("AGENT");
  });

  it("env whitelist does NOT contain dangerous vars", () => {
    expect(CONSTANTS.ENV_WHITELIST).not.toContain("ANTHROPIC_API_KEY");
    expect(CONSTANTS.ENV_WHITELIST).not.toContain("SUPABASE_URL");
    expect(CONSTANTS.ENV_WHITELIST).not.toContain("DATABASE_URL");
    expect(CONSTANTS.ENV_WHITELIST).not.toContain("BRIDGE_KEY");
  });
});
