import path from 'node:path';

const endpoint = process.env.MCP_SELF_TEST_URL ?? 'http://127.0.0.1:8787/mcp';
const healthUrl = new URL('/health', endpoint).toString();
const root = path.resolve(process.env.MCP_SELF_TEST_ROOT ?? process.cwd());
const protocolVersion = '2025-11-25';

type JsonRpcResponse = {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

type ToolResult = {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
};

let nextId = 1;
let passed = 0;
let failed = 0;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function parseSse(text: string): JsonRpcResponse[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)) as JsonRpcResponse);
}

async function rpc(method: string, params: Record<string, unknown>, options?: { initialize?: boolean }): Promise<unknown> {
  const id = nextId++;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream'
  };
  if (!options?.initialize) headers['mcp-protocol-version'] = protocolVersion;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
  });

  const raw = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}: ${raw}`);

  const contentType = response.headers.get('content-type') ?? '';
  let message: JsonRpcResponse | undefined;
  if (contentType.includes('text/event-stream')) {
    message = parseSse(raw).find((item) => item.id === id);
  } else if (raw.trim()) {
    const parsed = JSON.parse(raw) as JsonRpcResponse | JsonRpcResponse[];
    message = Array.isArray(parsed) ? parsed.find((item) => item.id === id) : parsed;
  }

  assert(message, `No JSON-RPC response for ${method}`);
  if (message.error) throw new Error(`JSON-RPC ${method} failed: ${message.error.message ?? JSON.stringify(message.error)}`);
  return message.result;
}

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return (await rpc('tools/call', { name, arguments: args })) as ToolResult;
}

function textPayload(result: ToolResult): unknown {
  const text = result.content?.find((item) => item.type === 'text')?.text;
  assert(text !== undefined, 'Tool result did not contain a text block.');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`PASS ${String(passed + failed).padStart(2, '0')}  ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${String(passed + failed).padStart(2, '0')}  ${name}`);
    console.error(error instanceof Error ? error.message : String(error));
  }
}

async function waitForProcess(id: string, timeoutMs = 15_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let latest: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    const result = await callTool('process_status', { id });
    assert(!result.isError, `process_status returned isError: ${JSON.stringify(result)}`);
    latest = textPayload(result) as Record<string, unknown>;
    if (latest.running === false) return latest;
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  throw new Error(`Process ${id} did not finish within ${timeoutMs}ms. Last status: ${JSON.stringify(latest)}`);
}

const scratchFile = path.join(root, 'logs', `self-test-${process.pid}.txt`);
const scratchContent = `mcp-self-test-${new Date().toISOString()}`;

console.log('MCP local self-test');
console.log(`Endpoint: ${endpoint}`);
console.log(`Root:     ${root}`);
console.log('');

await check('health endpoint', async () => {
  const response = await fetch(healthUrl);
  assert(response.ok, `Health HTTP status was ${response.status}`);
  const body = (await response.json()) as Record<string, unknown>;
  assert(body.ok === true, `Health body was not ok:true: ${JSON.stringify(body)}`);
});

await check('MCP initialize', async () => {
  const result = (await rpc(
    'initialize',
    {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: 'mcp-chatgpt-self-test', version: '0.1.0' }
    },
    { initialize: true }
  )) as Record<string, unknown>;
  const serverInfo = result.serverInfo as Record<string, unknown> | undefined;
  assert(serverInfo?.name === 'mcp-chatgpt-local', `Unexpected serverInfo: ${JSON.stringify(serverInfo)}`);
});

await check('tools/list exposes core tools', async () => {
  const result = (await rpc('tools/list', {})) as { tools?: Array<{ name?: string }> };
  const names = new Set(result.tools?.map((tool) => tool.name) ?? []);
  const required = ['fs_read_file', 'fs_write_file', 'shell_exec', 'process_start', 'process_status', 'git_status', 'git_commit'];
  const missing = required.filter((name) => !names.has(name));
  assert(missing.length === 0, `Missing tools: ${missing.join(', ')}`);
});

await check('filesystem read', async () => {
  const result = await callTool('fs_read_file', { path: path.join(root, 'README.md') });
  assert(!result.isError, `fs_read_file returned isError: ${JSON.stringify(result)}`);
  const payload = textPayload(result) as Record<string, unknown>;
  assert(String(payload.text ?? '').includes('# MCP_Chatgpt'), 'README content marker was not found.');
});

await check('filesystem write', async () => {
  const result = await callTool('fs_write_file', { path: scratchFile, content: scratchContent });
  assert(!result.isError, `fs_write_file returned isError: ${JSON.stringify(result)}`);
  const verify = await callTool('fs_read_file', { path: scratchFile });
  const payload = textPayload(verify) as Record<string, unknown>;
  assert(payload.text === scratchContent, `Scratch content mismatch: ${JSON.stringify(payload)}`);
});

await check('allowedRoots rejects outside read', async () => {
  const outside = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/hosts';
  const result = await callTool('fs_read_file', { path: outside });
  assert(result.isError === true, 'Outside-root read unexpectedly succeeded.');
  const message = String(result.content?.[0]?.text ?? '');
  assert(/outside allowedRoots/i.test(message), `Unexpected rejection: ${message}`);
});

await check('shell_exec', async () => {
  const result = await callTool('shell_exec', { command: 'git status --short', cwd: root });
  assert(!result.isError, `shell_exec returned isError: ${JSON.stringify(result)}`);
  const payload = textPayload(result) as Record<string, unknown>;
  assert(payload.exitCode === 0, `shell_exec exitCode was ${String(payload.exitCode)}`);
});

await check('background process lifecycle', async () => {
  const command = process.platform === 'win32' ? 'ping 127.0.0.1 -n 3' : 'ping -c 3 127.0.0.1';
  const started = await callTool('process_start', { command, cwd: root });
  assert(!started.isError, `process_start returned isError: ${JSON.stringify(started)}`);
  const startPayload = textPayload(started) as Record<string, unknown>;
  const id = String(startPayload.id ?? '');
  assert(id.length > 0, 'process_start did not return an id.');
  const finalStatus = await waitForProcess(id);
  assert(finalStatus.running === false, 'Process still reports running=true.');
  assert(finalStatus.exitCode === 0, `Process exitCode was ${String(finalStatus.exitCode)}`);
  assert(String(finalStatus.stdout ?? '').length > 0, 'Process stdout was empty.');
});

await check('git_status', async () => {
  const result = await callTool('git_status', { cwd: root });
  assert(!result.isError, `git_status returned isError: ${JSON.stringify(result)}`);
  const payload = textPayload(result) as Record<string, unknown>;
  assert(payload.exitCode === 0, `git_status exitCode was ${String(payload.exitCode)}`);
});

await check('git commit policy gate', async () => {
  const result = await callTool('git_commit', { cwd: root, message: 'SELF_TEST_SHOULD_NOT_COMMIT' });
  assert(result.isError === true, 'git_commit unexpectedly succeeded; self-test expects allowCommit=false.');
  const message = String(result.content?.[0]?.text ?? '');
  assert(/disabled/i.test(message), `Unexpected git_commit rejection: ${message}`);
});

try {
  const cleanup = await callTool('fs_delete_path', { path: scratchFile, recursive: false });
  if (cleanup.isError) console.warn(`WARN cleanup failed: ${JSON.stringify(cleanup)}`);
} catch (error) {
  console.warn(`WARN cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
}

console.log('');
console.log(`RESULT: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
