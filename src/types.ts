export interface FilesystemPolicy {
  maxReadBytes: number;
  maxWriteBytes: number;
  searchMaxFileBytes: number;
  searchSkipDirectories: string[];
}

export interface ShellPolicy {
  enabled: boolean;
  executable: string;
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  maxOutputBytes: number;
  blockedPatterns: string[];
}

export interface GitPolicy {
  allowCommit: boolean;
  allowPush: boolean;
  maxOutputBytes: number;
}

export interface AuditPolicy {
  enabled: boolean;
  directory: string;
  logCommands: boolean;
}

export interface Policy {
  allowedRoots: string[];
  protectedPaths: string[];
  filesystem: FilesystemPolicy;
  shell: ShellPolicy;
  git: GitPolicy;
  audit: AuditPolicy;
}

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}
