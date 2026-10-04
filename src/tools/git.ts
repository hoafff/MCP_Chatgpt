import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { Policy } from '../types.js';
import { resolveAllowedDirectory } from '../path-policy.js';
import { runCommand } from '../command.js';
import { AuditLogger, audited } from '../audit.js';
import { errorResult, textResult } from './helpers.js';

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function git(command: string, cwd: string, policy: Policy) {
  return await runCommand(`git ${command}`, cwd, policy, { maxOutputBytes: policy.git.maxOutputBytes });
}

export function registerGitTools(server: McpServer, policy: Policy, audit: AuditLogger): void {
  server.registerTool(
    'git_status',
    {
      title: 'Git status',
      description: 'Run git status --short --branch in an allowed repository.',
      inputSchema: z.object({ cwd: z.string().min(1) }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    },
    async ({ cwd }) => {
      try {
        return await audited(audit, 'git_status', { cwd }, async () => {
          const dir = await resolveAllowedDirectory(cwd, policy);
          return textResult(await git('status --short --branch', dir, policy));
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'git_diff',
    {
      title: 'Git diff',
      description: 'Show working-tree or staged diff for an allowed repository.',
      inputSchema: z.object({ cwd: z.string().min(1), staged: z.boolean().default(false), path: z.string().optional() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    },
    async ({ cwd, staged, path }) => {
      try {
        return await audited(audit, 'git_diff', { cwd, staged, path }, async () => {
          const dir = await resolveAllowedDirectory(cwd, policy);
          const pathArg = path ? ` -- ${psQuote(path)}` : '';
          return textResult(await git(`diff${staged ? ' --cached' : ''}${pathArg}`, dir, policy));
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'git_log',
    {
      title: 'Git log',
      description: 'Show recent commits in an allowed repository.',
      inputSchema: z.object({ cwd: z.string().min(1), maxCount: z.number().int().positive().max(100).default(20) }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    },
    async ({ cwd, maxCount }) => {
      try {
        return await audited(audit, 'git_log', { cwd, maxCount }, async () => {
          const dir = await resolveAllowedDirectory(cwd, policy);
          return textResult(await git(`log -n ${maxCount} --date=iso --pretty=format:%h%x09%ad%x09%an%x09%s`, dir, policy));
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'git_show',
    {
      title: 'Git show',
      description: 'Show a commit/object, optionally limited to a repository-relative path.',
      inputSchema: z.object({ cwd: z.string().min(1), ref: z.string().min(1).default('HEAD'), path: z.string().optional() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    },
    async ({ cwd, ref, path }) => {
      try {
        return await audited(audit, 'git_show', { cwd, ref, path }, async () => {
          const dir = await resolveAllowedDirectory(cwd, policy);
          const command = path ? `show ${psQuote(`${ref}:${path}`)}` : `show --stat --oneline ${psQuote(ref)}`;
          return textResult(await git(command, dir, policy));
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'git_commit',
    {
      title: 'Git commit',
      description: 'Commit already-staged changes. Disabled unless git.allowCommit=true in policy.',
      inputSchema: z.object({ cwd: z.string().min(1), message: z.string().min(1).max(500) }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
    },
    async ({ cwd, message }) => {
      try {
        return await audited(audit, 'git_commit', { cwd, message }, async () => {
          if (!policy.git.allowCommit) throw new Error('git_commit is disabled. Set git.allowCommit=true in policy.json to enable it.');
          const dir = await resolveAllowedDirectory(cwd, policy);
          return textResult(await git(`commit -m ${psQuote(message)}`, dir, policy));
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'git_push',
    {
      title: 'Git push',
      description: 'Push the current branch or an explicit remote/refspec. Disabled unless git.allowPush=true in policy.',
      inputSchema: z.object({
        cwd: z.string().min(1),
        remote: z.string().min(1).default('origin'),
        refspec: z.string().optional()
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
    },
    async ({ cwd, remote, refspec }) => {
      try {
        return await audited(audit, 'git_push', { cwd, remote, refspec }, async () => {
          if (!policy.git.allowPush) throw new Error('git_push is disabled. Set git.allowPush=true in policy.json to enable it.');
          const dir = await resolveAllowedDirectory(cwd, policy);
          const tail = refspec ? ` ${psQuote(refspec)}` : '';
          return textResult(await git(`push ${psQuote(remote)}${tail}`, dir, policy));
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );
}
