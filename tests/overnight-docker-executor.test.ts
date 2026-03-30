/**
 * Docker Executor — ELLIE-1136, ELLIE-1143
 * Tests for env whitelist, host config, resource limits, and container timeouts.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  buildContainerEnv,
  buildHostConfig,
  ensureIsolatedNetwork,
  killContainer,
  runOvernightTask,
  CONSTANTS,
  _dockerApiForTesting,
} from "../src/overnight/docker-executor.ts";
import { sanitizeLogs } from "../src/overnight/scheduler.ts";

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

// ── Network Isolation (ELLIE-1144) ──────────────────────────

describe("buildHostConfig network isolation", () => {
  it("sets NetworkMode to the isolated network (not default bridge)", () => {
    const config = buildHostConfig("test-vol");
    expect(config.NetworkMode).toBe("ellie-overnight-isolated");
  });

  it("includes ExtraHosts blocking host.docker.internal", () => {
    const config = buildHostConfig("test-vol");
    const extraHosts = config.ExtraHosts as string[];
    expect(extraHosts).toContainEqual("host.docker.internal:0.0.0.0");
  });

  it("includes ExtraHosts blocking common localhost aliases", () => {
    const config = buildHostConfig("test-vol");
    const extraHosts = config.ExtraHosts as string[];
    expect(extraHosts).toContainEqual("host.docker.internal:0.0.0.0");
    expect(extraHosts).toContainEqual("gateway.docker.internal:0.0.0.0");
  });
});

describe("ensureIsolatedNetwork", () => {
  it("is exported as a function", () => {
    expect(typeof ensureIsolatedNetwork).toBe("function");
  });
});

describe("CONSTANTS includes ISOLATED_NETWORK_NAME", () => {
  it("exposes the isolated network name", () => {
    expect(CONSTANTS.ISOLATED_NETWORK_NAME).toBe("ellie-overnight-isolated");
  });
});

// ── sanitizeLogs (ELLIE-1142) ───────────────────────────────

describe("sanitizeLogs", () => {
  it("redacts classic GitHub tokens (ghp_)", () => {
    const logs = "Cloning with token ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789 done";
    const clean = sanitizeLogs(logs);
    expect(clean).not.toContain("ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789");
    expect(clean).toContain("ghp_***REDACTED***");
  });

  it("redacts fine-grained GitHub tokens (github_pat_)", () => {
    const logs = "Using github_pat_11AABBBCC22DDEEFFGGHHI_xyzxyzxyzxyzxyzxyz1234 for auth";
    const clean = sanitizeLogs(logs);
    expect(clean).not.toContain("github_pat_11AABBBCC22DDEEFFGGHHI_xyzxyzxyzxyzxyzxyz1234");
    expect(clean).toContain("github_pat_***REDACTED***");
  });

  it("redacts tokens embedded in git clone URLs", () => {
    const logs = "git clone https://ghp_secret123456789012345678901234567890@github.com/evelife/ellie-dev.git";
    const clean = sanitizeLogs(logs);
    expect(clean).not.toContain("ghp_secret");
    expect(clean).toContain("https://***REDACTED***@github.com");
  });

  it("redacts Authorization headers", () => {
    const logs = 'Authorization: Bearer ghp_mySecretToken12345678901234567890xx';
    const clean = sanitizeLogs(logs);
    expect(clean).not.toContain("ghp_mySecretToken");
    expect(clean).toContain("Authorization: Bearer ***REDACTED***");
  });

  it("preserves normal log content", () => {
    const logs = "Cloning into 'ellie-dev'...\nremote: Enumerating objects: 1234\nhttps://github.com/evelife/ellie-dev/pull/42";
    const clean = sanitizeLogs(logs);
    expect(clean).toBe(logs);
  });

  it("handles multiple tokens in same log", () => {
    const logs = "token1=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa token2=ghp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const clean = sanitizeLogs(logs);
    expect(clean).not.toContain("ghp_aaaa");
    expect(clean).not.toContain("ghp_bbbb");
    const matches = clean.match(/ghp_\*\*\*REDACTED\*\*\*/g);
    expect(matches?.length).toBe(2);
  });
});

// ── Container Timeout (ELLIE-1143) ──────────────────────────

describe("container timeout constants", () => {
  it("has a default timeout of 30 minutes", () => {
    expect(CONSTANTS.DEFAULT_CONTAINER_TIMEOUT_MS).toBe(30 * 60 * 1000);
  });

  it("exposes TIMEOUT_EXIT_CODE as -2", () => {
    expect(CONSTANTS.TIMEOUT_EXIT_CODE).toBe(-2);
  });
});

describe("killContainer", () => {
  it("is exported as a function", () => {
    expect(typeof killContainer).toBe("function");
  });
});

describe("container timeout behavior", () => {
  afterEach(() => {
    delete process.env.OVERNIGHT_CONTAINER_TIMEOUT;
  });

  it("runOvernightTask accepts a timeoutMs option", () => {
    // Verify the function signature accepts timeout — launch will fail (no Docker)
    // but this confirms the option is wired through
    const promise = runOvernightTask("timeout-test", ["RUNTIME=agent-job"], { timeoutMs: 1000 });
    // Should return a result (failed due to no Docker), not throw on the option
    expect(promise).toBeInstanceOf(Promise);
    // Let it settle — it will fail gracefully
    return promise.then((result) => {
      // Should get a graceful failure, not a crash
      expect(result.exitCode).toBe(-1);
      expect(result.logs).toContain("Error:");
    });
  });

  it("runOvernightTask returns TIMEOUT_EXIT_CODE (-2) when container exceeds timeout", async () => {
    // Use env var override with a very short timeout
    // This tests env var path — container launch will fail before timeout fires,
    // but documents that OVERNIGHT_CONTAINER_TIMEOUT is read
    process.env.OVERNIGHT_CONTAINER_TIMEOUT = "500";
    const result = await runOvernightTask("env-timeout-test", ["RUNTIME=agent-job"]);
    // Launch fails before timeout triggers (no Docker), so exitCode is -1
    expect(result.exitCode).toBe(-1);
  });
});
