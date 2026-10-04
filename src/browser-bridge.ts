import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { Policy } from './types.js';
import { resolveAllowedDirectory, resolveAllowedPath } from './path-policy.js';
import { AuditLogger, audited } from './audit.js';

const BRIDGE_CLIENT_HEADER = 'x-local-bridge-client';
const BRIDGE_CLIENT_VALUE = 'mcp-chatgpt-extension-v1';
const MAX_BODY_BYTES = 256 * 1024;

type BridgeCall =
  | { action: 'list_directory'; path: string }
  | { action: 'read_file'; path: string; startLine?: number; endLine?: number; maxBytes?: number }
  | { action: 'file_info'; path: string }
  | {
      action: 'search_text';
      root: string;
      query: string;
      useRegex?: boolean;
      caseSensitive?: boolean;
      maxResults?: number;
    };

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(JSON.stringify(body));
}

function requireBridgeClient(req: IncomingMessage): void {
  if (req.headers[BRIDGE_CLIENT_HEADER] !== BRIDGE_CLIENT_VALUE) {
    throw new Error('Bridge client header is missing or invalid.');
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_BODY_BYTES) throw new Error(`Bridge request exceeds ${MAX_BODY_BYTES} bytes.`);
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) throw new Error('Bridge request body is required.');
  return JSON.parse(raw) as unknown;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required.`);
  return value;
}

function optionalPositiveInt(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || Number(value) <= 0) throw new Error(`${name} must be a positive integer.`);
  return Number(value);
}

function parseCall(input: unknown): BridgeCall {
  if (!input || typeof input !== 'object') throw new Error('Bridge call must be a JSON object.');
  const obj = input as Record<string, unknown>;
  const action = requireString(obj.action, 'action');

  if (action === 'list_directory') {
    return { action, path: requireString(obj.path, 'path') };
  }

  if (action === 'read_file') {
    return {
      action,
      path: requireString(obj.path, 'path'),
      startLine: optionalPositiveInt(obj.startLine, 'startLine'),
      endLine: optionalPositiveInt(obj.endLine, 'endLine'),
      maxBytes: optionalPositiveInt(obj.maxBytes, 'maxBytes')
    };
  }

  if (action === 'file_info') {
    return { action, path: requireString(obj.path, 'path') };
  }

  if (action === 'search_text') {
    const maxResults = obj.maxResults === undefined ? 50 : optionalPositiveInt(obj.maxResults, 'maxResults');
    if (maxResults !== undefined && maxResults > 200) throw new Error('maxResults must be <= 200.');
    return {
      action,
      root: requireString(obj.root, 'root'),
      query: requireString(obj.query, 'query'),
      useRegex: obj.useRegex === true,
      caseSensitive: obj.caseSensitive === true,
      maxResults
    };
  }

  throw new Error(`Unsupported read-only bridge action: ${action}`);
}

async function walkFiles(
  root: string,
  policy: Policy,
  visitor: (file: string) => Promise<boolean | void>
): Promise<void> {
  const stack = [root];
  const skip = new Set(policy.filesystem.searchSkipDirectories.map((name) => name.toLowerCase()));

  while (stack.length) {
    const current = stack.pop()!;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.isDirectory() && skip.has(entry.name.toLowerCase())) continue;
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        const stop = await visitor(full);
        if (stop) return;
      }
    }
  }
}

async function executeReadOnlyCall(call: BridgeCall, policy: Policy, audit: AuditLogger): Promise<unknown> {
  switch (call.action) {
    case 'list_directory':
      return audited(audit, 'bridge_list_directory', { path: call.path }, async () => {
        const dir = await resolveAllowedDirectory(call.path, policy);
        const entries = await readdir(dir, { withFileTypes: true });
        return {
          path: dir,
          entries: entries.map((entry) => ({
            name: entry.name,
            type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : 'other'
          }))
        };
      });

    case 'read_file':
      return audited(
        audit,
        'bridge_read_file',
        { path: call.path, startLine: call.startLine, endLine: call.endLine },
        async () => {
          const file = await resolveAllowedPath(call.path, policy, { mustExist: true });
          const info = await stat(file);
          if (!info.isFile()) throw new Error(`Not a file: ${file}`);
          const limit = Math.min(call.maxBytes ?? policy.filesystem.maxReadBytes, policy.filesystem.maxReadBytes);
          if (info.size > limit) {
            throw new Error(
              `File is ${info.size} bytes; read limit is ${limit}. Narrow the target or request a smaller file.`
            );
          }
          const content = await readFile(file, 'utf8');
          const lines = content.split(/\r?\n/);
          const from = call.startLine ?? 1;
          const to = Math.min(call.endLine ?? lines.length, lines.length);
          if (to < from) throw new Error('endLine must be greater than or equal to startLine.');
          return {
            path: file,
            startLine: from,
            endLine: to,
            totalLines: lines.length,
            text: lines.slice(from - 1, to).join('\n')
          };
        }
      );

    case 'file_info':
      return audited(audit, 'bridge_file_info', { path: call.path }, async () => {
        const target = await resolveAllowedPath(call.path, policy, { mustExist: true });
        const info = await lstat(target);
        return {
          path: target,
          type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : info.isSymbolicLink() ? 'symlink' : 'other',
          size: info.size,
          modifiedAt: info.mtime.toISOString(),
          createdAt: info.birthtime.toISOString()
        };
      });

    case 'search_text':
      return audited(
        audit,
        'bridge_search_text',
        {
          root: call.root,
          query: call.query,
          useRegex: call.useRegex,
          caseSensitive: call.caseSensitive,
          maxResults: call.maxResults
        },
        async () => {
          const root = await resolveAllowedDirectory(call.root, policy);
          const results: Array<{ path: string; line: number; text: string }> = [];
          const regex = call.useRegex ? new RegExp(call.query, call.caseSensitive ? '' : 'i') : undefined;
          const needle = call.caseSensitive ? call.query : call.query.toLowerCase();
          const maxResults = call.maxResults ?? 50;

          await walkFiles(root, policy, async (file) => {
            const info = await stat(file);
            if (info.size > policy.filesystem.searchMaxFileBytes) return;
            let content: string;
            try {
              content = await readFile(file, 'utf8');
            } catch {
              return;
            }
            if (content.includes('\u0000')) return;
            const lines = content.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
              const line = lines[i]!;
              const hit = regex
                ? regex.test(line)
                : (call.caseSensitive ? line : line.toLowerCase()).includes(needle);
              if (hit) results.push({ path: file, line: i + 1, text: line.slice(0, 500) });
              if (results.length >= maxResults) return true;
            }
          });

          return { root, count: results.length, results };
        }
      );
  }
}

export async function handleBrowserBridge(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  policy: Policy,
  audit: AuditLogger
): Promise<boolean> {
  if (!url.pathname.startsWith('/bridge/')) return false;

  try {
    requireBridgeClient(req);

    if (req.method === 'GET' && url.pathname === '/bridge/health') {
      json(res, 200, {
        ok: true,
        mode: 'read-only',
        name: 'mcp-chatgpt-local-browser-bridge',
        version: '0.1.0'
      });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/bridge/tools') {
      json(res, 200, {
        ok: true,
        mode: 'read-only',
        tools: [
          {
            name: 'list_directory',
            description: 'List files and folders inside an allowed directory.',
            args: { path: 'string' }
          },
          {
            name: 'read_file',
            description: 'Read a UTF-8 text file inside allowedRoots. Optional line range is supported.',
            args: { path: 'string', startLine: 'positive integer?', endLine: 'positive integer?', maxBytes: 'positive integer?' }
          },
          {
            name: 'file_info',
            description: 'Get metadata for an allowed local file or directory.',
            args: { path: 'string' }
          },
          {
            name: 'search_text',
            description: 'Search text recursively under an allowed directory.',
            args: {
              root: 'string',
              query: 'string',
              useRegex: 'boolean?',
              caseSensitive: 'boolean?',
              maxResults: 'positive integer <= 200?'
            }
          }
        ]
      });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/bridge/call') {
      const call = parseCall(await readJsonBody(req));
      const result = await executeReadOnlyCall(call, policy, audit);
      json(res, 200, { ok: true, action: call.action, result });
      return true;
    }

    json(res, 404, { ok: false, error: 'bridge_not_found' });
    return true;
  } catch (error) {
    json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    return true;
  }
}

export const browserBridgeClientHeader = {
  name: BRIDGE_CLIENT_HEADER,
  value: BRIDGE_CLIENT_VALUE
};
