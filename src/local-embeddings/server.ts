import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  embedTexts,
  getCacheDir,
  getCacheStats,
  getConcurrencyLimit,
  getDefaultModelId,
  getLoadedModels,
  prefetchModel,
} from "./embedder.js";

const packageJson = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8")
) as { version: string };

const MAX_CHARS = parsePositiveInt(process.env.MAX_CHARS, 20000);
const MAX_BATCH = parsePositiveInt(process.env.MAX_BATCH, 64);

const EmbeddingOutputSchema = z.object({
  index: z.number().int(),
  embedding: z.array(z.number()),
});

export type LocalEmbeddingsServerFactoryResponse = {
  server: McpServer;
  cleanup: () => void;
};

export async function createServer(): Promise<LocalEmbeddingsServerFactoryResponse> {
  const server = new McpServer({
    name: "local-embeddings",
    version: packageJson.version,
  });

  server.registerTool(
    "embeddings",
    {
      title: "Generate embeddings",
      description:
        "Generate embedding vectors for input text(s) using a fully local model.",
      inputSchema: {
        input: z.union([z.string(), z.array(z.string())]),
        model: z.string().optional(),
        normalize: z.boolean().optional(),
        pooling: z.enum(["mean", "cls"]).optional(),
      },
      outputSchema: {
        model: z.string(),
        data: z.array(EmbeddingOutputSchema),
        dimensions: z.number().int(),
        normalized: z.boolean(),
      },
    },
    async (input) => {
      const texts = Array.isArray(input.input) ? input.input : [input.input];
      const model = input.model ?? getDefaultModelId();
      const normalize = input.normalize ?? true;
      const pooling = input.pooling ?? "mean";

      if (texts.length > MAX_BATCH) {
        return toolError(
          `Too many inputs: ${texts.length}. Max batch size is ${MAX_BATCH}.`
        );
      }

      for (const text of texts) {
        if (text.length > MAX_CHARS) {
          return toolError(
            `Input text exceeds MAX_CHARS (${MAX_CHARS}). Reduce input size.`
          );
        }
      }

      try {
        const result = await embedTexts(texts, { model, normalize, pooling });
        const data = result.embeddings.map((embedding, index) => ({
          index,
          embedding,
        }));
        const dimensions = result.embeddings[0]?.length ?? 0;
        const payload = {
          model: result.model,
          data,
          dimensions,
          normalized: result.normalized,
        };

        return {
          content: [
            { type: "text" as const, text: JSON.stringify(payload, null, 2) },
          ],
          structuredContent: payload,
        };
      } catch (error) {
        return toolError(
          error instanceof Error ? error.message : "Failed to generate embeddings"
        );
      }
    }
  );

  server.registerTool(
    "prefetch_model",
    {
      title: "Prefetch embedding model",
      description:
        "Download and cache the embedding model for offline use.",
      inputSchema: {
        model: z.string().optional(),
      },
      outputSchema: {
        model: z.string(),
        cacheDir: z.string(),
        status: z.literal("ok"),
      },
    },
    async (input) => {
      const model = input.model ?? getDefaultModelId();
      try {
        await prefetchModel(model);
        const payload = {
          model,
          cacheDir: getCacheDir(),
          status: "ok" as const,
        };
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(payload, null, 2) },
          ],
          structuredContent: payload,
        };
      } catch (error) {
        return toolError(
          error instanceof Error ? error.message : "Failed to prefetch model"
        );
      }
    }
  );

  server.registerTool(
    "health",
    {
      title: "Health check",
      description: "Report model and runtime status.",
      inputSchema: {},
      outputSchema: {
        model: z.string(),
        modelLoaded: z.boolean(),
        cacheDir: z.string(),
        cacheEntries: z.number().int(),
        cacheCapacity: z.number().int(),
        concurrency: z.number().int(),
        runtime: z.object({
          node: z.string(),
          platform: z.string(),
          arch: z.string(),
        }),
      },
    },
    async () => {
      const model = getDefaultModelId();
      const loadedModels = getLoadedModels();
      const cacheStats = getCacheStats();
      const payload = {
        model,
        modelLoaded: loadedModels.includes(model),
        cacheDir: getCacheDir(),
        cacheEntries: cacheStats.entries,
        cacheCapacity: cacheStats.capacity,
        concurrency: getConcurrencyLimit(),
        runtime: {
          node: process.version,
          platform: process.platform,
          arch: process.arch,
        },
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
      };
    }
  );

  return {
    server,
    cleanup: () => {
      // No background tasks to clean up yet.
    },
  };
}

function toolError(message: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}
