/**
 * Embedding Provider Tests — ELLIE-749
 *
 * Tests for pluggable embedding provider:
 * - Config from env
 * - Config validation
 * - HIPAA compliance check
 * - Mock provider (deterministic embeddings)
 * - OpenAI request builder + response parser
 * - Batching utility
 * - Provider factory (createEmbedFn)
 * - E2E scenarios
 */

import { describe, test, expect } from "bun:test";
import {
  configFromEnv,
  validateConfig,
  isHIPAASafe,
  createMockProvider,
  buildOpenAIRequest,
  parseOpenAIResponse,
  batchTexts,
  createEmbedFn,
  defaultConfig,
  VALID_PROVIDER_TYPES,
  DEFAULT_DIMENSIONS,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_BATCH_SIZE,
  type EmbeddingConfig,
} from "../src/embedding-provider.ts";

// ── Constants ───────────────────────────────────────────────

describe("constants", () => {
  test("VALID_PROVIDER_TYPES has 3 types", () => {
    expect(VALID_PROVIDER_TYPES).toEqual(["openai", "local", "mock"]);
  });

  test("DEFAULT_DIMENSIONS is 1536", () => {
    expect(DEFAULT_DIMENSIONS).toBe(1536);
  });

  test("DEFAULT_OPENAI_MODEL is text-embedding-3-small", () => {
    expect(DEFAULT_OPENAI_MODEL).toBe("text-embedding-3-small");
  });

  test("DEFAULT_BATCH_SIZE is 100", () => {
    expect(DEFAULT_BATCH_SIZE).toBe(100);
  });
});

// ── defaultConfig ───────────────────────────────────────────

describe("defaultConfig", () => {
  test("returns openai provider with 1536 dimensions", () => {
    const c = defaultConfig();
    expect(c.provider).toBe("openai");
    expect(c.dimensions).toBe(1536);
    expect(c.openai_model).toBe(DEFAULT_OPENAI_MODEL);
  });
});

// ── configFromEnv ───────────────────────────────────────────

describe("configFromEnv", () => {
  test("defaults to openai when no env set", () => {
    const c = configFromEnv({});
    expect(c.provider).toBe("openai");
    expect(c.dimensions).toBe(1536);
  });

  test("reads EMBEDDING_PROVIDER", () => {
    expect(configFromEnv({ EMBEDDING_PROVIDER: "local" }).provider).toBe("local");
  });

  test("reads OPENAI_API_KEY", () => {
    expect(configFromEnv({ OPENAI_API_KEY: "sk-test" }).openai_api_key).toBe("sk-test");
  });

  test("reads LOCAL_EMBEDDING_MODEL_PATH", () => {
    expect(configFromEnv({ LOCAL_EMBEDDING_MODEL_PATH: "/models/e5" }).local_model_path).toBe("/models/e5");
  });

  test("reads LOCAL_EMBEDDING_RUNTIME", () => {
    expect(configFromEnv({ LOCAL_EMBEDDING_RUNTIME: "openvino" }).local_runtime).toBe("openvino");
    expect(configFromEnv({}).local_runtime).toBe("onnx"); // default
  });

  test("reads custom EMBEDDING_DIMENSIONS", () => {
    expect(configFromEnv({ EMBEDDING_DIMENSIONS: "768" }).dimensions).toBe(768);
  });

  test("reads EMBEDDING_BATCH_SIZE", () => {
    expect(configFromEnv({ EMBEDDING_BATCH_SIZE: "50" }).batch_size).toBe(50);
  });
});

// ── validateConfig ──────────────────────────────────────────

describe("validateConfig", () => {
  test("valid openai config passes", () => {
    expect(validateConfig({ ...defaultConfig(), openai_api_key: "sk-test" })).toHaveLength(0);
  });

  test("valid local config passes", () => {
    expect(validateConfig({
      provider: "local", dimensions: 1536, local_model_path: "/models/e5",
    })).toHaveLength(0);
  });

  test("valid mock config passes", () => {
    expect(validateConfig({ provider: "mock", dimensions: 1536 })).toHaveLength(0);
  });

  test("invalid provider fails", () => {
    expect(validateConfig({ provider: "unknown" as any, dimensions: 1536 }).some(e => e.includes("Invalid provider"))).toBe(true);
  });

  test("openai without api key fails", () => {
    expect(validateConfig({ provider: "openai", dimensions: 1536 }).some(e => e.includes("openai_api_key"))).toBe(true);
  });

  test("local without model path fails", () => {
    expect(validateConfig({ provider: "local", dimensions: 1536 }).some(e => e.includes("local_model_path"))).toBe(true);
  });

  test("dimensions < 1 fails", () => {
    expect(validateConfig({ provider: "mock", dimensions: 0 }).some(e => e.includes("dimensions"))).toBe(true);
  });

  test("batch_size < 1 fails", () => {
    expect(validateConfig({ provider: "mock", dimensions: 1536, batch_size: 0 }).some(e => e.includes("batch_size"))).toBe(true);
  });
});

