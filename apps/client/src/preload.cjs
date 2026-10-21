const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('rufa', Object.freeze({
  call: (action, input) => ipcRenderer.invoke('rufa:command', action, input),
  onState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('rufa:state', listener);
    return () => ipcRenderer.removeListener('rufa:state', listener);
  },
}));
