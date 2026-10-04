import { copyFile, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { Policy } from '../types.js';
import { resolveAllowedDirectory, resolveAllowedPath } from '../path-policy.js';
import { AuditLogger, audited } from '../audit.js';
import { errorResult, textResult } from './helpers.js';

function countBytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
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

export function registerFilesystemTools(server: McpServer, policy: Policy, audit: AuditLogger): void {
  server.registerTool(
    'fs_list_directory',
    {
      title: 'List directory',
      description: 'List files and directories under an allowed local path.',
      inputSchema: z.object({ path: z.string().min(1) }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    },
    async ({ path: input }) => {
      try {
        return await audited(audit, 'fs_list_directory', { path: input }, async () => {
          const dir = await resolveAllowedDirectory(input, policy);
          const entries = await readdir(dir, { withFileTypes: true });
          const rows = entries.map((entry) => ({
            name: entry.name,
            type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : 'other'
          }));
          return textResult({ path: dir, entries: rows });
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'fs_read_file',
    {
      title: 'Read file',
      description: 'Read a UTF-8 text file inside allowedRoots, optionally by line range.',
      inputSchema: z.object({
        path: z.string().min(1),
        startLine: z.number().int().positive().optional(),
        endLine: z.number().int().positive().optional(),
        maxBytes: z.number().int().positive().optional()
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    },
    async ({ path: input, startLine, endLine, maxBytes }) => {
      try {
        return await audited(audit, 'fs_read_file', { path: input, startLine, endLine }, async () => {
          const file = await resolveAllowedPath(input, policy, { mustExist: true });
          const info = await stat(file);
          if (!info.isFile()) throw new Error(`Not a file: ${file}`);
          const limit = Math.min(maxBytes ?? policy.filesystem.maxReadBytes, policy.filesystem.maxReadBytes);
          if (info.size > limit) throw new Error(`File is ${info.size} bytes; read limit is ${limit}. Use a smaller file or line range after narrowing it.`);
          const content = await readFile(file, 'utf8');
          const lines = content.split(/\r?\n/);
          const from = startLine ?? 1;
          const to = Math.min(endLine ?? lines.length, lines.length);
          if (to < from) throw new Error('endLine must be greater than or equal to startLine.');
          return textResult({
            path: file,
            startLine: from,
            endLine: to,
            totalLines: lines.length,
            text: lines.slice(from - 1, to).join('\n')
          });
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'fs_file_info',
    {
      title: 'File info',
      description: 'Return metadata for an allowed local path.',
      inputSchema: z.object({ path: z.string().min(1) }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    },
    async ({ path: input }) => {
      try {
        return await audited(audit, 'fs_file_info', { path: input }, async () => {
          const target = await resolveAllowedPath(input, policy, { mustExist: true });
          const info = await lstat(target);
          return textResult({
            path: target,
            type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : info.isSymbolicLink() ? 'symlink' : 'other',
            size: info.size,
            modifiedAt: info.mtime.toISOString(),
            createdAt: info.birthtime.toISOString()
          });
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'fs_write_file',
    {
      title: 'Write file',
      description: 'Create or replace a UTF-8 file inside allowedRoots.',
      inputSchema: z.object({
        path: z.string().min(1),
        content: z.string(),
        createDirectories: z.boolean().default(true),
        overwrite: z.boolean().default(true)
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
    },
    async ({ path: input, content, createDirectories, overwrite }) => {
      try {
        return await audited(audit, 'fs_write_file', { path: input, bytes: countBytes(content), overwrite }, async () => {
          if (countBytes(content) > policy.filesystem.maxWriteBytes) {
            throw new Error(`Content exceeds maxWriteBytes=${policy.filesystem.maxWriteBytes}.`);
          }
          const file = await resolveAllowedPath(input, policy);
          if (createDirectories) await mkdir(path.dirname(file), { recursive: true });
          if (!overwrite) {
            try {
              await lstat(file);
              throw new Error(`File already exists and overwrite=false: ${file}`);
            } catch (error) {
              if (error instanceof Error && !('code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT')) throw error;
            }
          }
          await writeFile(file, content, { encoding: 'utf8', flag: overwrite ? 'w' : 'wx' });
          return textResult({ path: file, bytes: countBytes(content) });
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'fs_replace_text',
    {
      title: 'Replace text in file',
      description: 'Replace an exact text fragment in a UTF-8 file. Safer for targeted edits than rewriting the whole file.',
      inputSchema: z.object({
        path: z.string().min(1),
        oldText: z.string().min(1),
        newText: z.string(),
        replaceAll: z.boolean().default(false),
        expectedOccurrences: z.number().int().nonnegative().optional()
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
    },
    async ({ path: input, oldText, newText, replaceAll, expectedOccurrences }) => {
      try {
        return await audited(audit, 'fs_replace_text', { path: input, replaceAll, expectedOccurrences }, async () => {
          const file = await resolveAllowedPath(input, policy, { mustExist: true });
          const original = await readFile(file, 'utf8');
          const occurrences = original.split(oldText).length - 1;
          if (occurrences === 0) throw new Error('oldText was not found.');
          if (expectedOccurrences !== undefined && occurrences !== expectedOccurrences) {
            throw new Error(`Expected ${expectedOccurrences} occurrence(s), found ${occurrences}; file was not modified.`);
          }
          if (!replaceAll && occurrences > 1 && expectedOccurrences === undefined) {
            throw new Error(`oldText occurs ${occurrences} times. Set expectedOccurrences or replaceAll to avoid an ambiguous edit.`);
          }
          const updated = replaceAll ? original.split(oldText).join(newText) : original.replace(oldText, newText);
          if (countBytes(updated) > policy.filesystem.maxWriteBytes) throw new Error('Updated file exceeds maxWriteBytes.');
          await writeFile(file, updated, 'utf8');
          return textResult({ path: file, occurrencesFound: occurrences, replacementsMade: replaceAll ? occurrences : 1 });
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'fs_search_text',
    {
      title: 'Search text',
      description: 'Recursively search UTF-8-ish text files under an allowed directory. Skips configured heavy directories.',
      inputSchema: z.object({
        root: z.string().min(1),
        query: z.string().min(1),
        useRegex: z.boolean().default(false),
        caseSensitive: z.boolean().default(false),
        maxResults: z.number().int().positive().max(500).default(100)
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    },
    async ({ root: inputRoot, query, useRegex, caseSensitive, maxResults }) => {
      try {
        return await audited(audit, 'fs_search_text', { root: inputRoot, query, useRegex, caseSensitive, maxResults }, async () => {
          const root = await resolveAllowedDirectory(inputRoot, policy);
          const results: Array<{ path: string; line: number; text: string }> = [];
          const regex = useRegex ? new RegExp(query, caseSensitive ? '' : 'i') : undefined;
          const needle = caseSensitive ? query : query.toLowerCase();

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
              const line = lines[i];
              const hit = regex ? regex.test(line) : (caseSensitive ? line : line.toLowerCase()).includes(needle);
              if (hit) results.push({ path: file, line: i + 1, text: line.slice(0, 500) });
              if (results.length >= maxResults) return true;
            }
          });

          return textResult({ root, count: results.length, results });
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'fs_create_directory',
    {
      title: 'Create directory',
      description: 'Create a directory inside allowedRoots.',
      inputSchema: z.object({ path: z.string().min(1), recursive: z.boolean().default(true) }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    async ({ path: input, recursive }) => {
      try {
        return await audited(audit, 'fs_create_directory', { path: input, recursive }, async () => {
          const target = await resolveAllowedPath(input, policy);
          await mkdir(target, { recursive });
          return textResult({ path: target });
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'fs_copy_file',
    {
      title: 'Copy file',
      description: 'Copy one file between allowed paths.',
      inputSchema: z.object({ source: z.string().min(1), destination: z.string().min(1), overwrite: z.boolean().default(false) }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    async ({ source, destination, overwrite }) => {
      try {
        return await audited(audit, 'fs_copy_file', { source, destination, overwrite }, async () => {
          const src = await resolveAllowedPath(source, policy, { mustExist: true });
          const dst = await resolveAllowedPath(destination, policy);
          await mkdir(path.dirname(dst), { recursive: true });
          if (!overwrite) {
            try {
              await lstat(dst);
              throw new Error(`Destination already exists: ${dst}`);
            } catch (error) {
              if (error instanceof Error && !('code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT')) throw error;
            }
          }
          await copyFile(src, dst);
          return textResult({ source: src, destination: dst });
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'fs_move_path',
    {
      title: 'Move path',
      description: 'Move or rename a file/directory between allowed paths.',
      inputSchema: z.object({ source: z.string().min(1), destination: z.string().min(1) }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
    },
    async ({ source, destination }) => {
      try {
        return await audited(audit, 'fs_move_path', { source, destination }, async () => {
          const src = await resolveAllowedPath(source, policy, { mustExist: true });
          const dst = await resolveAllowedPath(destination, policy);
          await mkdir(path.dirname(dst), { recursive: true });
          await rename(src, dst);
          return textResult({ source: src, destination: dst });
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'fs_delete_path',
    {
      title: 'Delete path',
      description: 'Delete an allowed file or directory. Recursive directory deletion must be explicitly requested.',
      inputSchema: z.object({ path: z.string().min(1), recursive: z.boolean().default(false) }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
    },
    async ({ path: input, recursive }) => {
      try {
        return await audited(audit, 'fs_delete_path', { path: input, recursive }, async () => {
          const target = await resolveAllowedPath(input, policy, { mustExist: true });
          for (const root of policy.allowedRoots) {
            if (path.resolve(target) === path.resolve(root)) throw new Error('Refusing to delete an allowedRoot itself.');
          }
          const info = await lstat(target);
          if (info.isDirectory() && !recursive) throw new Error('Target is a directory; set recursive=true explicitly.');
          await rm(target, { recursive, force: false });
          return textResult({ deleted: target });
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );
}
