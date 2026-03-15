/**
 * Pluggable Embedding Provider — ELLIE-749
 *
 * Abstraction over embedding sources: OpenAI (cloud) or local model.
 * HIPAA compliance: local mode ensures PHI never leaves the server.
 *
 * Pure provider pattern — actual HTTP/NPU calls are in provider implementations.
 * Core logic (config, routing, validation, batching) is fully testable.
 */

// ── Types ────────────────────────────────────────────────────

export type EmbeddingProviderType = "openai" | "local" | "mock";

export const VALID_PROVIDER_TYPES: EmbeddingProviderType[] = ["openai", "local", "mock"];

/** Configuration for the embedding provider. */
export interface EmbeddingConfig {
  provider: EmbeddingProviderType;
  /** OpenAI API key (required for openai provider). */
  openai_api_key?: string;
  /** OpenAI model name. */
  openai_model?: string;
  /** Local model path (for local provider). */
  local_model_path?: string;
  /** Local runtime: openvino (NPU) or onnx (GPU/CPU). */
  local_runtime?: "openvino" | "onnx";
  /** Output dimension. Must match pgvector column. */
  dimensions: number;
  /** Max tokens per embedding request. */
  max_tokens?: number;
  /** Batch size for bulk embedding. */
  batch_size?: number;
}

/** Result of a single embedding operation. */
export interface EmbeddingResult {
  embedding: number[];
  dimensions: number;
  provider: EmbeddingProviderType;
  latency_ms: number;
  tokens_used: number | null;
}

/** Result of a batch embedding operation. */
export interface BatchEmbeddingResult {
  embeddings: number[][];
  dimensions: number;
  provider: EmbeddingProviderType;
  total_latency_ms: number;
  total_tokens: number | null;
  count: number;
}

/** The embed function signature used across the billing pipeline. */
export type EmbedFn = (text: string) => Promise<number[]>;

/** A provider implementation. */
export interface EmbeddingProvider {
  type: EmbeddingProviderType;
  embed: EmbedFn;
  embedBatch: (texts: string[]) => Promise<number[][]>;
  dimensions: number;
  isLocal: boolean;
}

// ── Default Config ──────────────────────────────────────────

export const DEFAULT_DIMENSIONS = 1536;
export const DEFAULT_OPENAI_MODEL = "text-embedding-3-small";
export const DEFAULT_BATCH_SIZE = 100;
export const DEFAULT_MAX_TOKENS = 8191;

export function defaultConfig(): EmbeddingConfig {
  return {
    provider: "openai",
    dimensions: DEFAULT_DIMENSIONS,
    openai_model: DEFAULT_OPENAI_MODEL,
    batch_size: DEFAULT_BATCH_SIZE,
    max_tokens: DEFAULT_MAX_TOKENS,
  };
}

// ── Config from Environment ─────────────────────────────────

/**
 * Build embedding config from environment variables.
 * Pure function — env is passed in as a record.
 */
export function configFromEnv(env: Record<string, string | undefined>): EmbeddingConfig {
  const provider = (env.EMBEDDING_PROVIDER ?? "openai") as EmbeddingProviderType;

  return {
    provider,
    openai_api_key: env.OPENAI_API_KEY,
    openai_model: env.OPENAI_EMBEDDING_MODEL ?? DEFAULT_OPENAI_MODEL,
    local_model_path: env.LOCAL_EMBEDDING_MODEL_PATH,
    local_runtime: (env.LOCAL_EMBEDDING_RUNTIME ?? "onnx") as "openvino" | "onnx",
    dimensions: env.EMBEDDING_DIMENSIONS ? parseInt(env.EMBEDDING_DIMENSIONS, 10) : DEFAULT_DIMENSIONS,
    batch_size: env.EMBEDDING_BATCH_SIZE ? parseInt(env.EMBEDDING_BATCH_SIZE, 10) : DEFAULT_BATCH_SIZE,
    max_tokens: DEFAULT_MAX_TOKENS,
  };
}

// ── Validation ──────────────────────────────────────────────

/**
 * Validate an embedding config.
 */
