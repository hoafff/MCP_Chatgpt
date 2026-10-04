# MCP_Chatgpt

Local MCP server for a Windows PC so a supported ChatGPT/OpenAI MCP client can read/edit project files, run PowerShell/CLI commands, manage long-running processes, and inspect or mutate Git repositories.

> **Status:** MVP v0.1.0. The HTTP server binds to `127.0.0.1` only. It is designed to be paired with OpenAI Secure MCP Tunnel rather than exposed directly to the public internet.

## What this MVP exposes

### Filesystem

- `fs_list_directory`
- `fs_read_file`
- `fs_file_info`
- `fs_write_file`
- `fs_replace_text`
- `fs_search_text`
- `fs_create_directory`
- `fs_copy_file`
- `fs_move_path`
- `fs_delete_path`

Filesystem operations are constrained to `allowedRoots` and perform a real-path ancestor check to reduce symlink/junction escapes.

### Shell / processes

- `shell_exec`
- `process_start`
- `process_status`
- `process_list`
- `process_stop`

The default example uses Windows PowerShell. Set `shell.executable` to `pwsh.exe` if you prefer PowerShell 7.

**Important security boundary:** `allowedRoots` is a filesystem-tool boundary, not a complete OS sandbox for arbitrary shell commands. A shell command runs with the Windows permissions of the account that starts this server. Run the MCP under a dedicated low-privilege Windows account/AppContainer if you need a hard shell boundary.

### Git

- `git_status`
- `git_diff`
- `git_log`
- `git_show`
- `git_commit` — disabled by default
- `git_push` — disabled by default

`git_commit` and `git_push` require explicit policy opt-in.

## Requirements

- Windows 10/11 recommended for this project
- Node.js 20+
- Git in `PATH`
- PowerShell (`powershell.exe`) or PowerShell 7 (`pwsh.exe`)

## Install

```powershell
git clone https://github.com/hoafff/MCP_Chatgpt.git
cd MCP_Chatgpt
npm install
Copy-Item .\config\policy.example.json .\config\policy.json
```

Edit `config/policy.json` and replace the example roots with only the folders you want MCP tools to access.

Then:

```powershell
npm run check
npm run build
npm start
```

Expected local endpoints:

```text
http://127.0.0.1:8787/mcp
http://127.0.0.1:8787/health
```

You can change the port:

```powershell
$env:MCP_PORT = "8788"
npm start
```

Or use a different policy file:

```powershell
$env:MCP_POLICY_PATH = "D:\\MCP\\my-policy.json"
npm start
```

## Stdio mode

For an MCP host that launches the local server as a child process:

```powershell
npm run build
npm run start:stdio
```

Do not write debug output to stdout in stdio mode; stdout is the MCP JSON-RPC channel. This project logs startup messages to stderr.

## Policy example

The checked-in `config/policy.example.json` is intentionally conservative around Git mutations while keeping shell enabled for local development.

Create `config/policy.json`; it is ignored by Git so machine-specific paths do not leak into the repository.

Key settings:

```json
{
  "allowedRoots": ["D:\\Projects"],
  "shell": {
    "enabled": true,
    "executable": "powershell.exe"
  },
  "git": {
    "allowCommit": false,
    "allowPush": false
  }
}
```

## Audit log

Tool activity is appended as JSONL under `logs/` by default. File contents and command outputs are not written to the audit log. Command strings are logged by default; set `audit.logCommands=false` if commands may contain secrets.

Never pass passwords, API keys, access tokens, private keys, or MFA codes directly inside a model-visible command when an interactive/secret-safe alternative exists.

## Security model

This MVP has several layers:

1. HTTP binds only to `127.0.0.1`.
2. Host and Origin validation are enabled in front of MCP HTTP handling.
3. File tools enforce `allowedRoots` and `protectedPaths`.
4. Shell commands must start in an allowed directory and are checked against a small emergency blocklist.
5. Git commit/push are separately policy-gated.
6. Tool actions are audited locally.

The shell blocklist is a guardrail, **not a sandbox**. Do not run the MCP process as Administrator. A later hardening phase can add a dedicated Windows account, ACLs, Job Objects/AppContainer, signed policy, and explicit approval gates.

## Connecting to ChatGPT / OpenAI

For a private server on your own PC, prefer OpenAI Secure MCP Tunnel rather than opening an inbound firewall port or publishing the local MCP endpoint. The tunnel client runs inside your machine/network and forwards MCP traffic to the local endpoint through an outbound HTTPS connection.

Keep this local server bound to loopback (`127.0.0.1`).

## Reference design choices

This project is built against the current MCP TypeScript SDK v2 API (`@modelcontextprotocol/server`, `@modelcontextprotocol/node`) and the 2026-era MCP protocol rather than copying older SSE-only templates.

Useful upstream references:

- `modelcontextprotocol/typescript-sdk`
- `modelcontextprotocol/servers`
- `yotsuda/PowerShell.MCP` (PowerShell architecture/security ideas; this repo is not a fork)

## Roadmap

- [x] MCP v2 HTTP + stdio transport
- [x] Allowed-root filesystem tools
- [x] PowerShell execution + long-running managed processes
- [x] Git read tools and policy-gated commit/push
- [x] JSONL audit log
- [ ] Windows hard sandbox / dedicated low-privilege execution identity
- [ ] Human approval policy for high-risk mutations
- [ ] Better patch/diff application tool
- [ ] Process output cursors/streaming
- [ ] Installer / Windows service or scheduled startup
- [ ] Secure MCP Tunnel setup helper
- [ ] GUI automation layer (optional)

## License

MIT
