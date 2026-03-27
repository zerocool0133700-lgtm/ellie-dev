import { describe, it, expect } from "bun:test";

describe("ELLIE-1051: Multi-provider AI abstraction", () => {
  describe("provider interfaces", () => {
    it("exports EmbeddingProvider type", async () => {
      const mod = await import("../../ellie-forest/src/providers/index.ts");
      // Type-only export — just verify the module loads
      expect(mod).toBeDefined();
    });
  });

  describe("openai provider", () => {
    it("exports embedding and llm providers", async () => {
      const { openaiEmbeddings, openaiLlm } = await import("../../ellie-forest/src/providers/openai.ts");
      expect(openaiEmbeddings.name).toBe("openai");
      expect(openaiEmbeddings.dimensions).toBe(1536);
      expect(typeof openaiEmbeddings.generateEmbedding).toBe("function");
      expect(typeof openaiLlm.complete).toBe("function");
    });
  });

  describe("ollama provider", () => {
    it("exports embedding and llm providers", async () => {
      const { ollamaEmbeddings, ollamaLlm } = await import("../../ellie-forest/src/providers/ollama.ts");
      expect(ollamaEmbeddings.name).toBe("ollama");
      expect(typeof ollamaEmbeddings.generateEmbedding).toBe("function");
      expect(typeof ollamaLlm.complete).toBe("function");
    });
  });

  describe("resolver", () => {
    it("returns a provider when OpenAI key is set", async () => {
      const { getEmbeddingProvider } = await import("../../ellie-forest/src/providers/resolver.ts");
      // OPENAI_API_KEY is set in .env
      const provider = getEmbeddingProvider();
      if (process.env.OPENAI_API_KEY) {
        expect(provider).not.toBeNull();
        expect(provider!.name).toBe("openai");
      }
    });

    it("listProviders returns all providers", async () => {
      const { listProviders } = await import("../../ellie-forest/src/providers/resolver.ts");
      const providers = listProviders();
      expect(providers.length).toBeGreaterThanOrEqual(4); // 2 embedding + 2 llm
      expect(providers.some(p => p.name === "openai" && p.type === "embedding")).toBe(true);
      expect(providers.some(p => p.name === "ollama" && p.type === "embedding")).toBe(true);
    });
  });

  describe("embeddings.ts backward compat", () => {
    it("still exports generateEmbedding", async () => {
      const mod = await import("../../ellie-forest/src/embeddings.ts");
      expect(typeof mod.generateEmbedding).toBe("function");
      expect(typeof mod.generateEmbeddings).toBe("function");
      expect(typeof mod.embeddingsAvailable).toBe("function");
    });
  });
});
