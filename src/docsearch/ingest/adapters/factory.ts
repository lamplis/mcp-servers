import { SqliteAdapter, type SqliteConfig } from './sqlite.js';
import { CONFIG } from '../../shared/config.js';
import { getEmbeddingDimension } from '../embeddings.js';

import type { DatabaseAdapter } from './types.js';

export function createDatabaseAdapter(config?: Partial<SqliteConfig>): DatabaseAdapter {
  const sqliteConfig: SqliteConfig = {
    path: config?.path ?? CONFIG.DB_PATH,
    embeddingDim: config?.embeddingDim ?? getEmbeddingDimension(),
  };
  return new SqliteAdapter(sqliteConfig);
}
