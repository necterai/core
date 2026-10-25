// Control channel for the zoo harness: the harness opens this page with ?base=<url>&run=1, we forward the task to
// the service worker and mirror its status into document.title so the harness can waitForFunction on it.
(function () {
  const params = new URLSearchParams(location.search);
  const base = params.get('base');
  const statusEl = document.getElementById('status');
  function render(status) {
    const text = JSON.stringify(status, null, 1);
    statusEl.textContent = text;
    document.title = status.state === 'done' ? 'done' : status.state === 'error' ? 'error: ' + (status.error || '') : status.state || 'idle';
  }
  async function poll() {
    try {
      const status = await chrome.runtime.sendMessage({ type: 'status' });
      if (status) render(status);
      if (status && (status.state === 'done' || status.state === 'error')) return;
    } catch (e) {
      statusEl.textContent = 'poll error: ' + e;
    }
    setTimeout(poll, 400);
  }
  if (base && params.get('run') === '1') {
    chrome.runtime.sendMessage({ type: 'run', base: base, task: params.get('task') || 'shop' }).then(poll, (e) => (statusEl.textContent = 'send error: ' + e));
  } else {
    poll();
  }
})();
