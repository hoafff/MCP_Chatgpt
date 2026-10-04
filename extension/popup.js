const statusEl = document.getElementById('status');
const pageStatusEl = document.getElementById('pageStatus');
const debugEl = document.getElementById('debug');
const scanButton = document.getElementById('scanNow');

function renderDebug(result) {
  if (!result || !result.ok || !result.debug) {
    pageStatusEl.className = 'bad';
    pageStatusEl.textContent = 'ChatGPT page telemetry unavailable.';
    debugEl.textContent = (result && result.error) || 'Refresh the ChatGPT tab after reloading the extension.';
    return;
  }

  const d = result.debug;
  pageStatusEl.className = d.lastError ? 'bad' : 'ok';
  pageStatusEl.textContent = d.lastError ? 'Page scan has a diagnostic.' : 'ChatGPT content script is connected.';
  debugEl.textContent = [
    'version: ' + d.version,
    'scans: ' + d.scans,
    'visibleStreaming: ' + d.visibleStreaming,
    'toolContainerFound: ' + d.toolContainerFound,
    'parseOk: ' + d.parseOk,
    'lastAction: ' + (d.lastAction || '-'),
    'bridgeCallOk: ' + String(d.bridgeCallOk),
    'resultInjected: ' + d.resultInjected,
    'submitOk: ' + String(d.submitOk),
    'executedCount: ' + d.executedCount,
    'lastError: ' + (d.lastError || '-')
  ].join('\n');
}

function sendToActiveTab(message, callback) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (!tab || !tab.id) {
      callback({ ok: false, error: 'No active tab.' });
      return;
    }
    chrome.tabs.sendMessage(tab.id, message, (response) => {
      if (chrome.runtime.lastError) {
        callback({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        callback(response);
      }
    });
  });
}

chrome.runtime.sendMessage({ type: 'BRIDGE_STATUS' }, (result) => {
  if (chrome.runtime.lastError) {
    statusEl.className = 'bad';
    statusEl.textContent = chrome.runtime.lastError.message;
    return;
  }
  if (result && result.ok) {
    statusEl.className = 'ok';
    statusEl.textContent = 'Connected — local bridge is read-only.';
  } else {
    statusEl.className = 'bad';
    statusEl.textContent = 'Disconnected — ' + ((result && result.error) || 'start the local server');
  }
});

sendToActiveTab({ type: 'LOCAL_DEBUG_STATE' }, renderDebug);

scanButton.addEventListener('click', () => {
  scanButton.disabled = true;
  scanButton.textContent = 'Scanning...';
  sendToActiveTab({ type: 'LOCAL_SCAN_NOW' }, (result) => {
    renderDebug(result);
    scanButton.disabled = false;
    scanButton.textContent = 'Scan current ChatGPT page now';
  });
});
