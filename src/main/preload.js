'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('clipper', {
  info: () => ipcRenderer.invoke('app:info'),
  openFile: (kind, multi = false) => ipcRenderer.invoke('file:open', kind, multi),
  describeFile: (filePath) => ipcRenderer.invoke('file:describe', filePath),
  /** Resolve a dropped File object to its path on disk. */
  pathForFile: (file) => webUtils.getPathForFile(file),
  probe: (filePath) => ipcRenderer.invoke('file:probe', filePath),
  saveDialog: (name) => ipcRenderer.invoke('file:save', name),
  reveal: (filePath) => ipcRenderer.invoke('file:reveal', filePath),
  startExport: (project) => ipcRenderer.invoke('export:start', project),
  cancelExport: () => ipcRenderer.invoke('export:cancel'),
  onProgress: (cb) => {
    const handler = (_e, p) => cb(p);
    ipcRenderer.on('export:progress', handler);
    return () => ipcRenderer.removeListener('export:progress', handler);
  },
});
