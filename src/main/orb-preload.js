'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('orb', {
  on: (ch, cb) => { if (['level', 'mode', 'show', 'hide', 'theme'].includes(ch)) ipcRenderer.on('orb:' + ch, (_e, v) => cb(v)); }
});
