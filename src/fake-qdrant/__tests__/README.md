# Fake Qdrant HTTP API Integration Tests

This directory contains integration tests for the fake Qdrant HTTP API implementation. These tests validate that the fake Qdrant server correctly implements the Qdrant HTTP API specification.

## Test Sources

The tests are based on the Qdrant HTTP API specification and patterns found in:

1. **Qdrant Official Repository**: https://github.com/qdrant/qdrant
   - Tests directory: https://github.com/qdrant/qdrant/tree/master/tests
   - API documentation and examples

2. **Qdrant Client Libraries**: Various client implementations that demonstrate expected API behavior:
   - Python client: https://github.com/qdrant/qdrant-client
   - Other language clients that show API usage patterns

3. **Qdrant API Reference**: https://github.com/qdrant/api-reference
   - OpenAPI specifications
   - HTTP endpoint documentation

## Test Coverage

The integration tests cover the following Qdrant HTTP API endpoints:

### Health & Status
- `GET /` - Root health check
- `GET /healthz` - Health check endpoint

### Collections
- `GET /collections` - List all collections
- `PUT /collections/{name}` - Create a collection
- `GET /collections/{name}` - Get collection info
- `DELETE /collections/{name}` - Delete a collection

### Points
- `PUT /collections/{name}/points` - Upsert points
- `POST /collections/{name}/points/query` - Query/search points
- `POST /collections/{name}/points/delete` - Delete points (by ID or filter)

### Collection Management
- `POST /collections/{name}/compact` - Compact collection (deduplicate and rebuild index)

### Error Handling
- Invalid requests
- Missing parameters
- Non-existent resources
- CORS headers

## Running Tests

```bash
# Run tests once
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm test -- --coverage
```

## Test Structure

Each test suite:
1. Sets up a fresh store instance with a unique test data directory
2. Starts the HTTP server on a test port
3. Performs HTTP requests to validate API behavior
4. Cleans up resources after each test

Tests use Vitest as the testing framework, consistent with other MCP servers in this repository.

## Validation Approach

The tests validate:
- **HTTP Status Codes**: Correct status codes for success and error cases
- **Response Format**: JSON responses match Qdrant API format
- **Data Integrity**: Operations (create, read, update, delete) work correctly
- **Error Handling**: Appropriate error messages for invalid requests
- **API Compatibility**: Support for various request formats (e.g., `vector` vs `query.vector`)

These tests ensure the fake Qdrant implementation can serve as a drop-in replacement for testing purposes, compatible with Qdrant client libraries and tools that expect the standard Qdrant HTTP API.
