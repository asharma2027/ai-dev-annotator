const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('annotatorDesktop', {
  chooseFolder() {
    return ipcRenderer.invoke('dashboard:choose-folder');
  },
  getDashboardToken() {
    return ipcRenderer.invoke('dashboard:get-token');
  },
  finishClosePreparation(ready) {
    ipcRenderer.send('dashboard:close-prepared', { ready: ready === true });
  },
  onPrepareClose(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = () => callback();
    ipcRenderer.on('dashboard:prepare-close', listener);
    return () => ipcRenderer.removeListener('dashboard:prepare-close', listener);
  },
  onClosePreparationCancelled(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = () => callback();
    ipcRenderer.on('dashboard:close-cancelled', listener);
    return () => ipcRenderer.removeListener('dashboard:close-cancelled', listener);
  },
});
