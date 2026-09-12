import { createDatabaseAdapter } from './adapters/index.js';

import type { DatabaseAdapter } from './adapters/index.js';
import type { JsonAdapterConfig } from './adapters/json.js';

let _adapter: DatabaseAdapter | null = null;
let _defaults: Partial<JsonAdapterConfig> = {};

export function configureDatabase(config: Partial<JsonAdapterConfig>): void {
  _defaults = { ..._defaults, ...config };
}

export async function getDatabase(): Promise<DatabaseAdapter> {
  if (!_adapter) {
    _adapter = createDatabaseAdapter(_defaults);
    await _adapter.init();
  }
  return _adapter;
}

export async function closeDatabase(): Promise<void> {
  if (_adapter) {
    await _adapter.close();
    _adapter = null;
  }
}
