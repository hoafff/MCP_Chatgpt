import { spawn } from 'node:child_process';
import type { CommandResult, Policy } from './types.js';

function truncate(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const data = Buffer.from(text, 'utf8');
  if (data.byteLength <= maxBytes) return { text, truncated: false };
  return {
    text: data.subarray(0, maxBytes).toString('utf8') + '\n...[output truncated]...',
    truncated: true
  };
}

export function assertCommandAllowed(command: string, policy: Policy): void {
  if (!policy.shell.enabled) throw new Error('Shell tools are disabled by policy.');
  for (const source of policy.shell.blockedPatterns) {
    const pattern = new RegExp(source, 'i');
    if (pattern.test(command)) throw new Error(`Command blocked by shell policy pattern: ${source}`);
  }
}

export async function runCommand(
  command: string,
  cwd: string,
  policy: Policy,
  options?: { timeoutMs?: number; maxOutputBytes?: number }
): Promise<CommandResult> {
  assertCommandAllowed(command, policy);
  const requestedTimeout = options?.timeoutMs ?? policy.shell.defaultTimeoutMs;
  const timeoutMs = Math.min(Math.max(1, requestedTimeout), policy.shell.maxTimeoutMs);
  const maxOutputBytes = options?.maxOutputBytes ?? policy.shell.maxOutputBytes;
  const started = Date.now();

  const isWindows = process.platform === 'win32';
  const args = isWindows
    ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command]
    : ['-lc', command];

  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(policy.shell.executable, args, {
      cwd,
      windowsHide: true,
      env: process.env
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = truncate(stdout, maxOutputBytes);
      const err = truncate(stderr, maxOutputBytes);
      resolve({
        exitCode: code,
        stdout: out.text,
        stderr: err.text,
        timedOut,
        truncated: out.truncated || err.truncated,
        durationMs: Date.now() - started
      });
    });
  });
}
