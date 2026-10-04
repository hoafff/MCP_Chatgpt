import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { Policy } from './types.js';
import { AuditLogger } from './audit.js';
import { ProcessManager } from './process-manager.js';
import { registerFilesystemTools } from './tools/filesystem.js';
import { registerShellTools } from './tools/shell.js';
import { registerGitTools } from './tools/git.js';
import { textResult } from './tools/helpers.js';

export function createLocalServer(policy: Policy, audit: AuditLogger, processes: ProcessManager): McpServer {
  const server = new McpServer(
    { name: 'mcp-chatgpt-local', version: '0.1.0' },
    { capabilities: { tools: {} }, maxToolInputElements: 20_000 }
  );

  server.registerTool(
    'local_capabilities',
    {
      title: 'Local MCP capabilities',
      description: 'Show the local MCP configuration and security-relevant capability flags without exposing secrets.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    },
    async () =>
      textResult({
        name: 'mcp-chatgpt-local',
        version: '0.1.0',
        platform: process.platform,
        node: process.version,
        allowedRoots: policy.allowedRoots,
        protectedPaths: policy.protectedPaths,
        shell: {
          enabled: policy.shell.enabled,
          executable: policy.shell.executable,
          warning: 'Shell commands inherit the OS permissions of this process; allowedRoots is not a complete shell sandbox.'
        },
        git: { allowCommit: policy.git.allowCommit, allowPush: policy.git.allowPush },
        audit: { enabled: policy.audit.enabled, directory: policy.audit.directory }
      })
  );

  registerFilesystemTools(server, policy, audit);
  registerShellTools(server, policy, audit, processes);
  registerGitTools(server, policy, audit);
  return server;
}
