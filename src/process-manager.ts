import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Policy } from './types.js';
import { assertCommandAllowed } from './command.js';

interface ManagedProcess {
  id: string;
  command: string;
  cwd: string;
  child: ChildProcessWithoutNullStreams;
  stdout: string;
  stderr: string;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
}

function trimBuffer(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.byteLength <= maxBytes) return text;
  return bytes.subarray(bytes.byteLength - maxBytes).toString('utf8');
}

export class ProcessManager {
  private readonly processes = new Map<string, ManagedProcess>();

  constructor(private readonly policy: Policy) {}

  start(command: string, cwd: string): string {
    assertCommandAllowed(command, this.policy);
    const id = randomUUID();
    const isWindows = process.platform === 'win32';
    const args = isWindows
      ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command]
      : ['-lc', command];

    const child = spawn(this.policy.shell.executable, args, {
      cwd,
      windowsHide: true,
      env: process.env
    });

    const item: ManagedProcess = {
      id,
      command,
      cwd,
      child,
      stdout: '',
      stderr: '',
      startedAt: new Date().toISOString()
    };

    const cap = this.policy.shell.maxOutputBytes;
    child.stdout.on('data', (chunk: Buffer | string) => {
      item.stdout = trimBuffer(item.stdout + chunk.toString(), cap);
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      item.stderr = trimBuffer(item.stderr + chunk.toString(), cap);
    });
    child.on('close', (code, signal) => {
      item.exitCode = code;
      item.signal = signal;
      item.finishedAt = new Date().toISOString();
    });

    this.processes.set(id, item);
    return id;
  }

  status(id: string): Record<string, unknown> {
    const item = this.require(id);
    return {
      id: item.id,
      command: item.command,
      cwd: item.cwd,
      pid: item.child.pid,
      running: item.exitCode === undefined && item.finishedAt === undefined,
      startedAt: item.startedAt,
      finishedAt: item.finishedAt ?? null,
      exitCode: item.exitCode ?? null,
      signal: item.signal ?? null,
      stdout: item.stdout,
      stderr: item.stderr
    };
  }

  list(): Record<string, unknown>[] {
    return [...this.processes.values()].map((item) => ({
      id: item.id,
      command: item.command,
      cwd: item.cwd,
      pid: item.child.pid,
      running: item.exitCode === undefined && item.finishedAt === undefined,
      startedAt: item.startedAt,
      finishedAt: item.finishedAt ?? null,
      exitCode: item.exitCode ?? null
    }));
  }

  stop(id: string): boolean {
    const item = this.require(id);
    if (item.exitCode !== undefined || item.finishedAt !== undefined) return false;
    return item.child.kill();
  }

  private require(id: string): ManagedProcess {
    const item = this.processes.get(id);
    if (!item) throw new Error(`Unknown process id: ${id}`);
    return item;
  }
}
