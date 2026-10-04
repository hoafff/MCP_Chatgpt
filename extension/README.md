# ChatGPT Local Bridge extension

This unpacked Chrome/Edge extension connects a normal `chatgpt.com` conversation to the read-only local bridge served by this repository.

It does **not** use the OpenAI API and it does **not** require ChatGPT custom MCP support.

## Safe Manual-Send Mode

Version 0.2.0 intentionally avoids browser automation of ChatGPT responses.

The extension does **not**:

- inspect or scrape ChatGPT assistant replies;
- wait for `<LOCAL_TOOL>` responses;
- auto-loop tool calls;
- press ChatGPT's Send button;
- expose shell, write, delete, Git commit, or Git push through the browser bridge.

Instead:

1. You type a normal request containing `@local` or a Windows path.
2. On the first Enter/click, the extension prevents that message from being sent.
3. It reads the requested local file or lists the requested local directory through `127.0.0.1`.
4. It replaces the composer text with your original request plus the actual local material.
5. It **stops**.
6. You review/edit the material.
7. You manually press Send only if you approve what will be uploaded to ChatGPT.

This makes the browser extension closer to a local attachment helper than an autonomous web agent.

## Local safety boundary

Browser access remains read-only and all paths still pass through the server's existing:

- `allowedRoots`;
- `protectedPaths`;
- real-path / symlink / junction checks;
- read-size limits;
- audit logger.

The local server remains bound to `127.0.0.1`.

## Load unpacked

1. Start the local server from the repository root.
2. Open `chrome://extensions` or `edge://extensions`.
3. Enable **Developer mode**.
4. Choose **Load unpacked**.
5. Select this repository's `extension` folder.
6. Refresh `https://chatgpt.com/`.
7. Confirm the badge says **Local Bridge: safe mode ready**.

## Usage

Example:

```text
@local đọc file E:\MCP_ChatGpt\README.md và tóm tắt project này
```

Press Enter once. The message is **not sent**. The composer becomes something like:

```text
[LOCAL_BRIDGE_READY_FOR_MANUAL_SEND]
[LOCAL MATERIAL FROM THIS COMPUTER — REVIEW BEFORE SENDING]
Source: E:\MCP_ChatGpt\README.md
...

[LOCAL MATERIAL]
...real local file content...
[/LOCAL MATERIAL]

[ORIGINAL REQUEST]
đọc file E:\MCP_ChatGpt\README.md và tóm tắt project này

[PRIVACY CHECK]
...
Nothing has been sent automatically. Press Send yourself only if you approve.
```

Review the material and manually press Send.

For paths containing spaces, quoting the full path is recommended:

```text
@local đọc "E:\My Project\notes.txt" và tóm tắt
```

## Privacy warning

Once **you manually press Send**, the inserted local material is uploaded to ChatGPT just as if you pasted it yourself.

Do not send passwords, API keys, access tokens, cookies, private keys, recovery codes, credentials, or confidential material that you do not want in the conversation.
