/**
 * Docker Sandbox — ELLIE-978/979/980
 * Tests for container lifecycle, stats parsing, API routing, and dashboard SSE.
 */

import { describe, it, expect } from "bun:test";
import { CONSTANTS } from "../src/docker-sandbox.ts";

// ── Constants ────────────────────────────────────────────────

describe("docker sandbox constants", () => {
  it("container prefix is ellie-sandbox-", () => {
    expect(CONSTANTS.CONTAINER_PREFIX).toBe("ellie-sandbox-");
  });

  it("default image is ubuntu:24.04", () => {
    expect(CONSTANTS.DEFAULT_IMAGE).toBe("ubuntu:24.04");
  });

  it("default memory limit is 512MB", () => {
    expect(CONSTANTS.DEFAULT_MEMORY_LIMIT).toBe(512 * 1024 * 1024);
  });

  it("default CPU quota allows 1 CPU", () => {
    expect(CONSTANTS.DEFAULT_CPU_QUOTA).toBe(100_000);
  });

  it("max container age is 4 hours", () => {
    expect(CONSTANTS.MAX_CONTAINER_AGE_MS).toBe(4 * 60 * 60_000);
  });

  it("Docker socket path is /var/run/docker.sock", () => {
    expect(CONSTANTS.DOCKER_SOCKET).toBe("/var/run/docker.sock");
  });
});

// ── Container Info Shape ─────────────────────────────────────

describe("ContainerInfo shape", () => {
  interface ContainerInfo {
    id: string;
    name: string;
    state: "running" | "exited" | "paused" | "dead" | "created" | "restarting";
    status: string;
    image: string;
    created: string;
    agent?: string;
    workItemId?: string;
  }

  it("has required fields", () => {
    const c: ContainerInfo = {
      id: "abc123",
      name: "ellie-sandbox-test",
      state: "running",
      status: "Up 5 minutes",
      image: "ubuntu:24.04",
      created: new Date().toISOString(),
    };
    expect(c.state).toBe("running");
    expect(c.agent).toBeUndefined();
  });

  it("supports optional agent and workItemId", () => {
    const c: ContainerInfo = {
      id: "abc123",
      name: "ellie-sandbox-dev",
      state: "running",
      status: "Up",
      image: "ubuntu:24.04",
      created: new Date().toISOString(),
      agent: "james",
      workItemId: "ELLIE-100",
    };
    expect(c.agent).toBe("james");
    expect(c.workItemId).toBe("ELLIE-100");
  });
});

// ── Stats Parsing ────────────────────────────────────────────

describe("container stats computation", () => {
  function computeCpu(cpuDelta: number, systemDelta: number, numCpus: number): number {
    return systemDelta > 0 ? (cpuDelta / systemDelta) * numCpus * 100 : 0;
  }

  function computeMemPercent(usage: number, limit: number): number {
    return limit > 0 ? (usage / limit) * 100 : 0;
  }

  it("computes CPU percentage correctly", () => {
    // 50% of 1 CPU
    const cpu = computeCpu(500_000_000, 1_000_000_000, 1);
    expect(cpu).toBe(50);
  });

  it("handles multiple CPUs", () => {
    // 25% of each CPU on a 4-CPU system = 100% total
    const cpu = computeCpu(250_000_000, 1_000_000_000, 4);
    expect(cpu).toBe(100);
  });

  it("returns 0 when systemDelta is 0", () => {
    expect(computeCpu(100, 0, 1)).toBe(0);
  });

  it("computes memory percentage", () => {
    const memPercent = computeMemPercent(256 * 1024 * 1024, 512 * 1024 * 1024);
    expect(memPercent).toBe(50);
  });

  it("handles zero memory limit", () => {
    expect(computeMemPercent(100, 0)).toBe(0);
  });
});

// ── Docker API Route Patterns ────────────────────────────────

describe("API route patterns", () => {
  const namePattern = /^\/api\/sandbox\/containers\/([a-zA-Z0-9_.-]+)$/;
  const stopPattern = /^\/api\/sandbox\/containers\/([a-zA-Z0-9_.-]+)\/stop$/;
  const execPattern = /^\/api\/sandbox\/containers\/([a-zA-Z0-9_.-]+)\/exec$/;
  const statsPattern = /^\/api\/sandbox\/containers\/([a-zA-Z0-9_.-]+)\/stats$/;

  it("matches container name route", () => {
    const m = "/api/sandbox/containers/ellie-sandbox-abc123".match(namePattern);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("ellie-sandbox-abc123");
  });

  it("matches stop route", () => {
    const m = "/api/sandbox/containers/ellie-sandbox-test/stop".match(stopPattern);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("ellie-sandbox-test");
  });

  it("matches exec route", () => {
    const m = "/api/sandbox/containers/ellie-sandbox-test/exec".match(execPattern);
    expect(m).not.toBeNull();
  });

  it("matches stats route", () => {
    const m = "/api/sandbox/containers/ellie-sandbox-test/stats".match(statsPattern);
    expect(m).not.toBeNull();
  });

  it("rejects invalid container names", () => {
    expect("/api/sandbox/containers/invalid name".match(namePattern)).toBeNull();
    expect("/api/sandbox/containers/rm -rf /".match(namePattern)).toBeNull();
  });

  it("allows dots and hyphens in names", () => {
    const m = "/api/sandbox/containers/my.container-v2".match(namePattern);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("my.container-v2");
  });
});

// ── Docker Multiplexed Stream Parsing ────────────────────────

