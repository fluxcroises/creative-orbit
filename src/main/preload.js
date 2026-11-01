'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** API exposée à l'interface (window.orbit). Aucun accès direct à Node. */
contextBridge.exposeInMainWorld('orbit', {
  getState: () => ipcRenderer.invoke('orbit:get-state'),
  onState: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('orbit:state', listener);
    return () => ipcRenderer.removeListener('orbit:state', listener);
  },
  onNavigate: (cb) => ipcRenderer.on('orbit:navigate', (_e, view) => cb(view)),
  refresh: () => ipcRenderer.invoke('orbit:refresh'),
  install: (id) => ipcRenderer.invoke('orbit:install', id),
  uninstall: (id) => ipcRenderer.invoke('orbit:uninstall', id),
  cancel: (id) => ipcRenderer.invoke('orbit:cancel', id),
  launch: (id) => ipcRenderer.invoke('orbit:launch', id),
  updateAll: () => ipcRenderer.invoke('orbit:update-all'),
  dismiss: (id) => ipcRenderer.invoke('orbit:dismiss', id),
  setSettings: (patch) => ipcRenderer.invoke('orbit:set-settings', patch),
  setEffectiveTheme: (theme) => ipcRenderer.invoke('orbit:set-effective-theme', theme),
  openExternal: (url) => ipcRenderer.invoke('orbit:open-external', url),
  openLogs: () => ipcRenderer.invoke('orbit:open-logs'),
  checkLauncherUpdate: () => ipcRenderer.invoke('orbit:launcher-check'),
  installLauncherUpdate: () => ipcRenderer.invoke('orbit:launcher-install'),
});
