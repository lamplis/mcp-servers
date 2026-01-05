# Product Requirements Document: Fetch MCP Server

## Executive Summary

The Fetch MCP Server provides web content fetching and conversion capabilities for Large Language Models (LLMs). It enables LLMs to retrieve and process content from web pages, converting HTML to markdown for efficient consumption. The server includes robots.txt compliance checking, content truncation with pagination support, and both tool-based and prompt-based access methods.

## Product Overview

### Purpose
Enable LLMs to access and process web content by fetching URLs and converting HTML to markdown format. The server provides a secure, controlled way for AI assistants to retrieve information from the internet while respecting website access policies.

### Target Users
- AI assistants and LLM applications requiring web content access
- Developers building AI-powered applications with web research capabilities
- Users who need to extract and process web content for analysis

### Value Proposition
- Simplified web content access for LLMs
- Automatic HTML to markdown conversion for better LLM consumption
- Robots.txt compliance for ethical web scraping
- Content pagination support for large pages
- Both autonomous (tool) and manual (prompt) access methods

## Goals and Objectives

### Primary Goals
1. Provide reliable web content fetching for LLMs
2. Convert HTML content to markdown format efficiently
3. Respect website robots.txt policies
4. Support content pagination for large pages
5. Enable both autonomous and user-initiated fetching

### Success Metrics
- Successfully fetches and converts web content to markdown
- Respects robots.txt restrictions when enabled
- Handles content truncation and pagination correctly
- Provides clear error messages for failed requests
- Supports proxy configuration for restricted networks

## Features and Capabilities

### Core Features
1. **URL Fetching** - Retrieve content from any accessible URL
2. **HTML to Markdown Conversion** - Automatic content simplification using readabilipy
3. **Robots.txt Compliance** - Automatic checking and enforcement of robots.txt rules
4. **Content Truncation** - Configurable maximum content length with pagination
5. **Raw Content Access** - Option to retrieve raw HTML without conversion
6. **Proxy Support** - Configurable proxy URL for network restrictions
7. **Custom User-Agent** - Configurable user-agent strings
8. **Dual Access Methods** - Both tool-based (autonomous) and prompt-based (manual) access

## Tools/API Reference

### Tools

#### `fetch`
- **Description**: Fetches a URL from the internet and extracts its contents as markdown
- **Input Parameters**:
  - `url` (string, required): URL to fetch (must be valid URL format)
  - `max_length` (integer, optional): Maximum number of characters to return (default: 5000, range: 1-999,999)
  - `start_index` (integer, optional): Start content from this character index (default: 0, minimum: 0)
    - Useful for pagination when previous fetch was truncated
  - `raw` (boolean, optional): Get raw HTML content without markdown conversion (default: false)
- **Output**: Text content with URL and extracted/raw content
- **Behavior**:
  - Automatically checks robots.txt when called via tool (autonomous mode)
  - Converts HTML to markdown unless `raw=true`
  - Truncates content to `max_length` starting from `start_index`
  - Provides continuation instructions if content is truncated
- **Error Handling**:
  - Returns error if robots.txt disallows access
  - Returns error if HTTP status code >= 400
  - Returns error if connection fails
  - Returns error if `start_index` exceeds content length

### Prompts

#### `fetch`
- **Description**: Fetch a URL and extract its contents as markdown (user-initiated)
- **Input Arguments**:
  - `url` (string, required): URL to fetch
- **Output**: Prompt result with fetched content
- **Behavior**:
  - Does NOT check robots.txt (user-initiated requests bypass robots.txt)
  - Uses different user-agent string to indicate user-specified request
  - Converts HTML to markdown automatically
  - Returns full content (no truncation in prompt mode)

## Use Cases and User Stories

### Use Case 1: Research and Information Gathering
**As an** AI assistant  
**I want to** fetch web content automatically  
**So that** I can provide up-to-date information to users

**Scenario**: User asks "What's the latest news about AI?" Assistant uses fetch tool to retrieve content from news websites, respecting robots.txt, and provides summarized information.

### Use Case 2: Content Analysis
**As a** developer building an AI research tool  
**I want to** fetch and analyze web content  
**So that** I can extract insights from multiple sources

**Scenario**: Application fetches multiple URLs, converts to markdown, and processes content for analysis. Uses pagination to handle large articles.

### Use Case 3: Manual Content Retrieval
**As a** user  
**I want to** manually trigger web content fetching  
**So that** I can bypass robots.txt restrictions when needed

**Scenario**: User explicitly requests content from a website. System uses fetch prompt which bypasses robots.txt checking.

### Use Case 4: Large Document Processing
**As an** AI assistant  
**I want to** fetch content in chunks  
**So that** I can process very long web pages

**Scenario**: Assistant fetches first 5000 characters, processes them, then continues with `start_index=5000` to get next chunk until entire page is processed.

### Use Case 5: Raw HTML Access
**As a** developer  
**I want to** access raw HTML content  
**So that** I can perform custom parsing

**Scenario**: Developer sets `raw=true` to get original HTML without markdown conversion for specialized processing.

## Technical Requirements

