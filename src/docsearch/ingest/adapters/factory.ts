import { JsonAdapter, type JsonAdapterConfig } from './json.js';
import { CONFIG } from '../../shared/config.js';

import type { DatabaseAdapter } from './types.js';

export function createDatabaseAdapter(config?: Partial<JsonAdapterConfig>): DatabaseAdapter {
  const jsonConfig: JsonAdapterConfig = {
    path: config?.path ?? CONFIG.DB_PATH,
    embeddingDim:
      config?.embeddingDim ??
      (CONFIG.EMBEDDINGS_PROVIDER === 'local' ? CONFIG.LOCAL_EMBED_DIM : CONFIG.OPENAI_EMBED_DIM),
  };
  return new JsonAdapter(jsonConfig);
}
