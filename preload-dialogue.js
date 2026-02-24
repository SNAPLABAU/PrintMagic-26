const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dialogue', {
  confirmPrint: (opts) => ipcRenderer.invoke('confirm-print', opts),
  stashJob: (jobId) => ipcRenderer.invoke('stash-job', jobId),
  pausePrinter: (id) => ipcRenderer.invoke('pause-printer', id),
  togglePanel: () => ipcRenderer.invoke('dialogue-toggle-panel'),
  closeDialogue: () => ipcRenderer.invoke('close-dialogue'),
  openPrinterProps: (name) => ipcRenderer.invoke('open-printer-properties', name),
  onInit: (cb) => ipcRenderer.on('init-dialogue', (e, data) => cb(data)),
  onUpdate: (cb) => ipcRenderer.on('update-dialogue', (e, data) => cb(data)),
});
