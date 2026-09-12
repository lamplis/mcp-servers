import { JsonAdapter, type JsonAdapterConfig } from './json.js';
import { CONFIG } from '../../shared/config.js';

import type { DatabaseAdapter } from './types.js';

export function createDatabaseAdapter(config?: Partial<JsonAdapterConfig>): DatabaseAdapter {
  return new JsonAdapter({
    path: config?.path ?? CONFIG.DB_PATH,
    embeddingDim:
      config?.embeddingDim ??
      (CONFIG.EMBEDDINGS_PROVIDER === 'local' ? CONFIG.LOCAL_EMBED_DIM : CONFIG.OPENAI_EMBED_DIM),
    embeddingModel:
      config?.embeddingModel ??
      (CONFIG.EMBEDDINGS_PROVIDER === 'local' ? CONFIG.LOCAL_EMBED_MODEL : CONFIG.OPENAI_EMBED_MODEL),
    embeddingProvider: config?.embeddingProvider ?? CONFIG.EMBEDDINGS_PROVIDER,
    ...(config?.diskGate ? { diskGate: config.diskGate } : {}),
  });
}
