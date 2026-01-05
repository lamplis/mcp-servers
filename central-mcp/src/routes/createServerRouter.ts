import { Router } from "express";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import type { ServerFactoryResponse, ServerFactory } from "../types.js";

type SessionRecord = {
  transport: SSEServerTransport;
  cleanup: (sessionId?: string) => void;
};

type RouterOptions = {
  name: string;
  factory: ServerFactory;
  messagePath: string;
};

export function createServerRouter(options: RouterOptions) {
  const router = Router();
  const sessions = new Map<string, SessionRecord>();

  router.get("/sse", async (req, res) => {
    try {
      const result = await resolveFactory(options.factory);
      const transport = new SSEServerTransport(options.messagePath, res);

      sessions.set(transport.sessionId, {
        transport,
        cleanup: result.cleanup,
      });

      result.server.server.onclose = async () => {
        const sessionId = transport.sessionId;
        if (sessionId && sessions.has(sessionId)) {
          sessions.get(sessionId)?.cleanup(sessionId);
          sessions.delete(sessionId);
        }
      };

      await result.server.connect(transport);
      console.error(
        `[${options.name}] Client connected: ${transport.sessionId}`
      );
    } catch (error) {
      console.error(
        `[${options.name}] Failed to establish SSE connection`,
        error
      );
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message:
            error instanceof Error ? error.message : "Failed to connect server",
        },
        id: null,
      });
    }
  });

  // SSEServerTransport.handlePostMessage reads the raw request stream itself,
  // so we must NOT use express.json() middleware here
  router.post("/message", async (req, res): Promise<void> => {
    const sessionId = req.query.sessionId as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message: "Invalid or missing sessionId",
        },
        id: null,
      });
      return;
    }

    try {
      await sessions.get(sessionId)!.transport.handlePostMessage(req, res);
    } catch (error) {
      console.error(
        `[${options.name}] Failed to handle message for session ${sessionId}`,
        error
      );
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message:
              error instanceof Error ? error.message : "Failed to dispatch message",
          },
          id: null,
        });
      }
    }
  });

  return router;
}

async function resolveFactory(factory: ServerFactory): Promise<ServerFactoryResponse> {
  const result = factory();
  return result instanceof Promise ? result : result;
}

