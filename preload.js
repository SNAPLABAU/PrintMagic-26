const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Folders
  selectFolder: (type) => ipcRenderer.invoke('select-folder', type),
  selectWorkspace: () => ipcRenderer.invoke('select-workspace'),
  openFolder: (path) => ipcRenderer.invoke('open-folder', path),
  getConfig: () => ipcRenderer.invoke('get-config'),
  updateConfig: (updates) => ipcRenderer.invoke('update-config', updates),
  getFolderCounts: () => ipcRenderer.invoke('get-folder-counts'),
  toggleWatcher: () => ipcRenderer.invoke('toggle-watcher'),

  // Printers
  getSystemPrinters: () => ipcRenderer.invoke('get-system-printers'),
  getPrinterPool: () => ipcRenderer.invoke('get-printer-pool'),
  addPrinter: (printer) => ipcRenderer.invoke('add-printer', printer),
  removePrinter: (id) => ipcRenderer.invoke('remove-printer', id),
  updatePrinter: (printer) => ipcRenderer.invoke('update-printer', printer),
  reorderPrinters: (order) => ipcRenderer.invoke('reorder-printers', order),
  togglePrinter: (id) => ipcRenderer.invoke('toggle-printer', id),

  // Queue
  getQueueState: () => ipcRenderer.invoke('get-queue-state'),
  clearHistory: () => ipcRenderer.invoke('clear-history'),
  retryJob: (id) => ipcRenderer.invoke('retry-job', id),

  // Stash
  getStashFiles: () => ipcRenderer.invoke('get-stash-files'),
  reprintStash: (filename) => ipcRenderer.invoke('reprint-stash', filename),
  deleteStash: (filename) => ipcRenderer.invoke('delete-stash', filename),

  // Printer properties (Windows native driver dialog)
  openPrinterProperties: (name) => ipcRenderer.invoke('open-printer-properties', name),

  // Printer Profiles
  getPrinterProfiles: ()          => ipcRenderer.invoke('get-printer-profiles'),
  savePrinterProfile: (profile)   => ipcRenderer.invoke('save-printer-profile', profile),
  deletePrinterProfile: (id)      => ipcRenderer.invoke('delete-printer-profile', id),
  assignProfile: (printerId, profileId) => ipcRenderer.invoke('assign-profile', { printerId, profileId }),

  // Events
  on: (channel, cb) => {
    const valid = [
      'queue-updated', 'printers-updated', 'watcher-status'
    ];
    if (valid.includes(channel)) ipcRenderer.on(channel, (e, data) => cb(data));
  },
  off: (channel, cb) => ipcRenderer.removeListener(channel, cb)
});
