import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { Policy } from './types.js';

function normalizedForCompare(value: string): string {
  const normalized = path.resolve(value).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isInside(candidate: string, root: string): boolean {
  const c = normalizedForCompare(candidate);
  const r = normalizedForCompare(root);
  return c === r || c.startsWith(`${r}${path.sep}`);
}

function ensureNotProtected(candidate: string, policy: Policy): void {
  for (const protectedPath of policy.protectedPaths) {
    if (isInside(candidate, protectedPath)) {
      throw new Error(`Access denied by protectedPaths policy: ${candidate}`);
    }
  }
}

async function exists(value: string): Promise<boolean> {
  try {
    await lstat(value);
    return true;
  } catch {
    return false;
  }
}

async function nearestExistingAncestor(value: string): Promise<string> {
  let current = path.resolve(value);
  while (!(await exists(current))) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

export async function resolveAllowedPath(input: string, policy: Policy, options?: { mustExist?: boolean }): Promise<string> {
  if (!input?.trim()) throw new Error('Path is required.');
  const candidate = path.resolve(input);

  const lexicalRoot = policy.allowedRoots.find((root) => isInside(candidate, root));
  if (!lexicalRoot) {
    throw new Error(`Path is outside allowedRoots: ${candidate}`);
  }
  ensureNotProtected(candidate, policy);

  if (options?.mustExist && !(await exists(candidate))) {
    throw new Error(`Path does not exist: ${candidate}`);
  }

  const ancestor = await nearestExistingAncestor(candidate);
  const realAncestor = await realpath(ancestor);
  const realRoots: string[] = [];
  for (const root of policy.allowedRoots) {
    if (await exists(root)) realRoots.push(await realpath(root));
  }

  if (!realRoots.some((root) => isInside(realAncestor, root))) {
    throw new Error(`Path escapes allowedRoots through a symlink/junction: ${candidate}`);
  }
  ensureNotProtected(realAncestor, policy);

  return candidate;
}

export async function resolveAllowedDirectory(input: string, policy: Policy): Promise<string> {
  const candidate = await resolveAllowedPath(input, policy, { mustExist: true });
  const stat = await lstat(candidate);
  if (!stat.isDirectory()) throw new Error(`Not a directory: ${candidate}`);
  return candidate;
}