### Implementation Details
- **Language**: Python
- **SDK**: mcp (Python MCP SDK)
- **Key Libraries**:
  - `readabilipy`: HTML content extraction and simplification
  - `markdownify`: HTML to markdown conversion
  - `protego`: Robots.txt parsing and compliance checking
  - `httpx`: HTTP client for async requests
  - `pydantic`: Input validation and schema definition

### Dependencies
- Python 3.8+
- mcp Python SDK
- readabilipy
- markdownify
- protego
- httpx
- pydantic

### Configuration Options
- `--user-agent`: Custom user-agent string (default: ModelContextProtocol/1.0)
- `--ignore-robots-txt`: Disable robots.txt checking (default: false)
- `--proxy-url`: Proxy URL for network requests (optional)

### Constraints
- Maximum content length: 999,999 characters per request
- HTTP timeout: 30 seconds
- Follows redirects automatically
- Content type detection based on HTML presence or Content-Type header
- Robots.txt checking only applies to autonomous (tool) requests, not prompt requests

### Security Considerations
- ⚠️ **Security Warning**: Server can access local/internal IP addresses and may represent a security risk
- Robots.txt compliance helps respect website policies
- User-agent identification distinguishes autonomous vs manual requests
- Proxy support for network restrictions
- Input validation using Pydantic schemas
- Error handling prevents information leakage

## Configuration and Deployment

### Installation Methods

#### Using uv (Recommended)
```bash
uvx mcp-server-fetch
```

#### Using pip
```bash
pip install mcp-server-fetch
python -m mcp_server_fetch
```

#### Using Docker
```bash
docker run -i --rm mcp/fetch
```

### Configuration Examples

#### Basic Configuration (Claude Desktop)
```json
{
  "mcpServers": {
    "fetch": {
      "command": "uvx",
      "args": ["mcp-server-fetch"]
    }
  }
}
```

#### With Custom User-Agent
```json
{
  "mcpServers": {
    "fetch": {
      "command": "uvx",
      "args": ["mcp-server-fetch", "--user-agent=MyApp/1.0"]
    }
  }
}
```

#### Ignoring robots.txt
```json
{
  "mcpServers": {
    "fetch": {
      "command": "uvx",
      "args": ["mcp-server-fetch", "--ignore-robots-txt"]
    }
  }
}
```

#### With Proxy
```json
{
  "mcpServers": {
    "fetch": {
      "command": "uvx",
      "args": ["mcp-server-fetch", "--proxy-url=http://proxy.example.com:8080"]
    }
  }
}
```

### Windows Configuration
For Windows systems experiencing timeout issues, set encoding environment variable:
```json
{
  "mcpServers": {
    "fetch": {
      "command": "uvx",
      "args": ["mcp-server-fetch"],
      "env": {
        "PYTHONIOENCODING": "utf-8"
      }
    }
  }
}
```

## Success Criteria

### Functional Requirements
- ✅ Successfully fetches content from valid URLs
- ✅ Converts HTML to markdown format correctly
- ✅ Respects robots.txt when enabled
- ✅ Handles content truncation and pagination
- ✅ Provides clear error messages for failures
- ✅ Supports both tool and prompt access methods
- ✅ Handles various content types appropriately
- ✅ Follows HTTP redirects correctly

### Quality Requirements
- ✅ Input validation using Pydantic schemas
- ✅ Comprehensive error handling
- ✅ Clear error messages with actionable information
- ✅ Proper timeout handling (30 seconds)
- ✅ Content type detection works correctly
- ✅ Pagination instructions are clear and accurate

### Performance Requirements
- Fetch operation completes within timeout (30 seconds)
- Markdown conversion is efficient for typical web pages
- Robots.txt checking adds minimal overhead
- Memory usage is reasonable for large pages

## Out of Scope

### Explicitly Excluded
- JavaScript execution (no browser automation)
- Cookie/session management
- Authentication for protected content
- Rate limiting or request throttling
- Caching of fetched content
- Content filtering or sanitization beyond markdown conversion
- Image or media content extraction
- PDF or other document format conversion
- WebSocket or real-time content updates
- Content modification or editing capabilities

### Limitations
- Cannot execute JavaScript on pages
- No support for authenticated/protected content
- No built-in rate limiting (may need external throttling)
- Content is fetched once (no real-time updates)
- Large pages require multiple paginated requests
- No caching mechanism (each request is independent)

## Security and Privacy Considerations

### Security Risks
- **Local Network Access**: Server can access local/internal IP addresses
- **Information Disclosure**: Fetched content may contain sensitive information
- **Network Exposure**: Requests may expose internal network structure

### Mitigation Strategies
- Use proxy configuration for network restrictions
- Monitor and log fetch requests in production
- Implement additional access controls at network level
- Review robots.txt compliance to respect website policies
- Consider rate limiting for production deployments

### Privacy Considerations
- User-agent strings identify requests as MCP-based
- No automatic data retention, but content is processed by LLM
- Consider privacy implications of fetching user-specified URLs

## Future Considerations

Potential enhancements not in current scope:
- Content caching to reduce redundant requests
- Rate limiting and throttling mechanisms
- JavaScript execution support
- Cookie and session management
- Authentication support for protected content
- Content filtering and sanitization options
- Image and media extraction
- PDF and document format support
- Real-time content monitoring
- Batch URL fetching capabilities

