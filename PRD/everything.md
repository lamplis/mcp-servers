# Product Requirements Document: Everything MCP Server

## Executive Summary

The Everything MCP Server is a comprehensive reference implementation and test server for the Model Context Protocol (MCP). It serves as a demonstration platform showcasing all major MCP features including tools, prompts, resources, sampling, progress notifications, logging, and multi-transport support. This server is not intended for production use but rather as a testing and learning tool for MCP client developers and protocol implementers.

## Product Overview

### Purpose
The Everything server exercises all features of the MCP protocol to provide a complete reference implementation. It demonstrates best practices for implementing MCP servers and serves as a test harness for validating MCP client implementations.

### Target Users
- MCP client developers building new MCP integrations
- Protocol implementers testing MCP feature support
- Developers learning MCP capabilities and patterns
- QA engineers testing MCP client functionality

### Value Proposition
- Complete feature coverage of MCP protocol capabilities
- Reference implementation demonstrating best practices
- Test harness for validating client implementations
- Educational resource for understanding MCP architecture

## Goals and Objectives

### Primary Goals
1. Demonstrate all MCP protocol features in a single server
2. Provide a comprehensive test suite for MCP clients
3. Serve as a reference implementation for server developers
4. Support multiple transport mechanisms (STDIO, SSE, Streamable HTTP)
5. Enable multi-client concurrent session support

### Success Metrics
- All MCP protocol features are implemented and functional
- Server successfully demonstrates tools, prompts, resources, and advanced features
- Multiple clients can connect concurrently without conflicts
- Documentation provides clear examples for each feature

## Features and Capabilities

### Core Features
1. **Tool Registration** - Multiple tools demonstrating various input/output patterns
2. **Prompt System** - Static and dynamic prompts with argument handling
3. **Resource Management** - Dynamic, static, and session-scoped resources
4. **Resource Subscriptions** - Real-time resource update notifications
5. **Simulated Logging** - Configurable logging with level filtering
6. **Progress Notifications** - Long-running operation progress tracking
7. **Sampling Integration** - LLM sampling request capabilities
8. **Structured Content** - Schema-validated structured responses
9. **Multi-Transport Support** - STDIO, SSE, and Streamable HTTP transports
10. **Roots Protocol** - Dynamic directory access control

## Tools/API Reference

### Tools

#### `echo`
- **Description**: Echoes the provided message
- **Input**: `message` (string)
- **Output**: Echoed message text
- **Use Case**: Simple tool demonstration with Zod validation

#### `get-annotated-message`
- **Description**: Returns a text message annotated with priority and audience
- **Input**: 
  - `messageType` (string): "error", "success", or "debug"
  - `image` (optional): Image content item
- **Output**: Annotated message with priority and audience metadata
- **Use Case**: Demonstrates message annotation capabilities

#### `get-env`
- **Description**: Returns all environment variables from the running process
- **Input**: None
- **Output**: Pretty-printed JSON text of all environment variables
- **Use Case**: Environment inspection and debugging

#### `get-resource-links`
- **Description**: Returns multiple resource_link items
- **Input**: `count` (number, 1-10)
- **Output**: Intro text block followed by resource_link items alternating between Text and Blob resources
- **Use Case**: Demonstrates resource linking patterns

#### `get-resource-reference`
- **Description**: Returns concrete resource content blocks
- **Input**: 
  - `resourceType` (string): "text" or "blob"
  - `resourceId` (number): Positive integer
- **Output**: Resource content block with URI, mimeType, and data
- **Use Case**: Direct resource content retrieval

#### `get-roots-list`
- **Description**: Returns the last list of roots sent by the client
- **Input**: None
- **Output**: List of root directories
- **Requirements**: Client must support roots protocol capability
- **Use Case**: Demonstrates roots protocol integration

#### `gzip-file-as-resource`
- **Description**: Fetches data, compresses it, and registers as session resource
- **Input**: 
  - `name` (string): Resource name
  - `data` (string): URL or data URI
  - `outputType` (optional): "link" or "resource"
