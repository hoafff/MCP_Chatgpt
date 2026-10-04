import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Policy } from './types.js';

export class AuditLogger {
  constructor(private readonly policy: Policy) {}

  async write(tool: string, details: Record<string, unknown>, ok: boolean, durationMs: number, error?: unknown): Promise<void> {
    if (!this.policy.audit.enabled) return;
    await mkdir(this.policy.audit.directory, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const file = path.join(this.policy.audit.directory, `audit-${date}.jsonl`);
    const entry = {
      timestamp: new Date().toISOString(),
      tool,
      ok,
      durationMs,
      details,
      ...(error ? { error: error instanceof Error ? error.message : String(error) } : {})
    };
    await appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8');
  }
}

export async function audited<T>(
  logger: AuditLogger,
  tool: string,
  details: Record<string, unknown>,
  fn: () => Promise<T>
): Promise<T> {
  const started = Date.now();
  try {
    const value = await fn();
    await logger.write(tool, details, true, Date.now() - started);
    return value;
  } catch (error) {
    await logger.write(tool, details, false, Date.now() - started, error);
    throw error;
  }
}
