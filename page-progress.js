(() => {
  let host = null;
  let hideTimer;
  let bar;
  let label;

  function update(message) {
    if (!host) {
      host = document.createElement('div');
      host.id = 'pagebundler-progress-host';
      host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;top:16px;right:16px;width:280px;';
      const shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML = `<style>
        *{box-sizing:border-box}section{font:13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;color:#18213b;background:#fff;border:1px solid #e5e7f0;border-radius:12px;padding:14px 16px;box-shadow:0 8px 28px #14204430}
        header{display:flex;align-items:center;gap:9px;font-size:14px;font-weight:650;margin-bottom:9px}.mark{display:grid;place-items:center;width:25px;height:25px;border-radius:8px;background:#6257e8;color:white;font-weight:800}
        .track{height:6px;border-radius:8px;background:#e6e8f1;overflow:hidden}.bar{height:100%;width:0;background:#6257e8;border-radius:8px;transition:width .25s ease}.bar.indeterminate{width:38%;animation:sweep 1.2s ease-in-out infinite}@keyframes sweep{0%{transform:translateX(-110%)}50%{transform:translateX(100%)}100%{transform:translateX(270%)}}
        .label{margin-top:7px;color:#687188;font-size:11px}.close{float:right;border:0;background:none;color:#8991a2;cursor:pointer;font-size:16px;line-height:1;padding:0 0 0 8px}
      </style><section role="status" aria-live="polite"><button class="close" title="Dismiss" aria-label="Dismiss">×</button><header><span class="mark">P</span>Saving page with PageBundler</header><div class="track"><div class="bar"></div></div><div class="label">Starting…</div></section>`;
      bar = shadow.querySelector('.bar');
      label = shadow.querySelector('.label');
      shadow.querySelector('.close').addEventListener('click', () => { host.remove(); host = bar = label = null; });
      document.documentElement.appendChild(host);
    }
    clearTimeout(hideTimer);
    bar.classList.toggle('indeterminate', Boolean(message.indeterminate));
    bar.style.width = message.indeterminate ? '38%' : `${Math.max(0, Math.min(100, message.percent || 0))}%`;
    label.textContent = message.error || message.label || 'Working…';
    if (message.percent >= 100 || message.error) {
      hideTimer = setTimeout(() => { host?.remove(); host = bar = label = null; }, message.error ? 7000 : 4500);
    }
  }

  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === 'bundle-progress') update(message);
  });
})();