- **Output**: Resource link or inline resource with gzip content
- **Use Case**: Demonstrates session-scoped resource creation

#### `get-structured-content`
- **Description**: Demonstrates structured responses with schema validation
- **Input**: `location` (string)
- **Output**: 
  - Backward-compatible `content` (JSON text)
  - `structuredContent` validated by outputSchema (temperature, conditions, humidity)
- **Use Case**: Structured content response patterns

#### `get-sum`
- **Description**: Calculates sum of two numbers
- **Input**: 
  - `a` (number)
  - `b` (number)
- **Output**: Sum result
- **Use Case**: Simple mathematical operation with Zod validation

#### `get-tiny-image`
- **Description**: Returns a tiny PNG MCP logo as image content
- **Input**: None
- **Output**: Image content item with descriptive text
- **Use Case**: Image content demonstration

#### `trigger-long-running-operation`
- **Description**: Simulates multi-step operation with progress reporting
- **Input**: 
  - `duration` (number): Operation duration
  - `steps` (number): Number of steps
  - `progressToken` (optional): Token for progress notifications
- **Output**: Operation result
- **Use Case**: Progress notification demonstration

#### `toggle-simulated-logging`
- **Description**: Starts or stops simulated logging for the session
- **Input**: None
- **Output**: Logging state confirmation
- **Use Case**: Logging system demonstration

#### `toggle-subscriber-updates`
- **Description**: Starts or stops simulated resource update notifications
- **Input**: None
- **Output**: Subscription state confirmation
- **Use Case**: Resource subscription demonstration

#### `trigger-sampling-request`
- **Description**: Issues sampling/createMessage request to client/LLM
- **Input**: 
  - `prompt` (string): Prompt for LLM
  - Generation controls (optional)
- **Output**: LLM response payload
- **Requirements**: Client must support sampling capability
- **Use Case**: LLM sampling integration demonstration

### Prompts

#### `simple-prompt`
- **Description**: No-argument prompt returning static user message
- **Input**: None
- **Output**: Static user message

#### `args-prompt`
- **Description**: Two-argument prompt with city and optional state
- **Input**: 
  - `city` (string, required)
  - `state` (string, optional)
- **Output**: Composed question message

#### `completable-prompt`
- **Description**: Demonstrates argument auto-completions
- **Input**: 
  - `department` (string): Drives context-aware name suggestions
  - `name` (string): Auto-completed based on department
- **Output**: Message with auto-completed arguments
- **Use Case**: Argument completion demonstration

#### `resource-prompt`
- **Description**: Accepts resource type and ID, returns embedded resource
- **Input**: 
  - `resourceType` (string): "Text" or "Blob"
  - `resourceId` (string): Convertible to integer
- **Output**: Message with embedded dynamic resource
- **Use Case**: Resource embedding in prompts

### Resources

#### Dynamic Text Resources
- **URI Pattern**: `demo://resource/dynamic/text/{index}`
- **Type**: Dynamic content generated on the fly
- **Use Case**: Demonstrates dynamic text resource generation

#### Dynamic Blob Resources
- **URI Pattern**: `demo://resource/dynamic/blob/{index}`
- **Type**: Base64 payload generated on the fly
- **Use Case**: Demonstrates dynamic binary resource generation

#### Static Document Resources
- **URI Pattern**: `demo://resource/static/document/<filename>`
- **Type**: Files served from `src/everything/docs/` directory
- **Use Case**: Static file-based resource serving

#### Session-Scoped Resources
- **URI Pattern**: `demo://resource/session/<name>`
- **Type**: Per-session resources registered dynamically
- **Lifetime**: Available only for the lifetime of the session
- **Use Case**: Temporary resource creation without persistence

## Use Cases and User Stories

### Use Case 1: Client Feature Testing
**As a** MCP client developer  
**I want to** test all MCP protocol features  
**So that** I can ensure my client implementation is complete

**Scenario**: Developer connects to Everything server and systematically tests each tool, prompt, and resource type to validate client support.

