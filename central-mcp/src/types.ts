import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export type ServerFactoryResponse = {
  server: McpServer;
  cleanup: (sessionId?: string) => void;
};

export type ServerFactory =
  | (() => Promise<ServerFactoryResponse>)
  | (() => ServerFactoryResponse);

