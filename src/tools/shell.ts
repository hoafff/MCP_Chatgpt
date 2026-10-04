import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { Policy } from '../types.js';
import { resolveAllowedDirectory } from '../path-policy.js';
import { runCommand } from '../command.js';
import { ProcessManager } from '../process-manager.js';
import { AuditLogger, audited } from '../audit.js';
import { errorResult, textResult } from './helpers.js';

export function registerShellTools(server: McpServer, policy: Policy, audit: AuditLogger, processes: ProcessManager): void {
  server.registerTool(
    'shell_exec',
    {
      title: 'Execute PowerShell command',
      description: 'Execute a command in the configured shell. IMPORTANT: shell commands inherit the OS permissions of the MCP process; allowedRoots only constrains the starting cwd, not every path a command may access.',
      inputSchema: z.object({
        command: z.string().min(1),
        cwd: z.string().min(1),
        timeoutMs: z.number().int().positive().optional()
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
    },
    async ({ command, cwd, timeoutMs }) => {
      try {
        const details = { cwd, ...(policy.audit.logCommands ? { command } : { command: '[redacted]' }), timeoutMs };
        return await audited(audit, 'shell_exec', details, async () => {
          const safeCwd = await resolveAllowedDirectory(cwd, policy);
          const result = await runCommand(command, safeCwd, policy, { timeoutMs });
          return textResult(result);
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'process_start',
    {
      title: 'Start background process',
      description: 'Start a long-running command and return a process id for later polling.',
      inputSchema: z.object({ command: z.string().min(1), cwd: z.string().min(1) }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
    },
    async ({ command, cwd }) => {
      try {
        const details = { cwd, ...(policy.audit.logCommands ? { command } : { command: '[redacted]' }) };
        return await audited(audit, 'process_start', details, async () => {
          const safeCwd = await resolveAllowedDirectory(cwd, policy);
          const id = processes.start(command, safeCwd);
          return textResult({ id, ...processes.status(id) });
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'process_status',
    {
      title: 'Process status',
      description: 'Read status and captured output for a managed process.',
      inputSchema: z.object({ id: z.string().uuid() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    },
    async ({ id }) => {
      try {
        return await audited(audit, 'process_status', { id }, async () => textResult(processes.status(id)));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'process_list',
    {
      title: 'List managed processes',
      description: 'List processes started through this MCP server.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    },
    async () => {
      try {
        return await audited(audit, 'process_list', {}, async () => textResult(processes.list()));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'process_stop',
    {
      title: 'Stop managed process',
      description: 'Terminate a process that was started through process_start.',
      inputSchema: z.object({ id: z.string().uuid() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
    },
    async ({ id }) => {
      try {
        return await audited(audit, 'process_stop', { id }, async () => textResult({ id, signalled: processes.stop(id) }));
      } catch (error) {
        return errorResult(error);
      }
    }
  );
}
