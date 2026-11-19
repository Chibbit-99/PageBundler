const button = document.getElementById('save');
const statusBox = document.getElementById('status');
const details = document.getElementById('details');
const progressWrap = document.getElementById('progress-wrap');
const progressBar = document.getElementById('progress-bar');
const progressLabel = document.getElementById('progress-label');

// Page capture and bundling both happen in the service worker so the popup and
// the toolbar/context-menu paths always extract assets the same way.
const progressPort = chrome.runtime.connect({ name: 'pagebundler-progress' });
progressPort.onMessage.addListener(message => {
  if (message?.type !== 'bundle-progress') return;
  showProgress(message);
});

function showProgress(message) {
  progressWrap.hidden = false;
  progressBar.classList.toggle('indeterminate', Boolean(message.indeterminate));
  progressBar.style.width = message.indeterminate ? '38%' : `${Math.max(0, Math.min(100, message.percent || 0))}%`;
  progressLabel.textContent = message.label || 'Working…';
}

function describe(result) {
  const notes = [
    `${result.fileCount} files included`,
    result.duplicates ? `${result.duplicates} duplicates merged` : '',
    result.skipped ? `${result.skipped} unused skipped` : '',
    result.failed ? `${result.failed} unavailable` : '',
  ];
  return notes.filter(Boolean).join(' · ') + '.';
}

button.addEventListener('click', async () => {
  button.disabled = true; statusBox.className = ''; statusBox.textContent = 'Capturing page and bundling files…'; details.hidden = true;
  progressWrap.hidden = false; progressBar.classList.add('indeterminate'); progressBar.style.width = '38%'; progressLabel.textContent = 'Capturing page…';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https?:/.test(tab.url || '')) throw new Error('This page cannot be captured. Open a regular website and try again.');
    const result = await chrome.runtime.sendMessage({ type: 'capture-and-bundle', tabId: tab.id });
    if (!result?.ok) throw new Error(result?.error || 'The ZIP could not be created.');
    statusBox.className = 'success'; statusBox.textContent = 'Your page ZIP is ready.';
    details.hidden = false; details.textContent = describe(result);
  } catch (error) {
    statusBox.className = 'error'; statusBox.textContent = error.message || 'Something went wrong.';
  } finally { button.disabled = false; }
});
