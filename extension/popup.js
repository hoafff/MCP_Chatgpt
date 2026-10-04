const el = document.getElementById('status');

chrome.runtime.sendMessage({ type: 'BRIDGE_STATUS' }, (result) => {
  if (chrome.runtime.lastError) {
    el.className = 'bad';
    el.textContent = chrome.runtime.lastError.message;
    return;
  }

  if (result && result.ok) {
    el.className = 'ok';
    el.textContent = 'Connected — safe manual-send mode is ready.';
  } else {
    el.className = 'bad';
    el.textContent = 'Disconnected — ' + ((result && result.error) || 'start the local server');
  }
});
