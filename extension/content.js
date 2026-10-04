(() => {
  const READY_MARKER = '[LOCAL_BRIDGE_READY_FOR_MANUAL_SEND]';
  const MAX_INSERT_CHARS = 80000;
  let processing = false;

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

  async function refreshStatus() {
    const status = await send({ type: 'BRIDGE_STATUS' });
    if (status && status.ok) {
      setStatus('safe mode ready');
    } else {
      setStatus('offline', false);
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
    } catch {
      editor.textContent = text;
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      return true;
    }
  }

  function shouldPrepareLocal(text) {
    if (!text || text.includes(READY_MARKER)) return false;
    return /@local(?:-mcp)?\b/i.test(text);
  }

  function extractWindowsPath(text) {
    const quoted = text.match(/["']([A-Za-z]:\\[^"'\r\n]+)["']/);
    if (quoted) return quoted[1].trim();

    const fileLike = text.match(/\b([A-Za-z]:\\[^\r\n<>|?*"]+?\.[A-Za-z0-9]{1,12})(?=\s+(?:và|va|rồi|roi|and|then|để|de|cho|giúp|giup|hãy|hay)\b|[),;!?]|$)/i);
    if (fileLike) return fileLike[1].trim();

    const afterLocal = text.match(/@local(?:-mcp)?\s+([A-Za-z]:\\[^\r\n]+)/i);
    if (afterLocal) {
      return afterLocal[1]
        .split(/\s+(?:và|va|rồi|roi|and|then|để|de|cho|giúp|giup|hãy|hay)\s+/i)[0]
        .trim()
        .replace(/[),;!?]+$/, '');
    }

    const generic = text.match(/\b([A-Za-z]:\\[^\r\n]+)/);
    if (!generic) return null;
    return generic[1]
      .split(/\s+(?:và|va|rồi|roi|and|then|để|de|cho|giúp|giup|hãy|hay)\s+/i)[0]
      .trim()
      .replace(/[),;!?]+$/, '');
  }

  function formatDirectory(result) {
    const entries = Array.isArray(result.entries) ? result.entries : [];
    return entries
      .map((entry) => (entry.type === 'directory' ? '[DIR]  ' : '[FILE] ') + entry.name)
      .join('\n');
  }

  function trimForComposer(text) {
    if (text.length <= MAX_INSERT_CHARS) return { text, truncated: false };
    return {
      text: text.slice(0, MAX_INSERT_CHARS) + '\n...[truncated locally before sending to ChatGPT]',
      truncated: true
    };
  }

  async function prepareLocalMaterial(originalText, editor) {
    const localPath = extractWindowsPath(originalText);
    if (!localPath) {
      setStatus('put the local path in quotes', false);
      return false;
    }

    setStatus('reading local file');
    const infoResponse = await send({
      type: 'BRIDGE_CALL',
      call: { action: 'file_info', path: localPath }
    });

    if (!infoResponse || !infoResponse.ok) {
      setStatus('local read failed', false);
      const reason = (infoResponse && infoResponse.error) || 'Unknown local bridge error';
      writeEditor(
        editor,
        originalText + '\n\n[LOCAL BRIDGE ERROR — NOT SENT]\n' + reason + '\n\nPlease correct the path and try again.'
      );
      return false;
    }

    const info = infoResponse.result || {};
    let action;
    let dataResponse;

    if (info.type === 'directory') {
      action = 'list_directory';
      dataResponse = await send({
        type: 'BRIDGE_CALL',
        call: { action, path: localPath }
      });
    } else if (info.type === 'file') {
      action = 'read_file';
      dataResponse = await send({
        type: 'BRIDGE_CALL',
        call: { action, path: localPath }
      });
    } else {
      setStatus('unsupported local path type', false);
      return false;
    }

    if (!dataResponse || !dataResponse.ok) {
      setStatus('local read failed', false);
      const reason = (dataResponse && dataResponse.error) || 'Unknown local bridge error';
      writeEditor(
        editor,
        originalText + '\n\n[LOCAL BRIDGE ERROR — NOT SENT]\n' + reason + '\n\nNothing was sent automatically.'
      );
      return false;
    }

    const result = dataResponse.result || {};
    const rawData = action === 'read_file' ? String(result.text || '') : formatDirectory(result);
    const prepared = trimForComposer(rawData);
    const cleanedRequest = originalText.replace(/@local(?:-mcp)?\b/gi, '').trim();

    const payload = [
      READY_MARKER,
      '[LOCAL MATERIAL FROM THIS COMPUTER — REVIEW BEFORE SENDING]',
      'Source: ' + localPath,
      'Type: ' + (info.type || 'unknown'),
      prepared.truncated ? 'Note: content was truncated locally before insertion.' : 'Note: content below is the local data that will be sent only if you press Send.',
      '',
      '[LOCAL MATERIAL]',
      prepared.text,
      '[/LOCAL MATERIAL]',
      '',
      '[ORIGINAL REQUEST]',
      cleanedRequest || originalText,
      '',
      '[PRIVACY CHECK]',
      'Review the local material above. If it contains secrets, tokens, passwords, private keys, cookies, personal data, or anything you do not want uploaded to ChatGPT, edit/remove it now.',
      'Nothing has been sent automatically. Press Send yourself only if you approve.'
    ].join('\n');

    writeEditor(editor, payload);
    setStatus('review then press Send');
    return true;
  }

  function stopSend(event) {
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
  }

  async function interceptManualSend(event, editor) {
    if (processing) {
      stopSend(event);
      return;
    }

    const text = readEditor(editor).trim();
    if (!shouldPrepareLocal(text)) return;

    stopSend(event);
    processing = true;
    try {
      await prepareLocalMaterial(text, editor);
    } catch (error) {
      setStatus('preparation error', false);
      const message = error instanceof Error ? error.message : String(error);
      writeEditor(editor, text + '\n\n[LOCAL BRIDGE ERROR — NOT SENT]\n' + message);
    } finally {
      processing = false;
    }
  }

  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
      const editor = getEditor();
      if (!editor) return;
      const active = document.activeElement;
      if (active !== editor && !editor.contains(active)) return;
      void interceptManualSend(event, editor);
    },
    true
  );

  document.addEventListener(
    'click',
    (event) => {
      const target = event.target;
      const button = target && target.closest ? target.closest('button') : null;
      if (!button) return;
      const isSend =
        button.matches('[data-testid="send-button"]') ||
        /send|gửi/i.test(button.getAttribute('aria-label') || '');
      if (!isSend) return;
      const editor = getEditor();
      if (editor) void interceptManualSend(event, editor);
    },
    true
  );

  ensureBadge();
  void refreshStatus();
  setInterval(() => void refreshStatus(), 15000);
})();
