# Fake Qdrant Integration Tests

This directory contains integration tests for the fake Qdrant HTTP API implementation. These tests validate that the server correctly implements the Qdrant HTTP API specification.

## Running Tests

```powershell
cd src/fake-qdrant

# Run tests once with coverage
npm test

# Run tests in watch mode (for development)
npm run test:watch

# Run tests with verbose output
npx vitest run --reporter=verbose
```

## Test Coverage

The integration tests cover the following Qdrant HTTP API endpoints:

### Health and Status
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Root health check |
| `/healthz` | GET | Health check endpoint |

### Collections
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/collections` | GET | List all collections |
| `/collections/{name}` | PUT | Create a collection |
| `/collections/{name}` | GET | Get collection info |
| `/collections/{name}` | DELETE | Delete a collection |

### Points
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/collections/{name}/points` | PUT | Upsert points |
| `/collections/{name}/points/query` | POST | Query/search points |
| `/collections/{name}/points/delete` | POST | Delete points (by ID or filter) |

### Collection Management
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/collections/{name}/compact` | POST | Compact collection (deduplicate and rebuild index) |

### Error Handling
- Invalid requests (malformed JSON, missing fields)
- Missing required parameters
- Non-existent resources (404 responses)
- CORS headers validation

## Test Architecture

Each test suite follows this pattern:

1. **Setup (`beforeEach`):**
   - Creates a unique test data directory
   - Initializes a fresh Store instance
   - Starts the HTTP server on a dynamic port (port 0)

2. **Execution:**
   - Performs HTTP requests to validate API behavior
   - Asserts response status codes and body content

3. **Teardown (`afterEach`):**
   - Closes the HTTP server
   - Cleans up the test data directory

## Test Configuration

Tests use **Vitest** as the testing framework, consistent with other MCP servers in this repository.

Configuration file: `vitest.config.ts`

```typescript
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/__tests__/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['**/*.ts'],
      exclude: ['**/__tests__/**', '**/dist/**'],
    },
  },
});
```

## Test Sources and References

The tests are based on the Qdrant HTTP API specification and patterns found in:

### Primary Sources

1. **Qdrant Official Repository**
   - URL: https://github.com/qdrant/qdrant
   - Test Directory: https://github.com/qdrant/qdrant/tree/master/tests
   - Contains integration tests, API tests, and OpenAPI specifications

2. **Qdrant Python Client**
   - URL: https://github.com/qdrant/qdrant-client
   - Comprehensive client implementation with usage examples
   - Local mode for testing (`:memory:` mode)

3. **Qdrant API Reference**
   - URL: https://github.com/qdrant/api-reference
   - OpenAPI/Swagger specifications
   - Complete API documentation with request/response examples

### API Documentation

- Qdrant Documentation: https://qdrant.tech/documentation/
- Qdrant HTTP API Reference: https://qdrant.github.io/qdrant/redoc/index.html

## Validation Approach

The tests validate:

| Aspect | Description |
|--------|-------------|
| **HTTP Status Codes** | Correct status codes for success (200) and error cases (400, 404, 500) |
| **Response Format** | JSON responses match Qdrant API format with `result`, `status`, and `time` fields |
| **Data Integrity** | CRUD operations work correctly; data persists across operations |
| **Error Handling** | Appropriate error messages for invalid requests |
| **API Compatibility** | Support for various request formats (e.g., `vector` vs `query.vector`) |
| **CORS Headers** | Proper CORS headers for browser-based clients |

## Adding New Tests

When adding new tests:

1. **Follow the existing pattern** - Use `describe` blocks for grouping related tests
2. **Use dynamic ports** - Always use port 0 to avoid conflicts
3. **Clean up resources** - Ensure `afterEach` properly closes servers and removes test data
4. **Test edge cases** - Include tests for error conditions and boundary cases

Example test structure:

```typescript
describe('New Feature', () => {
  beforeEach(async () => {
    // Setup
  });

  afterEach(async () => {
    // Cleanup
  });

  it('should handle expected case', async () => {
    const response = await httpRequest('POST', '/endpoint', { data: 'value' });
    expect(response.status).toBe(200);
    expect(response.data).toMatchObject({ expected: 'result' });
  });

  it('should reject invalid input', async () => {
    const response = await httpRequest('POST', '/endpoint', { invalid: true });
    expect(response.status).toBe(400);
  });
});
```

## Expanding Test Coverage

Future test additions to consider:

| Category | Description |
|----------|-------------|
| **Complex Filters** | Test nested filter conditions, multiple must/should clauses |
| **Batch Operations** | Test large batch upserts (1000+ points) |
| **Edge Cases** | Empty collections, zero vectors, maximum dimensions |
| **Performance** | Query latency with large datasets |
| **Concurrent Operations** | Thread-safety and race condition testing |
| **Payload Filtering** | Test filtering queries by payload fields |

## Troubleshooting Tests

### Tests fail with EADDRINUSE

The tests use dynamic port allocation (port 0). If you see port conflicts:

1. Ensure no other test process is running
2. Check for zombie Node.js processes:
   ```powershell
   Get-Process node | Stop-Process -Force
   ```

### Tests timeout

Increase the test timeout in `vitest.config.ts`:

```typescript
test: {
  testTimeout: 30000, // 30 seconds
}
```

### Coverage not generating

Ensure `@vitest/coverage-v8` is installed:

```powershell
npm install --save-dev @vitest/coverage-v8
```
