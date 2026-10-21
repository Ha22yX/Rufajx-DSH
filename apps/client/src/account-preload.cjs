const { contextBridge, ipcRenderer } = require('electron');
// The native stores use origin-scoped localStorage. A loopback port changes on
// restart, so mirror only drafts/current selection/project view per company account.
if (process.isMainFrame && typeof contextBridge.executeInMainWorld === 'function') {
  const loaded = ipcRenderer.sendSync('rufa:ui-state:load');
  if (loaded?.ok && loaded.value) {
    contextBridge.exposeInMainWorld('rufaUiState', Object.freeze({
      commit: value => {
        const result = ipcRenderer.sendSync('rufa:ui-state:commit', value);
        if (!result?.ok) throw new Error('本地草稿保存失败，请保留输入内容并重试。');
      },
    }));
    contextBridge.executeInMainWorld({ args: [loaded.value], func: snapshot => {
      const allowed = key => typeof key === 'string' && (key === 'dsh.sessions.current' || key === 'rufa.projects.view.v1'
        || /^dsh\.conversation\.[A-Za-z0-9_-]{1,160}$/.test(key));
      const storage = window.localStorage, proto = Storage.prototype;
      const set = proto.setItem, remove = proto.removeItem, clear = proto.clear;
      const keys = () => Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter(allowed);
      if (snapshot.exists) {
        for (const key of keys()) if (!Object.hasOwn(snapshot.entries, key)) remove.call(storage, key);
        for (const [key, value] of Object.entries(snapshot.entries)) if (allowed(key)) set.call(storage, key, value);
      } else {
        // Import only this already-authenticated origin, never another account/origin.
        window.rufaUiState.commit({ set: Object.fromEntries(keys().map(key => [key, storage.getItem(key)])) });
      }
      proto.setItem = function(key, value) {
        key = String(key); value = String(value);
        if (this === storage && allowed(key)) window.rufaUiState.commit({ set: { [key]: value } });
        return set.call(this, key, value);
      };
      proto.removeItem = function(key) {
        key = String(key);
        if (this === storage && allowed(key)) window.rufaUiState.commit({ remove: [key] });
        return remove.call(this, key);
      };
      proto.clear = function() {
        if (this === storage) window.rufaUiState.commit({ remove: keys() });
        return clear.call(this);
      };
    } });
  }
}
// This isolated world belongs only to the embedded Harness main frame.
// It cannot read saved passwords, company tokens, or call arbitrary shell actions.
if (process.isMainFrame) contextBridge.exposeInMainWorld('rufaAccount', Object.freeze({
  preferences: (action, input) => ipcRenderer.invoke('rufa:preferences', { action, input }),
  onPreferencesChanged: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, notice) => callback(notice);
    ipcRenderer.on('rufa:preferences-changed', listener);
    return () => ipcRenderer.removeListener('rufa:preferences-changed', listener);
  },
  fileVersions: (action, input) => ipcRenderer.invoke('rufa:file-versions', { action, input }),
  discardEmptySession: sessionId => ipcRenderer.invoke('rufa:discard-empty-session', { sessionId }),
  onWorkbenchVisibility: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, visible) => callback(visible === true);
    ipcRenderer.on('rufa:workbench-visibility', listener);
    return () => ipcRenderer.removeListener('rufa:workbench-visibility', listener);
  },
  profile: () => ipcRenderer.invoke('rufa:account-profile'),
  updateProfile: value => ipcRenderer.invoke('rufa:account-update-profile', { displayName: value?.displayName, jobTitle: value?.jobTitle }),
  onProfileChanged: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, user) => callback(user);
    ipcRenderer.on('rufa:account-profile-changed', listener);
    return () => ipcRenderer.removeListener('rufa:account-profile-changed', listener);
  },
  changePassword: async value => {
    const input = { currentPassword: value?.currentPassword, newPassword: value?.newPassword };
    try {
      const result = await ipcRenderer.invoke('rufa:account-change-password', input);
      // Let the main process retire this view only after its success reply reaches the isolated world.
      if (result.ok && typeof result.completionId === 'string') ipcRenderer.send('rufa:account-change-complete', result.completionId);
      return { ok: result.ok, value: result.value, error: result.error };
    } finally { input.currentPassword = ''; input.newPassword = ''; }
  },
}));
