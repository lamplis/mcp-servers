#!/usr/bin/env node
/**
 * Simple HTTP server that exposes local embeddings via OpenAI-compatible API
 * Run with: node scripts/embeddings-http-server.js
 */

const express = require('express');
const { spawn } = require('child_process');

const app = express();
app.use(express.json());

const PORT = parseInt(process.env.EMBEDDINGS_HTTP_PORT || '3000', 10);
const HOST = process.env.EMBEDDINGS_HTTP_HOST || '127.0.0.1';
const MODEL_ID = process.env.MODEL_ID || 'Xenova/all-MiniLM-L6-v2';

console.error(`[embeddings-http] Starting server on http://${HOST}:${PORT}`);
console.error(`[embeddings-http] Model: ${MODEL_ID}`);

// Helper to call the MCP embeddings tool
async function getEmbeddings(texts) {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', 'src/local-embeddings/index.ts'], {
      cwd: __dirname + '/..',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`MCP call failed: ${stderr}`));
        return;
      }

      try {
        // Parse MCP response
        const lines = stdout.split('\n').filter(l => l.trim());
        for (const line of lines) {
          try {
            const msg = JSON.parse(line);
            if (msg.result && msg.result.embeddings) {
              resolve(msg.result.embeddings);
              return;
            }
          } catch (e) {
            // Skip non-JSON lines
          }
        }
        reject(new Error('No embeddings in response'));
      } catch (error) {
        reject(error);
      }
    });

    // Send MCP request
    const request = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'embeddings',
        arguments: {
          texts,
          model: MODEL_ID,
          normalize: true,
          pooling: 'mean',
        },
      },
    };

    child.stdin.write(JSON.stringify(request) + '\n');
    child.stdin.end();
  });
}

// OpenAI-compatible embeddings endpoint
app.post('/v1/embeddings', async (req, res) => {
  try {
    const { input, model } = req.body;

    if (!input) {
      return res.status(400).json({
        error: {
          message: 'Missing required parameter: input',
          type: 'invalid_request_error',
        },
      });
    }

    const texts = Array.isArray(input) ? input : [input];
    const embeddings = await getEmbeddings(texts);

    // OpenAI-compatible response format
    const response = {
      object: 'list',
      data: embeddings.map((embedding, index) => ({
        object: 'embedding',
        embedding,
        index,
      })),
      model: model || MODEL_ID,
      usage: {
        prompt_tokens: texts.reduce((sum, t) => sum + t.length, 0),
        total_tokens: texts.reduce((sum, t) => sum + t.length, 0),
      },
    };

    res.json(response);
  } catch (error) {
    console.error('[embeddings-http] Error:', error);
    res.status(500).json({
      error: {
        message: error.message || 'Internal server error',
        type: 'server_error',
      },
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    model: MODEL_ID,
    dimension: 384,
  });
});

// Model info endpoint
app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: [
      {
        id: MODEL_ID,
        object: 'model',
        created: Date.now(),
        owned_by: 'local',
        permission: [],
        root: MODEL_ID,
        parent: null,
      },
    ],
  });
});

// Start server
app.listen(PORT, HOST, () => {
  console.error(`[embeddings-http] Server ready at http://${HOST}:${PORT}`);
  console.error(`[embeddings-http] Endpoint: http://${HOST}:${PORT}/v1/embeddings`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.error('[embeddings-http] Shutting down...');
  process.exit(0);
});
