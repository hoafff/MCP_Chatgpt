# ChatGPT Local Bridge extension

This unpacked Chrome/Edge extension connects a normal `chatgpt.com` conversation to the read-only local bridge served by this repository.

It does **not** use the OpenAI API and it does **not** require ChatGPT custom MCP support.

## Safety posture in v0.1

The browser bridge exposes only:

- `list_directory`
- `read_file`
- `file_info`
- `search_text`

All paths still pass through the server's existing `allowedRoots`, `protectedPaths`, real-path/junction checks, file-size limits, and audit logger.

The extension becomes active only when a user prompt contains either:

- `@local` / `@local-mcp`, or
- an absolute Windows path such as `E:\\Projects\\repo\\README.md`.

Other ChatGPT prompts are left alone.

## Load unpacked

1. Start the local server from the repository root.
2. Open `chrome://extensions` (or `edge://extensions`).
3. Enable **Developer mode**.
4. Choose **Load unpacked**.
5. Select this repository's `extension` folder.
6. Open or refresh `https://chatgpt.com/`.
7. A small **Local Bridge: ready** badge should appear in the lower-right corner.

Clicking the extension icon also reports whether the local read-only bridge is reachable.

## First test

In a normal ChatGPT conversation, send something like:

```text
@local đọc file E:\\MCP_ChatGpt\\README.md và cho tôi biết project này làm gì
```

The extension adds a local-tool protocol instruction to that turn. If ChatGPT emits a `<LOCAL_TOOL>...</LOCAL_TOOL>` request, the extension calls the local read-only bridge, inserts the real result into the same conversation, and lets ChatGPT continue.

## Notes

This is browser UI automation, not an official ChatGPT MCP integration. ChatGPT DOM changes can require selector updates. Keep the local server bound to `127.0.0.1` and do not expose the bridge publicly.
