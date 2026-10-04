import { createServer } from 'node:http';
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { loadPolicy } from './config.js';
import { AuditLogger } from './audit.js';
import { ProcessManager } from './process-manager.js';
import { createLocalServer } from './server.js';
import { handleBrowserBridge } from './browser-bridge.js';

const policy = await loadPolicy();
const audit = new AuditLogger(policy);
const processes = new ProcessManager(policy);
const factory = () => createLocalServer(policy, audit, processes);
const useStdio = process.argv.includes('--stdio');

if (useStdio) {
  const handle = serveStdio(factory);
  console.error('[mcp-chatgpt-local] listening on stdio');
  process.on('SIGINT', () => void handle.close());
  process.on('SIGTERM', () => void handle.close());
} else {
  const port = Number.parseInt(process.env.MCP_PORT ?? '8787', 10);
  const host = '127.0.0.1';
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid MCP_PORT: ${process.env.MCP_PORT}`);

  const handler = createMcpHandler(factory);
  const nodeHandler = toNodeHandler(handler);
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();

  const http = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${host}:${port}`}`);
    if (!validateHost(req, res)) return;

    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, name: 'mcp-chatgpt-local', version: '0.1.0' }));
      return;
    }

    if (url.pathname.startsWith('/bridge/')) {
      void handleBrowserBridge(req, res, url, policy, audit);
      return;
    }

    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    if (!validateOrigin(req, res)) return;
    void nodeHandler(req, res);
  });

  http.listen(port, host, () => {
    console.error(`[mcp-chatgpt-local] MCP endpoint: http://${host}:${port}/mcp`);
    console.error(`[mcp-chatgpt-local] Browser bridge: http://${host}:${port}/bridge/health (read-only)`);
    console.error(`[mcp-chatgpt-local] Health check: http://${host}:${port}/health`);
  });

  const shutdown = async () => {
    await handler.close();
    http.close(() => process.exit(0));
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}