// ── isHIPAASafe ─────────────────────────────────────────────

describe("isHIPAASafe", () => {
  test("local provider is HIPAA safe", () => {
    const result = isHIPAASafe({ provider: "local", dimensions: 1536 });
    expect(result.safe).toBe(true);
    expect(result.reason).toContain("Local");
  });

  test("mock provider is HIPAA safe", () => {
    expect(isHIPAASafe({ provider: "mock", dimensions: 1536 }).safe).toBe(true);
  });

  test("openai provider is NOT HIPAA safe", () => {
    const result = isHIPAASafe({ provider: "openai", dimensions: 1536 });
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("not HIPAA");
  });
});

// ── createMockProvider ──────────────────────────────────────

describe("createMockProvider", () => {
  test("produces embeddings of correct dimension", async () => {
    const provider = createMockProvider(1536);
    const embedding = await provider.embed("test text");
    expect(embedding).toHaveLength(1536);
  });

  test("produces deterministic embeddings for same input", async () => {
    const provider = createMockProvider(384);
    const a = await provider.embed("hello world");
    const b = await provider.embed("hello world");
    expect(a).toEqual(b);
  });

  test("produces different embeddings for different input", async () => {
    const provider = createMockProvider(384);
    const a = await provider.embed("hello");
    const b = await provider.embed("goodbye");
    expect(a).not.toEqual(b);
  });

  test("embedBatch returns array of embeddings", async () => {
    const provider = createMockProvider(384);
    const results = await provider.embedBatch(["a", "b", "c"]);
    expect(results).toHaveLength(3);
    expect(results[0]).toHaveLength(384);
  });

  test("values are in [-1, 1] range", async () => {
    const provider = createMockProvider(100);
    const embedding = await provider.embed("test");
    for (const v of embedding) {
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  test("isLocal is true", () => {
    expect(createMockProvider().isLocal).toBe(true);
  });

  test("type is mock", () => {
    expect(createMockProvider().type).toBe("mock");
  });

  test("default dimensions is 1536", () => {
    expect(createMockProvider().dimensions).toBe(1536);
  });
});

// ── buildOpenAIRequest ──────────────────────────────────────

describe("buildOpenAIRequest", () => {
  const config: EmbeddingConfig = {
    provider: "openai",
    openai_api_key: "sk-test-key",
    openai_model: "text-embedding-3-small",
    dimensions: 1536,
  };

  test("builds correct URL and method", () => {
    const req = buildOpenAIRequest(config, "test text");
    expect(req.url).toBe("https://api.openai.com/v1/embeddings");
    expect(req.method).toBe("POST");
  });

  test("includes authorization header", () => {
    const req = buildOpenAIRequest(config, "test");
    expect(req.headers.Authorization).toBe("Bearer sk-test-key");
  });

  test("body includes input, model, dimensions", () => {
    const req = buildOpenAIRequest(config, "test input");
    const body = JSON.parse(req.body);
    expect(body.input).toBe("test input");
    expect(body.model).toBe("text-embedding-3-small");
    expect(body.dimensions).toBe(1536);
  });

  test("supports batch input (string array)", () => {
    const req = buildOpenAIRequest(config, ["text 1", "text 2"]);
    const body = JSON.parse(req.body);
    expect(body.input).toEqual(["text 1", "text 2"]);
  });
});

// ── parseOpenAIResponse ─────────────────────────────────────

describe("parseOpenAIResponse", () => {
  test("parses embeddings sorted by index", () => {
    const result = parseOpenAIResponse({
      data: [
        { embedding: [0.2, 0.3], index: 1 },
        { embedding: [0.1, 0.4], index: 0 },
      ],
      usage: { total_tokens: 10 },
    });
    expect(result.embeddings).toHaveLength(2);
    expect(result.embeddings[0]).toEqual([0.1, 0.4]); // index 0 first
    expect(result.tokens_used).toBe(10);
  });

  test("handles empty response", () => {
    const result = parseOpenAIResponse({});
    expect(result.embeddings).toHaveLength(0);
    expect(result.tokens_used).toBe(0);
  });
});

// ── batchTexts ──────────────────────────────────────────────

describe("batchTexts", () => {
  test("splits into batches of given size", () => {
    const batches = batchTexts(["a", "b", "c", "d", "e"], 2);
    expect(batches).toEqual([["a", "b"], ["c", "d"], ["e"]]);
  });

  test("single batch when under size", () => {
    expect(batchTexts(["a", "b"], 10)).toEqual([["a", "b"]]);
  });

  test("empty input returns empty", () => {
    expect(batchTexts([])).toEqual([]);
  });

  test("uses default batch size", () => {
    const texts = Array.from({ length: 150 }, (_, i) => `text-${i}`);
    const batches = batchTexts(texts);
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(100);
    expect(batches[1]).toHaveLength(50);
  });
});

// ── createEmbedFn ───────────────────────────────────────────

describe("createEmbedFn", () => {
  test("mock provider returns working embed function", async () => {
    const fn = createEmbedFn({ provider: "mock", dimensions: 384 });
    const result = await fn("test");
    expect(result).toHaveLength(384);
  });

  test("local provider requires localEmbedFn", () => {
    expect(() => createEmbedFn({ provider: "local", dimensions: 1536 })).toThrow("localEmbedFn required");
  });

  test("local provider uses provided function", async () => {
    const localFn = async () => Array(768).fill(0.5);
    const fn = createEmbedFn({ provider: "local", dimensions: 768 }, localFn);
    const result = await fn("test");
    expect(result).toHaveLength(768);
    expect(result[0]).toBe(0.5);
  });

  test("openai provider requires openaiEmbedFn", () => {
    expect(() => createEmbedFn({ provider: "openai", dimensions: 1536 })).toThrow("openaiEmbedFn required");
  });

  test("openai provider uses provided function", async () => {
    const oaiFn = async () => Array(1536).fill(0.1);
    const fn = createEmbedFn({ provider: "openai", dimensions: 1536 }, undefined, oaiFn);
    const result = await fn("test");
    expect(result).toHaveLength(1536);
  });

  test("unknown provider throws", () => {
    expect(() => createEmbedFn({ provider: "bad" as any, dimensions: 1536 })).toThrow("Unknown provider");
  });
});

// ── E2E: Provider Scenarios ─────────────────────────────────

describe("E2E: embedding provider scenarios", () => {
  test("HIPAA-safe local pipeline: config -> validate -> check -> embed", async () => {
    const config = configFromEnv({
      EMBEDDING_PROVIDER: "local",
      LOCAL_EMBEDDING_MODEL_PATH: "/models/e5-base",
      LOCAL_EMBEDDING_RUNTIME: "openvino",
      EMBEDDING_DIMENSIONS: "768",
    });
    expect(validateConfig(config)).toHaveLength(0);
    expect(isHIPAASafe(config).safe).toBe(true);

    const localFn = async (_text: string) => Array(768).fill(0.1);
    const embed = createEmbedFn(config, localFn);
    const result = await embed("Patient John Doe, DOB 1990-01-01");
    expect(result).toHaveLength(768);
  });

  test("cloud pipeline: config -> validate -> request -> parse", () => {
    const config = configFromEnv({
      EMBEDDING_PROVIDER: "openai",
      OPENAI_API_KEY: "sk-test",
    });
    expect(validateConfig(config)).toHaveLength(0);
    expect(isHIPAASafe(config).safe).toBe(false);

    const req = buildOpenAIRequest(config, "CPT 99213 office visit");
    expect(req.headers.Authorization).toContain("sk-test");

    const parsed = parseOpenAIResponse({
      data: [{ embedding: Array(1536).fill(0.1), index: 0 }],
      usage: { total_tokens: 5 },
    });
    expect(parsed.embeddings[0]).toHaveLength(1536);
  });

  test("mock for testing: deterministic and dimension-compatible", async () => {
    const provider = createMockProvider(1536);
    const a = await provider.embed("99213 Office visit");
    const b = await provider.embed("99213 Office visit");
    expect(a).toEqual(b);
    expect(a).toHaveLength(1536); // Compatible with pgvector
  });
});
