## Central MCP Web Server

The `central-mcp` package hosts an Express.js gateway that exposes the local MCP reference servers over HTTP using the SSE transport. It lets tools like Cursor register a single HTTP endpoint (`/memory`, `/filesystem`, `/everything`, `/sequentialthinking`) instead of running each server separately over STDIO.

### Features
- Shared Express host with permissive CORS (dev-friendly)
- Dedicated routes per MCP server with `GET /sse` and `POST /message` transports
- Health endpoint (`GET /health`)
- Optional filesystem allow-list via `FILESYSTEM_ALLOWED_DIRS`
- Graceful session cleanup per client

### Prerequisites
- Windows 11 user-space (no admin rights)
- Node.js 20 (already available in the environment)
- Git + npm access to the repo (no external registries required)

### Install & Run
```powershell
cd C:\DEVHOME\GITHUB\mcp-servers\central-mcp
npm install          # uses workspace-local dependencies
npm run dev          # starts the server with tsx (hot reload)
# or
npm start            # runs the compiled dist build (after npm run build)
```

By default the server listens on `http://localhost:3300`.

### Environment Variables
| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3300` | TCP port for the Express server |
| `FILESYSTEM_ALLOWED_DIRS` | *(empty)* | Optional list of directories (separated by Windows `;`) that the filesystem MCP server may access before roots are provided. Example: `C:\DEVHOME\Projects;C:\Temp\shared` |

Example (PowerShell):
```powershell
$env:PORT = 3400
$env:FILESYSTEM_ALLOWED_DIRS = "C:\DEVHOME\Projects;C:\Work\\scratch"
npm run dev
```

### Route Summary
| Server | Base Path | Notes |
| --- | --- | --- |
| Memory | `/memory` | Knowledge-graph memory server |
| Filesystem | `/filesystem` | Secure filesystem tools; respects `FILESYSTEM_ALLOWED_DIRS` before roots |
| Everything | `/everything` | Reference server exercising all MCP features |
| Sequential Thinking | `/sequentialthinking` | Thought-by-thought reasoning helper |

Each base path exposes:
- `GET {base}/sse` — establishes the SSE stream
- `POST {base}/message?sessionId=...` — forwards JSON-RPC messages

### Cursor Integration
Add entries to `.cursor/mcp.json` (inside the workspace) pointing at each base path using the SSE transport:
```jsonc
{
  "mcpServers": {
    "central-memory": {
      "type": "sse",
      "url": "http://localhost:3300/memory"
    },
    "central-filesystem": {
      "type": "sse",
      "url": "http://localhost:3300/filesystem"
    },
    "central-everything": {
      "type": "sse",
      "url": "http://localhost:3300/everything"
    },
    "central-sequentialthinking": {
      "type": "sse",
      "url": "http://localhost:3300/sequentialthinking"
    }
  }
}
```
Cursor (and other MCP clients) will automatically call `/sse` and `/message` under each base path.

### Notes
- When `FILESYSTEM_ALLOWED_DIRS` is unset, the filesystem server boots without access and waits for MCP roots to be provided by the client.
- All logging goes to stderr so you can see connection activity in the terminal running `central-mcp`.
- This project intentionally avoids Docker/WSL and works entirely in user-space PowerShell shells, following the workstation constraints.

