// Runs in the boot document, before React or any workspace request can paint an empty shell.
(() => {
  const html = document.documentElement;
  html.dataset.rufaStartup = 'pending';
  let finished = false, releasing = false, frame = 0, settleTimer;
  const status = message => { const node = document.getElementById('rufa-startup-status'); if (node && !finished) node.textContent = message; };
  const stall = () => {
    if (finished || releasing) return;
    html.dataset.rufaStartup = 'stalled';
    status('加载尚未完成，可以重试或进入工作台查看状态。');
    document.getElementById('rufa-startup-actions')?.removeAttribute('hidden');
    document.getElementById('rufa-startup')?.setAttribute('aria-busy', 'false');
  };
  const timeout = setTimeout(stall, 20000);
  function release(ready = true) {
    if (finished || releasing) return;
    releasing = true;
    // Let the native subscriptions commit the selected workspace/session first.
    const commit = () => {
      if (finished) return;
      cancelAnimationFrame(frame); clearTimeout(settleTimer);
      finished = true; releasing = false; clearTimeout(timeout);
      html.dataset.rufaStartup = ready ? 'ready' : 'bypassed';
      const cover = document.getElementById('rufa-startup');
      if (!cover) return;
      cover.setAttribute('aria-busy', 'false'); cover.setAttribute('aria-hidden', 'true');
      cover.inert = true; cover.dataset.leaving = '';
      const remove = () => cover.remove();
      cover.addEventListener('transitionend', remove, { once: true });
      setTimeout(remove, 260);
    };
    frame = requestAnimationFrame(() => { frame = requestAnimationFrame(commit); });
    // A hidden/minimized WebContents can pause animation frames. It must still settle.
    settleTimer = setTimeout(commit, 120);
  }
  window.__RUFA_STARTUP__ = Object.freeze({ status, ready: () => release(true), stall });
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('rufa-startup-retry')?.addEventListener('click', () => location.reload());
    document.getElementById('rufa-startup-continue')?.addEventListener('click', () => release(false));
  }, { once: true });
  window.addEventListener('pagehide', () => { clearTimeout(timeout); clearTimeout(settleTimer); cancelAnimationFrame(frame); }, { once: true });
})();
