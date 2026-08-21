import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import { JsonAdapter } from '../../src/ingest/adapters/json.js';
import { ingestFiles } from '../../src/ingest/sources/files.js';
import { testDbPath } from '../setup.js';

vi.mock('../../src/shared/config.js', () => ({
  CONFIG: {
    FILE_ROOTS: ['./test/fixtures'],
    FILE_INCLUDE_GLOBS: ['**/*.{ts,js,py,md,txt}'],
    FILE_EXCLUDE_GLOBS: ['**/node_modules/**', '**/.git/**'],
  },
}));

describe('File Source Ingestion', () => {
  let adapter: JsonAdapter;
  const fixturesDir = './test/fixtures';
  const testFiles = {
    'sample.ts': `function hello(name: string) {
  return \`Hello, \${name}!\`;
}

export default hello;`,
    'README.md': `# Test Project

This is a test project for demonstration.

## Features

- Feature 1
- Feature 2`,
    'script.py': `def calculate(x, y):
    return x + y

if __name__ == "__main__":
    print(calculate(2, 3))`,
    'data.txt': 'Simple text file content for testing purposes.',
    'nested/deep.js': `const config = {
  debug: true,
  version: "1.0.0"
};

module.exports = config;`,
  };

  beforeEach(async () => {
    adapter = new JsonAdapter({ path: testDbPath, embeddingDim: 1536 });
    await adapter.init();

    if (existsSync(fixturesDir)) {
      rmSync(fixturesDir, { recursive: true, force: true });
    }

    mkdirSync(fixturesDir, { recursive: true });
    mkdirSync(path.join(fixturesDir, 'nested'), { recursive: true });

    for (const [filePath, content] of Object.entries(testFiles)) {
      const fullPath = path.join(fixturesDir, filePath);
      const dir = path.dirname(fullPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(fullPath, content, 'utf8');
    }
  });

  afterEach(async () => {
    await adapter?.close();
    if (existsSync(fixturesDir)) {
      rmSync(fixturesDir, { recursive: true, force: true });
    }
  });

  describe('ingestFiles', () => {
    it('should ingest all matching files', async () => {
      await ingestFiles(adapter);

      // Verify documents were ingested by checking for specific URIs
      const sampleDoc = await adapter.getDocument(
        `file://${path.resolve('./test/fixtures/sample.ts')}`,
      );
      const readmeDoc = await adapter.getDocument(
        `file://${path.resolve('./test/fixtures/README.md')}`,
      );
      const scriptDoc = await adapter.getDocument(
        `file://${path.resolve('./test/fixtures/script.py')}`,
      );
      const dataDoc = await adapter.getDocument(
        `file://${path.resolve('./test/fixtures/data.txt')}`,
      );
      const deepDoc = await adapter.getDocument(
        `file://${path.resolve('./test/fixtures/nested/deep.js')}`,
      );

      expect(sampleDoc).toBeTruthy();
      expect(readmeDoc).toBeTruthy();
      expect(scriptDoc).toBeTruthy();
      expect(dataDoc).toBeTruthy();
      expect(deepDoc).toBeTruthy();
    });

    it('should set correct document metadata', async () => {
      await ingestFiles(adapter);

      // Get the document directly from adapter - we'll need to access the internal db for metadata validation
      const sampleUri = `file://${path.resolve('./test/fixtures/sample.ts')}`;
      const sampleDoc = await adapter.getDocument(sampleUri);
      expect(sampleDoc).toBeTruthy();
      if (sampleDoc) {
        expect(sampleDoc.hash).toBeTruthy();
      }

      // For detailed metadata, we need to access the internal database
      const tsDoc = (await adapter.findDocuments({ uriContains: 'sample.ts' }))[0];
      expect(tsDoc).toBeTruthy();
      expect(tsDoc.source).toBe('file');
      expect(tsDoc.title).toBe('sample.ts');
      expect(tsDoc.lang).toBe('ts');
      expect(tsDoc.hash).toBeTruthy();
      expect(tsDoc.mtime).toBeGreaterThan(0);
      expect(tsDoc.path).toContain('sample.ts');
    });

    it('should create chunks for ingested files', async () => {
      await ingestFiles(adapter);

      // Check if any document has chunks
      const sampleUri = `file://${path.resolve('./test/fixtures/sample.ts')}`;
      const sampleDoc = await adapter.getDocument(sampleUri);
      expect(sampleDoc).toBeTruthy();
      if (sampleDoc) {
        const hasChunks = await adapter.hasChunks(sampleDoc.id);
        expect(hasChunks).toBe(true);
      } else {
        throw new Error('Sample document not found');
      }

      // Check for chunks containing 'hello'
      const chunkWithContent = (await adapter.findChunks({ contentContains: 'hello' }))[0];
      expect(chunkWithContent).toBeTruthy();
    });

    it('should handle different file types appropriately', async () => {
      await ingestFiles(adapter);

      const tsDoc = (await adapter.findDocuments({ uriContains: 'sample.ts' }))[0];
      const mdDoc = (await adapter.findDocuments({ uriContains: 'README.md' }))[0];
      const pyDoc = (await adapter.findDocuments({ uriContains: 'script.py' }))[0];

      expect(tsDoc.lang).toBe('ts');
      expect(mdDoc.lang).toBe('md');
      expect(pyDoc.lang).toBe('py');
    });

    it('should use code chunking for code files', async () => {
      await ingestFiles(adapter);

      const tsDoc = (await adapter.findDocuments({ uriContains: 'sample.ts' }))[0];
      const chunks = await adapter.findChunks({ documentId: tsDoc.id });

      expect(chunks.length).toBeGreaterThan(0);
      chunks.forEach((chunk) => {
        expect(chunk.start_line).toBeGreaterThan(0);
        expect(chunk.end_line).toBeGreaterThanOrEqual(chunk.start_line);
      });
    });

    it('should use document chunking for markdown files', async () => {
      await ingestFiles(adapter);

      const mdDoc = (await adapter.findDocuments({ uriContains: 'README.md' }))[0];
      const chunks = await adapter.findChunks({ documentId: mdDoc.id });

      expect(chunks.length).toBeGreaterThan(0);
    });

    it('should not re-chunk unchanged files', async () => {
      await ingestFiles(adapter);

      const initialChunks = { count: (await adapter.getIndexStats()).chunks };

      await ingestFiles(adapter);

      const finalChunks = { count: (await adapter.getIndexStats()).chunks };
      expect(finalChunks.count).toBe(initialChunks.count);
    });

    it('should handle file read errors gracefully', async () => {
      writeFileSync(path.join(fixturesDir, 'invalid.ts'), 'test content');

      const originalReadFile = fs.readFile;
      vi.spyOn(fs, 'readFile').mockImplementation(async (filePath, encoding) => {
        if (filePath.toString().includes('invalid.ts')) {
          throw new Error('Permission denied');
        }
        return originalReadFile(filePath, encoding);
      });

      await expect(ingestFiles(adapter)).resolves.not.toThrow();

      const documents = await adapter.findDocuments();
      expect(documents.some((d) => d.uri.includes('invalid.ts'))).toBe(false);
    });

    it('should generate proper file URIs', async () => {
      await ingestFiles(adapter);

      const documents = await adapter.findDocuments();
      documents.forEach((doc) => {
        expect(doc.uri).toMatch(/^file:\/\/.*/);
      });
    });

    it('should set relative paths correctly', async () => {
      await ingestFiles(adapter);

      const nestedDoc = (await adapter.findDocuments({ uriContains: 'deep.js' }))[0];
      expect(nestedDoc.path.replace(/\\/g, '/')).toContain('nested/deep.js');
    });

    it('should handle nested directories', async () => {
      await ingestFiles(adapter);

      const nestedDoc = (await adapter.findDocuments({ uriContains: 'deep.js' }))[0];
      expect(nestedDoc).toBeTruthy();
      expect(nestedDoc.title).toBe('deep.js');
    });

    it('should detect file changes and re-chunk', async () => {
      await ingestFiles(adapter);

      const _originalChunks = await adapter.findChunks();
      const sampleChunks = _originalChunks.filter((c) => (c.path ?? '').includes('sample.ts'));

      const modifiedContent = `${testFiles['sample.ts']}\n\n// Modified content`;
      writeFileSync(path.join(fixturesDir, 'sample.ts'), modifiedContent);

      await new Promise((resolve) => setTimeout(resolve, 10));

      await ingestFiles(adapter);

      const newChunks = (await adapter.findChunks()).filter((c) =>
        (c.path ?? '').includes('sample.ts'),
      );

      expect(newChunks.some((c) => c.content.includes('Modified content'))).toBe(true);
    });
  });

  describe('File type detection', () => {
    it('should identify code files correctly', async () => {
      await ingestFiles(adapter);

      const allDocs = await adapter.findDocuments();
      const codeFiles = allDocs.filter((d) => ['ts', 'js', 'py'].includes(d.lang ?? ''));
      expect(codeFiles.length).toBeGreaterThan(0);
    });

    it('should identify document files correctly', async () => {
      await ingestFiles(adapter);

      const allDocs = await adapter.findDocuments();
      const docFiles = allDocs.filter((d) => ['md', 'txt'].includes(d.lang ?? ''));
      expect(docFiles.length).toBeGreaterThan(0);
    });

    it('should handle unknown extensions within configured globs', async () => {
      // Create a file with an extension that matches the glob but isn't in CODE_EXT or DOC_EXT
      writeFileSync(path.join(fixturesDir, 'config.txt'), 'config file content');

      await ingestFiles(adapter);

      const txtFile = (await adapter.findDocuments({ uriContains: 'config.txt' }))[0];
      expect(txtFile).toBeTruthy();
      expect(txtFile.lang).toBe('txt');

      // Verify that files outside the glob pattern are NOT ingested
      writeFileSync(path.join(fixturesDir, 'unknown.xyz'), 'unknown file type content');
      await ingestFiles(adapter);

      const unknownFile = (await adapter.findDocuments({ uriContains: 'unknown.xyz' }))[0];
      expect(unknownFile).toBeFalsy(); // Should not be ingested as it doesn't match the glob
    });
  });

  describe('Error handling', () => {
    it('should continue ingestion even if individual files fail', async () => {
      writeFileSync(path.join(fixturesDir, 'good.ts'), 'const x = 1;');

      const originalReadFile = fs.readFile;
      const readFileSpy = vi
        .spyOn(fs, 'readFile')
        .mockImplementation(async (filePath, encoding) => {
          const pathStr = filePath.toString();
          if (pathStr.includes('sample.ts')) {
            throw new Error('Read error');
          }
          // Use type assertion to handle overload signatures properly
          return originalReadFile(filePath as never, encoding as never) as never;
        });

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';

      await ingestFiles(adapter);

      // Check assertions before restoring mocks
      expect(consoleSpy).toHaveBeenCalled();

      const goodDoc = (await adapter.findDocuments({ uriContains: 'good.ts' }))[0];
      expect(goodDoc).toBeTruthy();

      // Cleanup
      process.env.NODE_ENV = originalEnv;
      readFileSpy.mockRestore();
      consoleSpy.mockRestore();
    });
  });
});
