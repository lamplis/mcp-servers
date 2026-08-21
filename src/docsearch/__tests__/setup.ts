import { existsSync, rmSync } from 'fs';

import { beforeEach } from 'vitest';

const TEST_INDEX_DIR = './test/test-index';

// Polyfill File constructor for Node.js environment (needed by undici in testcontainers)
if (typeof globalThis.File === 'undefined') {
  globalThis.File = class File {
    constructor(fileBits: BlobPart[], fileName: string, options?: FilePropertyBag) {
      // Basic polyfill that should satisfy undici's usage
      this.name = fileName;
      this.lastModified = options?.lastModified || Date.now();
      this.type = options?.type || '';
    }

    name: string;
    lastModified: number;
    type: string;
  } as any;
}

beforeEach(() => {
  if (existsSync(TEST_INDEX_DIR)) {
    rmSync(TEST_INDEX_DIR, { recursive: true, force: true });
  }
});

export const testDbPath = TEST_INDEX_DIR;
