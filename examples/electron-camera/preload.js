// 预加载脚本：在隔离上下文中向渲染进程暴露最小、明确的 API。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  onFrame: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('frame-data', listener);
    return () => ipcRenderer.removeListener('frame-data', listener);
  },
  onStatus: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('status', listener);
    return () => ipcRenderer.removeListener('status', listener);
  },
  getStats: () => ipcRenderer.invoke('get-stats'),
  getServerInfo: () => ipcRenderer.invoke('get-server-info'),
  setPaused: (value) => ipcRenderer.send('set-paused', value),
});