### Use Case 2: Protocol Learning
**As a** developer learning MCP  
**I want to** see examples of all protocol features  
**So that** I can understand how to implement them

**Scenario**: Developer explores the server's tools and resources to understand MCP patterns and best practices.

### Use Case 3: Multi-Client Validation
**As a** QA engineer  
**I want to** test concurrent client connections  
**So that** I can validate session isolation

**Scenario**: Multiple clients connect simultaneously, each with independent subscriptions and logging configurations.

### Use Case 4: Transport Testing
**As a** transport implementer  
**I want to** test different transport mechanisms  
**So that** I can validate transport compatibility

**Scenario**: Developer tests the same server functionality across STDIO, SSE, and Streamable HTTP transports.

### Use Case 5: Resource Subscription Testing
**As a** client developer  
**I want to** test resource subscription notifications  
**So that** I can implement real-time updates

**Scenario**: Client subscribes to resources, enables updates via tool, and receives notification messages.

## Technical Requirements

### Implementation Details
- **Language**: TypeScript
- **SDK**: @modelcontextprotocol/sdk
- **Validation**: Zod schemas for input validation
- **Architecture**: Modular server factory pattern
- **Transports**: Separate entry points for STDIO, SSE, Streamable HTTP

### Dependencies
- Node.js runtime
- TypeScript compiler
- @modelcontextprotocol/sdk
- Zod for schema validation
- minimatch for path matching (where applicable)

### Constraints
- Server is not intended for production use
- Some tools require specific client capabilities (roots, sampling)
- Session-scoped resources are ephemeral
- Simulated logging and updates are opt-in features

### Security Considerations
- No authentication required (test server)
- Path validation for file operations
- Resource access controlled by URI patterns
- Session isolation for multi-client support

## Configuration and Deployment

### Build Process
```bash
npm run build
```
- Compiles TypeScript sources to `dist/` directory
- Copies `docs/` directory into `dist/` for instruction files
- CLI bin configured as `mcp-server-everything` → `dist/index.js`

### Installation
```bash
npx -y @modelcontextprotocol/server-everything
```

### Docker Deployment
```bash
docker run -i --rm mcp/everything
```

### Configuration Options
- No configuration required for basic operation
- Environment variables can be inspected via `get-env` tool
- Client capabilities determine available features

### Transport Configuration
- **STDIO**: Default transport for CLI usage
- **SSE**: Server-Sent Events transport
- **Streamable HTTP**: HTTP-based streaming transport

## Success Criteria

### Functional Requirements
- ✅ All 13 tools are implemented and functional
- ✅ All 4 prompts are implemented and functional
- ✅ All 4 resource types are implemented and accessible
- ✅ Resource subscriptions work with update notifications
- ✅ Simulated logging respects client log levels
- ✅ Progress notifications work for long-running operations
- ✅ Multi-client concurrent sessions are supported
- ✅ All three transport mechanisms are functional

### Quality Requirements
- ✅ Code follows TypeScript best practices
- ✅ Input validation using Zod schemas
- ✅ Comprehensive documentation in `docs/` directory
- ✅ Clear error messages and handling
- ✅ Session state properly isolated

### Performance Requirements
- Server starts quickly (< 1 second)
- Tool execution is responsive (< 100ms for simple tools)
- Resource generation is efficient
- No memory leaks in long-running sessions

## Out of Scope

### Explicitly Excluded
- Production-grade error handling and recovery
- Authentication and authorization
- Persistent data storage (except session resources)
- Performance optimization for high load
- Production deployment configurations
- Advanced security features
- Database or external service integrations
- Real-world business logic

### Limitations
- Not suitable for production use
- Simulated features (logging, updates) are for demonstration only
- No data persistence beyond session lifetime (for session resources)
- Limited error recovery mechanisms
- No rate limiting or throttling

## Future Considerations

While not in scope for the current implementation, potential enhancements could include:
- Additional tool examples demonstrating edge cases
- More complex resource generation patterns
- Advanced prompt completion scenarios
- Performance benchmarking tools
- Extended transport protocol support

