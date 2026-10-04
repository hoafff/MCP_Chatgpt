import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod/v4';
import type { Policy } from './types.js';

const policySchema = z.object({
  allowedRoots: z.array(z.string().min(1)).min(1),
  protectedPaths: z.array(z.string().min(1)).default([]),
  filesystem: z.object({
    maxReadBytes: z.number().int().positive().default(2 * 1024 * 1024),
    maxWriteBytes: z.number().int().positive().default(4 * 1024 * 1024),
    searchMaxFileBytes: z.number().int().positive().default(2 * 1024 * 1024),
    searchSkipDirectories: z.array(z.string()).default(['.git', 'node_modules', 'dist', 'build', '.venv', 'venv'])
  }),
  shell: z.object({
    enabled: z.boolean().default(false),
    executable: z.string().min(1).default(process.platform === 'win32' ? 'powershell.exe' : '/bin/sh'),
    defaultTimeoutMs: z.number().int().positive().default(120_000),
    maxTimeoutMs: z.number().int().positive().default(600_000),
    maxOutputBytes: z.number().int().positive().default(1024 * 1024),
    blockedPatterns: z.array(z.string()).default([])
  }),
  git: z.object({
    allowCommit: z.boolean().default(false),
    allowPush: z.boolean().default(false),
    maxOutputBytes: z.number().int().positive().default(1024 * 1024)
  }),
  audit: z.object({
    enabled: z.boolean().default(true),
    directory: z.string().min(1).default('logs'),
    logCommands: z.boolean().default(true)
  })
});

export async function loadPolicy(): Promise<Policy> {
  const requested = process.env.MCP_POLICY_PATH?.trim();
  const candidates = requested
    ? [path.resolve(requested)]
    : [path.resolve('config/policy.json')];

  let selected: string | undefined;
  for (const candidate of candidates) {
    try {
      await access(candidate);
      selected = candidate;
      break;
    } catch {
      // try next candidate
    }
  }

  if (!selected) {
    throw new Error(`No policy file found. Checked: ${candidates.join(', ')}`);
  }

  const raw = JSON.parse(await readFile(selected, 'utf8')) as unknown;
  const parsed = policySchema.parse(raw);

  return {
    ...parsed,
    allowedRoots: parsed.allowedRoots.map((root) => path.resolve(root)),
    protectedPaths: parsed.protectedPaths.map((p) => path.resolve(p)),
    audit: {
      ...parsed.audit,
      directory: path.resolve(parsed.audit.directory)
    }
  };
}
