(() => {
  const TOOL_TAG = /<LOCAL_TOOL>\s*([\s\S]*?)\s*<\/LOCAL_TOOL>/i;
  const MAX_RESULT_CHARS = 120000;
  const executed = new Set();
  let tools = [];
  let bypassNextSend = false;
  let processing = false;
  let debounceTimer = null;
  const debugState = {
    version: '0.1.3',
    scans: 0,
    lastScanAt: null,
    visibleStreaming: false,
    toolContainerFound: false,
    parseOk: false,
    lastAction: null,
    bridgeCallOk: null,
    resultInjected: false,
    submitOk: null,
    lastError: null
  };

  function updateDebug(patch) {
    Object.assign(debugState, patch, { lastScanAt: new Date().toISOString() });
  }

  function debugSnapshot() {
    return {
      ...debugState,
      executedCount: executed.size,
      url: location.href
    };
  }

  function send(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(response);
        }
      });
    });
  }

  function ensureBadge() {
    let badge = document.getElementById('chatgpt-local-bridge-badge');
    if (badge) return badge;
    badge = document.createElement('div');
    badge.id = 'chatgpt-local-bridge-badge';
    badge.style.cssText = [
      'position:fixed',
      'right:18px',
      'bottom:18px',
      'z-index:999999',
      'padding:7px 10px',
      'border-radius:9px',
      'font:12px system-ui,sans-serif',
      'background:rgba(17,24,39,.92)',
      'color:#d1d5db',
      'border:1px solid rgba(255,255,255,.14)',
      'box-shadow:0 6px 20px rgba(0,0,0,.25)',
      'pointer-events:none'
    ].join(';');
    badge.textContent = 'Local Bridge: checking';
    document.body.appendChild(badge);
    return badge;
  }

  function setStatus(text, ok = true) {
    const badge = ensureBadge();
    badge.textContent = 'Local Bridge: ' + text;
    badge.style.color = ok ? '#34d399' : '#f87171';
  }

  async function refreshTools() {
    const status = await send({ type: 'BRIDGE_STATUS' });
    if (!status || !status.ok) {
      setStatus('offline', false);
      return;
    }
    const response = await send({ type: 'BRIDGE_TOOLS' });
    if (response && response.ok && Array.isArray(response.tools)) {
      tools = response.tools;
      setStatus('ready');
    } else {
      setStatus('tool sync failed', false);
    }
  }

  function getEditor() {
    return (
      document.querySelector('#prompt-textarea') ||
      document.querySelector('form [contenteditable="true"]') ||
      document.querySelector('[contenteditable="true"][data-lexical-editor="true"]')
    );
  }

  function readEditor(editor) {
    if (!editor) return '';
    if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) return editor.value || '';
    return editor.innerText || editor.textContent || '';
  }

  function writeEditor(editor, text) {
    if (!editor) return false;
    editor.focus();

    if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
      const proto = editor instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
      const setter = descriptor && descriptor.set;
      if (setter) setter.call(editor, text);
      else editor.value = text;
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      editor.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }

    try {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand('insertText', false, text);
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      return true;
    } catch (error) {
      editor.textContent = text;
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      return true;
    }
  }

  function submitEditor(editor) {
    const form = editor && editor.closest('form');
    const button =
      (form && form.querySelector('button[data-testid="send-button"]')) ||
      (form && form.querySelector('button[aria-label*="Send"]')) ||
      (form && form.querySelector('button[aria-label*="Gửi"]')) ||
      document.querySelector('button[data-testid="send-button"]');

    if (button && !button.disabled) {
      bypassNextSend = true;
      button.click();
      setTimeout(() => {
        bypassNextSend = false;
      }, 800);
      return true;
    }

    if (form && typeof form.requestSubmit === 'function') {
      bypassNextSend = true;
      form.requestSubmit();
      setTimeout(() => {
        bypassNextSend = false;
      }, 800);
      return true;
    }

    return false;
  }

  function shouldUseLocal(text) {
    if (!text) return false;
    if (text.includes('[LOCAL_BRIDGE_RESULT]')) return false;
    return /@local(?:-mcp)?\b/i.test(text) || /\b[A-Za-z]:\\[^\r\n]*/.test(text);
  }

  function toolInstruction(userText) {
    const toolLines = (tools.length ? tools : [
      { name: 'list_directory', description: 'List files and folders in an allowed directory.' },
      { name: 'read_file', description: 'Read an allowed UTF-8 file, optionally by line range.' },
      { name: 'file_info', description: 'Get metadata for an allowed path.' },
      { name: 'search_text', description: 'Search text recursively under an allowed directory.' }
    ])
      .map((tool) => '- ' + tool.name + ': ' + tool.description)
      .join('\n');

    const cleaned = userText.replace(/@local(?:-mcp)?\b/gi, '').trim();

    return [
      '[LOCAL BRIDGE INSTRUCTION]',
      'A read-only local-file bridge is available in this browser conversation.',
      'When local data is needed, reply with exactly ONE tool request and no surrounding prose:',
      '<LOCAL_TOOL>',
      '{"action":"read_file","path":"E:\\\\path\\\\file.txt"}',
      '</LOCAL_TOOL>',
      '',
      'Allowed actions:',
      toolLines,
      '',
      'Schemas:',
      '- list_directory: {"action":"list_directory","path":"..."}',
      '- read_file: {"action":"read_file","path":"...","startLine":1,"endLine":200}',
      '- file_info: {"action":"file_info","path":"..."}',
      '- search_text: {"action":"search_text","root":"...","query":"...","useRegex":false,"caseSensitive":false,"maxResults":50}',
      '',
      'Rules:',
      '- Use only these read-only actions.',
      '- Never invent local file contents.',
      '- If another local read is needed after a result, emit the next single <LOCAL_TOOL> request.',
      '- When enough local information has been gathered, answer the user normally.',
      '',
      '[USER REQUEST]',
      cleaned || userText
    ].join('\n');
  }

  function interceptManualSend(event, editor) {
    if (bypassNextSend) return;
    const text = readEditor(editor).trim();
    if (!shouldUseLocal(text)) return;

    // A fresh user-triggered local request may legitimately repeat an earlier
    // read, so de-duplicate only within the current local tool loop.
    executed.clear();

    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();

    const enriched = toolInstruction(text);
    writeEditor(editor, enriched);
    setStatus('request prepared');
    setTimeout(() => {
      if (!submitEditor(editor)) {
        setStatus('could not submit', false);
      }
    }, 120);
  }

  function isVisible(element) {
    if (!element) return false;
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isStreaming() {
    const candidates = [
      ...document.querySelectorAll('button[data-testid="stop-button"]'),
      ...document.querySelectorAll('button[aria-label*="Stop"]'),
      ...document.querySelectorAll('button[aria-label*="Dừng"]')
    ];
    const visible = candidates.some(isVisible);
    updateDebug({ visibleStreaming: visible });
    return visible;
  }

  function elementText(element) {
    return element ? (element.innerText || element.textContent || '') : '';
  }

  function smallestVisibleElementContaining(requiredMarkers, rejectedMarkers = []) {
    const root = document.querySelector('main') || document.body;
    if (!root) return null;

    const candidates = root.querySelectorAll('article, div, p, pre');
    let best = null;
    let bestLength = Number.POSITIVE_INFINITY;

    candidates.forEach((element) => {
      const text = elementText(element);
      if (!text) return;
      if (!requiredMarkers.every((marker) => text.includes(marker))) return;
      if (rejectedMarkers.some((marker) => text.includes(marker))) return;

      const rect = element.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;

      const length = text.length;
      if (length <= bestLength) {
        best = element;
        bestLength = length;
      }
    });

    return best;
  }

  function latestToolCallContainer() {
    const roleMessages = document.querySelectorAll('[data-message-author-role="assistant"]');
    for (let i = roleMessages.length - 1; i >= 0; i--) {
      const message = roleMessages[i];
      const text = elementText(message);
      if (
        text.includes('<LOCAL_TOOL>') &&
        text.includes('</LOCAL_TOOL>') &&
        !text.includes('[LOCAL BRIDGE INSTRUCTION]') &&
        !text.includes('[LOCAL_BRIDGE_RESULT]')
      ) {
        return message;
      }
    }

    return smallestVisibleElementContaining(
      ['<LOCAL_TOOL>', '</LOCAL_TOOL>'],
      ['[LOCAL BRIDGE INSTRUCTION]', '[LOCAL_BRIDGE_RESULT]']
    );
  }

  function parseToolCall(text) {
    const match = text.match(TOOL_TAG);
    if (!match) return null;
    let raw = match[1].trim();
    raw = raw.replace(/^\x60\x60\x60(?:json)?\s*/i, '').replace(/\s*\x60\x60\x60$/i, '').trim();
    try {
      const call = JSON.parse(raw);
      if (!call || typeof call.action !== 'string') return null;
      return call;
    } catch (error) {
      return null;
    }
  }

  function fingerprint(call) {
    try {
      return call.action + '::' + JSON.stringify(call);
    } catch (error) {
      return '';
    }
  }

  async function sendToolResult(call, response) {
    const editor = getEditor();
    if (!editor) {
      updateDebug({ lastError: 'composer not found', resultInjected: false, submitOk: false });
      setStatus('composer not found', false);
      return;
    }

    let body;
    if (response && response.ok) {
      body = JSON.stringify(response.result, null, 2);
    } else {
      body = 'ERROR: ' + ((response && response.error) || 'Unknown local bridge error');
    }

    if (body.length > MAX_RESULT_CHARS) {
      body = body.slice(0, MAX_RESULT_CHARS) + '\n...[result truncated by extension]';
    }

    const resultMessage = [
      '[LOCAL_BRIDGE_RESULT]',
      'Action: ' + call.action,
      body,
      '',
      '[LOCAL BRIDGE CONTINUATION]',
      'Use this real local result. If you need another local read, reply only with the next single <LOCAL_TOOL> request. Otherwise answer the original user request normally.'
    ].join('\n');

    const injected = writeEditor(editor, resultMessage);
    updateDebug({
      bridgeCallOk: Boolean(response && response.ok),
      resultInjected: Boolean(injected),
      lastError: response && response.ok ? null : ((response && response.error) || 'Unknown local bridge error')
    });
    setStatus(response && response.ok ? 'result returned' : 'tool error', Boolean(response && response.ok));
    setTimeout(() => {
      const submitted = submitEditor(editor);
      updateDebug({ submitOk: Boolean(submitted), lastError: submitted ? debugState.lastError : 'could not return result' });
      if (!submitted) setStatus('could not return result', false);
    }, 120);
  }

  async function inspectAssistant(force = false) {
    debugState.scans += 1;
    updateDebug({ lastError: null });

    if (processing) {
      updateDebug({ lastError: 'scan skipped: already processing' });
      return;
    }

    if (!force && isStreaming()) {
      updateDebug({ toolContainerFound: false, parseOk: false, lastError: 'scan skipped: visible streaming control detected' });
      return;
    }

    const message = latestToolCallContainer();
    if (!message) {
      updateDebug({ toolContainerFound: false, parseOk: false, lastError: 'no LOCAL_TOOL container found' });
      return;
    }

    updateDebug({ toolContainerFound: true });
    const text = elementText(message);
    const call = parseToolCall(text);
    if (!call) {
      updateDebug({ parseOk: false, lastError: 'LOCAL_TOOL found but JSON parse failed' });
      return;
    }

    updateDebug({ parseOk: true, lastAction: call.action });
    const fp = fingerprint(call);
    if (!fp) {
      updateDebug({ lastError: 'tool fingerprint failed' });
      return;
    }
    if (executed.has(fp)) {
      updateDebug({ lastError: 'tool call already executed in current loop' });
      return;
    }
    executed.add(fp);
    message.setAttribute('data-local-bridge-executed', 'true');
    processing = true;
    setStatus('reading local data');

    try {
      const allowed = new Set(['list_directory', 'read_file', 'file_info', 'search_text']);
      if (!allowed.has(call.action)) {
        await sendToolResult(call, { ok: false, error: 'Action is not allowed by read-only browser bridge.' });
        return;
      }
      const response = await send({ type: 'BRIDGE_CALL', call });
      updateDebug({
        bridgeCallOk: Boolean(response && response.ok),
        lastError: response && response.ok ? null : ((response && response.error) || 'bridge call failed')
      });
      await sendToolResult(call, response);
    } catch (error) {
      updateDebug({ bridgeCallOk: false, lastError: error instanceof Error ? error.message : String(error) });
      setStatus('execution error', false);
    } finally {
      setTimeout(() => {
        processing = false;
      }, 700);
    }
  }


  function findMessageTextContainer(message, role) {
    if (!message) return null;
    if (role === 'user') {
      return (
        message.querySelector('.whitespace-pre-wrap') ||
        message.querySelector('[class*="whitespace-pre-wrap"]') ||
        message.querySelector('[class*="break-words"]')
      );
    }
    return message.querySelector('.markdown') || message.querySelector('[class*="markdown"]');
  }

  function makeCompactDetails(title, detailText, tone) {
    const details = document.createElement('details');
    details.style.cssText = [
      'margin:4px 0',
      'padding:7px 10px',
      'border-radius:8px',
      'border:1px solid ' + (tone === 'result' ? 'rgba(52,211,153,.35)' : 'rgba(96,165,250,.35)'),
      'background:' + (tone === 'result' ? 'rgba(16,185,129,.08)' : 'rgba(59,130,246,.08)'),
      'font:12px system-ui,sans-serif'
    ].join(';');

    const summary = document.createElement('summary');
    summary.textContent = title;
    summary.style.cssText = 'cursor:pointer;font-weight:600;';
    details.appendChild(summary);

    const pre = document.createElement('pre');
    pre.textContent = detailText;
    pre.style.cssText = 'white-space:pre-wrap;max-height:240px;overflow:auto;margin:8px 0 0;font:11px ui-monospace,monospace;opacity:.82;';
    details.appendChild(pre);
    return details;
  }

  function cleanBridgeUi() {
    const userMessages = document.querySelectorAll('[data-message-author-role="user"]');
    userMessages.forEach((message) => {
      if (message.getAttribute('data-local-bridge-cleaned') === 'true') return;
      const text = elementText(message);
      const container = findMessageTextContainer(message, 'user');

      if (text.includes('[LOCAL BRIDGE INSTRUCTION]') && text.includes('[USER REQUEST]')) {
        const original = text.split('[USER REQUEST]').slice(1).join('[USER REQUEST]').trim();
        const target =
          container ||
          smallestVisibleElementContaining(
            ['[LOCAL BRIDGE INSTRUCTION]', '[USER REQUEST]'],
            ['[LOCAL_BRIDGE_RESULT]']
          );
        if (target) {
          target.textContent = original || '@local request';
          message.setAttribute('data-local-bridge-cleaned', 'true');
        }
        return;
      }

      if (text.includes('[LOCAL_BRIDGE_RESULT]')) {
        const actionMatch = text.match(/Action:\s*([^\n\r]+)/i);
        const action = actionMatch ? actionMatch[1].trim() : 'local read';
        const target =
          container ||
          smallestVisibleElementContaining(
            ['[LOCAL_BRIDGE_RESULT]'],
            ['[LOCAL BRIDGE INSTRUCTION]']
          );
        if (target) {
          target.innerHTML = '';
          target.appendChild(makeCompactDetails('Local Bridge result · ' + action, text, 'result'));
          message.setAttribute('data-local-bridge-cleaned', 'true');
        }
      }
    });

    // Current ChatGPT DOM variants do not always expose data-message-author-role.
    // Compact the injected user instruction/result using marker-based fallback.
    const instructionTarget = smallestVisibleElementContaining(
      ['[LOCAL BRIDGE INSTRUCTION]', '[USER REQUEST]'],
      ['[LOCAL_BRIDGE_RESULT]']
    );
    if (instructionTarget && !instructionTarget.closest('[data-local-bridge-cleaned="true"]')) {
      const text = elementText(instructionTarget);
      const original = text.split('[USER REQUEST]').slice(1).join('[USER REQUEST]').trim();
      instructionTarget.textContent = original || '@local request';
      instructionTarget.setAttribute('data-local-bridge-cleaned', 'true');
    }

    const resultTarget = smallestVisibleElementContaining(
      ['[LOCAL_BRIDGE_RESULT]'],
      ['[LOCAL BRIDGE INSTRUCTION]']
    );
    if (resultTarget && !resultTarget.closest('[data-local-bridge-cleaned="true"]')) {
      const text = elementText(resultTarget);
      const actionMatch = text.match(/Action:\s*([^\n\r]+)/i);
      const action = actionMatch ? actionMatch[1].trim() : 'local read';
      resultTarget.innerHTML = '';
      resultTarget.appendChild(makeCompactDetails('Local Bridge result · ' + action, text, 'result'));
      resultTarget.setAttribute('data-local-bridge-cleaned', 'true');
    }

    const executedMessages = document.querySelectorAll('[data-local-bridge-executed="true"]');
    executedMessages.forEach((message) => {
      if (message.getAttribute('data-local-bridge-cleaned') === 'true') return;
      const text = elementText(message);
      const call = parseToolCall(text);
      if (!call) return;
      const container =
        findMessageTextContainer(message, 'assistant') ||
        smallestVisibleElementContaining(
          ['<LOCAL_TOOL>', '</LOCAL_TOOL>'],
          ['[LOCAL BRIDGE INSTRUCTION]', '[LOCAL_BRIDGE_RESULT]']
        );
      if (!container) return;
      container.innerHTML = '';
      container.appendChild(
        makeCompactDetails('Local Bridge tool · ' + call.action, JSON.stringify(call, null, 2), 'tool')
      );
      message.setAttribute('data-local-bridge-cleaned', 'true');
    });
  }


  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && message.type === 'LOCAL_DEBUG_STATE') {
      sendResponse({ ok: true, debug: debugSnapshot() });
      return;
    }

    if (message && message.type === 'LOCAL_SCAN_NOW') {
      void (async () => {
        try {
          executed.clear();
          await inspectAssistant(true);
          sendResponse({ ok: true, debug: debugSnapshot() });
        } catch (error) {
          updateDebug({ lastError: error instanceof Error ? error.message : String(error) });
          sendResponse({ ok: false, debug: debugSnapshot(), error: debugState.lastError });
        }
      })();
      return true;
    }
  });

  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
      const editor = getEditor();
      if (!editor) return;
      const active = document.activeElement;
      if (active !== editor && !editor.contains(active)) return;
      interceptManualSend(event, editor);
    },
    true
  );

  document.addEventListener(
    'click',
    (event) => {
      if (bypassNextSend) return;
      const target = event.target;
      const button = target && target.closest ? target.closest('button') : null;
      if (!button) return;
      const isSend =
        button.matches('[data-testid="send-button"]') ||
        /send|gửi/i.test(button.getAttribute('aria-label') || '');
      if (!isSend) return;
      const editor = getEditor();
      if (editor) interceptManualSend(event, editor);
    },
    true
  );

  const observer = new MutationObserver(() => {
    cleanBridgeUi();
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      void inspectAssistant();
    }, 450);
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });
  ensureBadge();
  cleanBridgeUi();
  void refreshTools();

  // DOM mutation events can stop before ChatGPT removes its streaming controls.
  // Polling guarantees one final inspection after the turn is actually complete.
  setInterval(() => {
    cleanBridgeUi();
    void inspectAssistant();
  }, 750);

  setInterval(() => {
    void refreshTools();
  }, 15000);
})();
