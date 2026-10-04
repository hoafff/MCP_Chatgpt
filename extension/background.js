const BASE = 'http://127.0.0.1:8787/bridge';
const CLIENT_HEADER = { 'x-local-bridge-client': 'mcp-chatgpt-extension-v1' };

async function request(path, options = {}) {
  const response = await fetch(BASE + path, {
    ...options,
    headers: {
      ...CLIENT_HEADER,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  const body = await response.json().catch(() => ({ ok: false, error: 'Invalid JSON response from local bridge.' }));
  if (!response.ok) {
    throw new Error(body.error || `HTTP ${response.status}`);
  }
  return body;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message?.type === 'BRIDGE_STATUS') {
      sendResponse(await request('/health'));
      return;
    }
    if (message?.type === 'BRIDGE_TOOLS') {
      sendResponse(await request('/tools'));
      return;
    }
    if (message?.type === 'BRIDGE_CALL') {
      sendResponse(
        await request('/call', {
          method: 'POST',
          body: JSON.stringify(message.call)
        })
      );
      return;
    }
    sendResponse({ ok: false, error: 'Unknown extension message.' });
  })().catch((error) => {
    sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
  });
  return true;
});