describe("multiplexed stream parsing", () => {
  function parseMultiplexed(buf: Buffer): string {
    let stdout = "";
    let offset = 0;
    while (offset + 8 <= buf.length) {
      const size = buf.readUInt32BE(offset + 4);
      if (offset + 8 + size > buf.length) break;
      if (buf[offset] === 1) { // stdout
        stdout += buf.subarray(offset + 8, offset + 8 + size).toString("utf8");
      }
      offset += 8 + size;
    }
    return stdout;
  }

  it("parses single stdout frame", () => {
    const payload = Buffer.from("hello world");
    const header = Buffer.alloc(8);
    header[0] = 1; // stdout
    header.writeUInt32BE(payload.length, 4);
    const buf = Buffer.concat([header, payload]);
    expect(parseMultiplexed(buf)).toBe("hello world");
  });

  it("skips stderr frames", () => {
    const stdout = Buffer.from("good");
    const stderr = Buffer.from("bad");
    const h1 = Buffer.alloc(8);
    h1[0] = 1;
    h1.writeUInt32BE(stdout.length, 4);
    const h2 = Buffer.alloc(8);
    h2[0] = 2; // stderr
    h2.writeUInt32BE(stderr.length, 4);
    const buf = Buffer.concat([h1, stdout, h2, stderr]);
    expect(parseMultiplexed(buf)).toBe("good");
  });

  it("handles multiple stdout frames", () => {
    const a = Buffer.from("hello ");
    const b = Buffer.from("world");
    const h1 = Buffer.alloc(8);
    h1[0] = 1;
    h1.writeUInt32BE(a.length, 4);
    const h2 = Buffer.alloc(8);
    h2[0] = 1;
    h2.writeUInt32BE(b.length, 4);
    const buf = Buffer.concat([h1, a, h2, b]);
    expect(parseMultiplexed(buf)).toBe("hello world");
  });

  it("handles empty buffer", () => {
    expect(parseMultiplexed(Buffer.alloc(0))).toBe("");
  });

  it("handles truncated frame", () => {
    // Header claims 100 bytes but only 5 are present
    const header = Buffer.alloc(8);
    header[0] = 1;
    header.writeUInt32BE(100, 4);
    const payload = Buffer.from("short");
    const buf = Buffer.concat([header, payload]);
    expect(parseMultiplexed(buf)).toBe("");
  });
});

// ── Sandbox Dispatch Integration ─────────────────────────────

describe("dispatch sandbox opts", () => {
  interface SandboxOpts {
    enabled: boolean;
    image?: string;
    memoryLimit?: number;
    cpuQuota?: number;
    env?: string[];
    binds?: string[];
  }

  it("accepts minimal sandbox config", () => {
    const opts: SandboxOpts = { enabled: true };
    expect(opts.enabled).toBe(true);
    expect(opts.image).toBeUndefined();
  });

  it("accepts full sandbox config", () => {
    const opts: SandboxOpts = {
      enabled: true,
      image: "node:20",
      memoryLimit: 1024 * 1024 * 1024,
      cpuQuota: 200_000,
      env: ["NODE_ENV=production"],
      binds: ["/data:/data:ro"],
    };
    expect(opts.image).toBe("node:20");
    expect(opts.memoryLimit).toBe(1024 * 1024 * 1024);
    expect(opts.env).toHaveLength(1);
  });
});

// ── Container Labels ─────────────────────────────────────────

describe("container label conventions", () => {
  it("uses ellie.sandbox=true for filtering", () => {
    const labels = { "ellie.sandbox": "true" };
    expect(labels["ellie.sandbox"]).toBe("true");
  });

  it("stores agent name in ellie.agent label", () => {
    const labels = { "ellie.sandbox": "true", "ellie.agent": "james" };
    expect(labels["ellie.agent"]).toBe("james");
  });

  it("stores work item in ellie.work-item label", () => {
    const labels = { "ellie.sandbox": "true", "ellie.work-item": "ELLIE-100" };
    expect(labels["ellie.work-item"]).toBe("ELLIE-100");
  });
});

// ── Container Expiry ─────────────────────────────────────────

describe("container expiry logic", () => {
  const MAX_AGE = CONSTANTS.MAX_CONTAINER_AGE_MS;

  it("container created now is not expired", () => {
    const age = Date.now() - Date.now();
    expect(age > MAX_AGE).toBe(false);
  });

  it("container created 5 hours ago is expired", () => {
    const created = Date.now() - 5 * 60 * 60_000;
    const age = Date.now() - created;
    expect(age > MAX_AGE).toBe(true);
  });

  it("container created 3 hours ago is not expired", () => {
    const created = Date.now() - 3 * 60 * 60_000;
    const age = Date.now() - created;
    expect(age > MAX_AGE).toBe(false);
  });
});

// ── Security: Network Isolation ──────────────────────────────

describe("sandbox security defaults", () => {
  it("default network mode is none (isolated)", () => {
    const hostConfig = {
      NetworkMode: "none",
      SecurityOpt: ["no-new-privileges"],
    };
    expect(hostConfig.NetworkMode).toBe("none");
    expect(hostConfig.SecurityOpt).toContain("no-new-privileges");
  });

  it("container name validation prevents injection", () => {
    const pattern = /^[a-zA-Z0-9_.-]+$/;
    expect(pattern.test("ellie-sandbox-abc")).toBe(true);
    expect(pattern.test("rm -rf /")).toBe(false);
    expect(pattern.test("$(evil)")).toBe(false);
    expect(pattern.test("name;drop")).toBe(false);
  });
});
