'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Every call returns {ok, data} or {ok:false, code}; the renderer unwraps it.
contextBridge.exposeInMainWorld('api', {
  svc: (method, ...args) => ipcRenderer.invoke(`svc:${method}`, ...args),
  call: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
});
