const el = document.getElementById('status');
chrome.runtime.sendMessage({ type: 'BRIDGE_STATUS' }, (result) => {
  if (chrome.runtime.lastError) {
    el.className = 'bad';
    el.textContent = chrome.runtime.lastError.message;
    return;
  }
  if (result?.ok) {
    el.className = 'ok';
    el.textContent = 'Connected — local bridge is read-only.';
  } else {
    el.className = 'bad';
    el.textContent = 'Disconnected — ' + (result?.error || 'start the local server');
  }
});