export function validateConfig(config: EmbeddingConfig): string[] {
  const errors: string[] = [];

  if (!VALID_PROVIDER_TYPES.includes(config.provider)) {
    errors.push(`Invalid provider: ${config.provider}. Valid: ${VALID_PROVIDER_TYPES.join(", ")}`);
  }

  if (config.provider === "openai" && !config.openai_api_key) {
    errors.push("openai_api_key is required for OpenAI provider");
  }

  if (config.provider === "local" && !config.local_model_path) {
    errors.push("local_model_path is required for local provider");
  }

  if (config.dimensions < 1) {
    errors.push("dimensions must be >= 1");
  }

  if (config.batch_size !== undefined && config.batch_size < 1) {
    errors.push("batch_size must be >= 1");
  }

  return errors;
}

// ── HIPAA Compliance Check ──────────────────────────────────

/**
 * Check if the current config is HIPAA-safe (no PHI sent externally).
 */
export function isHIPAASafe(config: EmbeddingConfig): {
  safe: boolean;
  reason: string;
} {
  if (config.provider === "local") {
    return { safe: true, reason: "Local embedding — PHI stays on server" };
  }
  if (config.provider === "mock") {
    return { safe: true, reason: "Mock provider — no external calls" };
  }
  return {
    safe: false,
    reason: "OpenAI provider sends data to external API — not HIPAA-safe for PHI",
  };
}

// ── Mock Provider (for testing) ─────────────────────────────

/**
 * Create a mock embedding provider for testing.
 * Produces deterministic embeddings from text hash.
 */
export function createMockProvider(dimensions: number = DEFAULT_DIMENSIONS): EmbeddingProvider {
  function hashEmbed(text: string): number[] {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash) + text.charCodeAt(i);
      hash = hash & hash;
    }
    const rng = seedRng(Math.abs(hash));
    return Array.from({ length: dimensions }, () => rng() * 2 - 1);
  }

  return {
    type: "mock",
    embed: async (text) => hashEmbed(text),
    embedBatch: async (texts) => texts.map(hashEmbed),
    dimensions,
    isLocal: true,
  };
}

function seedRng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

// ── OpenAI Request Builder (Pure) ───────────────────────────

export interface OpenAIEmbedRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

/**
 * Build an OpenAI embedding API request.
 * Pure function — caller performs the HTTP call.
 */
export function buildOpenAIRequest(
  config: EmbeddingConfig,
  input: string | string[],
): OpenAIEmbedRequest {
  return {
    url: "https://api.openai.com/v1/embeddings",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.openai_api_key}`,
    },
    body: JSON.stringify({
      input,
      model: config.openai_model ?? DEFAULT_OPENAI_MODEL,
      dimensions: config.dimensions,
    }),
  };
}

/**
 * Parse an OpenAI embedding API response.
 */
export function parseOpenAIResponse(
  responseBody: { data?: { embedding: number[]; index: number }[]; usage?: { total_tokens: number } },
): { embeddings: number[][]; tokens_used: number } {
  const embeddings = (responseBody.data ?? [])
    .sort((a, b) => a.index - b.index)
    .map(d => d.embedding);

  return {
    embeddings,
    tokens_used: responseBody.usage?.total_tokens ?? 0,
  };
}

// ── Batching Utility ────────────────────────────────────────

/**
 * Split texts into batches of the configured size.
 * Pure function.
 */
export function batchTexts(texts: string[], batchSize: number = DEFAULT_BATCH_SIZE): string[][] {
  const batches: string[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    batches.push(texts.slice(i, i + batchSize));
  }
  return batches;
}

// ── Provider Factory ────────────────────────────────────────

/**
 * Create an embed function from config.
 * Returns the EmbedFn used throughout the billing pipeline.
 *
 * For openai: caller must wrap buildOpenAIRequest + fetch + parseOpenAIResponse.
 * For local: caller must provide the local inference function.
 * For mock: uses built-in deterministic mock.
 */
export function createEmbedFn(
  config: EmbeddingConfig,
  localEmbedFn?: EmbedFn,
  openaiEmbedFn?: EmbedFn,
): EmbedFn {
  switch (config.provider) {
    case "mock":
      return createMockProvider(config.dimensions).embed;
    case "local":
      if (!localEmbedFn) throw new Error("localEmbedFn required for local provider");
      return localEmbedFn;
    case "openai":
      if (!openaiEmbedFn) throw new Error("openaiEmbedFn required for openai provider");
      return openaiEmbedFn;
    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}
