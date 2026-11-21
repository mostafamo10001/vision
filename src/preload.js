'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const on = (channel, cb) => { const h = (_e, ...a) => cb(...a); ipcRenderer.on(channel, h); return () => ipcRenderer.removeListener(channel, h); };
contextBridge.exposeInMainWorld('jarvis', {
  getConfig: () => ipcRenderer.invoke('cfg:get'),
  setConfig: patch => ipcRenderer.invoke('cfg:set', patch),
  setApiKey: key => ipcRenderer.invoke('cfg:setKey', key),
  refreshModels: () => ipcRenderer.invoke('models:refresh'),
  clearMemory: () => ipcRenderer.invoke('memory:clear'),
  forgetItem: (kind, key) => ipcRenderer.invoke('memory:forget', { kind, key }),
  wakeCheck: b64 => ipcRenderer.invoke('wake:check', b64),
  transcribeTurn: b64 => ipcRenderer.invoke('dictate:turn', b64),
  liveSetup: () => ipcRenderer.invoke('live:setup'),
  invokeTool: (name, args) => ipcRenderer.invoke('tool:invoke', { name, args }),
  answerApproval: (id, ok, taskWide, trust) => ipcRenderer.send('approval:answer', { id, ok, taskWide, trust }),
  stopAll: () => ipcRenderer.send('stop'),
  recChunk: buf => ipcRenderer.send('rec:chunk', buf),
  recDone: () => ipcRenderer.send('rec:done'),
  recError: m => ipcRenderer.send('rec:error', m),
  setTheme: t => ipcRenderer.send('theme:set', t),
  localWake: on => ipcRenderer.send('wake:local', !!on),
  wakeTest: () => ipcRenderer.invoke('wake:test'),
  runDiagnostics: () => ipcRenderer.invoke('diagnostics:run'),
  orb: (mode, level) => ipcRenderer.send('orb:level', { mode, level }),
  windowControl: action => ipcRenderer.send('win:ctl', action),
  on
});
