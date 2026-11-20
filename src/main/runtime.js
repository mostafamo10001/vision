'use strict';
// Shared runtime state: window handle, abort control (the "stop" button), approvals, reminders.
const state = {
  shellTrustUntil: 0, approvalOpenedWindow: false, win: null, abort: new AbortController(), approvals: new Map(), approvedTasks: new Set(), seq: 0, stopSeq: 0 };

function emit(channel, ...args) {
  const w = state.win;
  if (w && !w.isDestroyed()) w.webContents.send(channel, ...args);
}
// NOTE: stopAll() swaps in a fresh controller, so signal() is only good for ONE operation: take it once at the start and keep it.
// Calling runtime.signal().aborted again later in a loop asks the NEW controller and never sees the stop.
const signal = () => state.abort.signal;
// Loops that cannot hold a signal can remember stopSeq() at their start and compare later: it changes every time the user presses stop.
const stopSeq = () => state.stopSeq;

function stopAll() {
  state.shellTrustUntil = 0;
  state.stopSeq++;
  state.abort.abort();
  state.abort = new AbortController();
  for (const a of [...state.approvals.values()]) a.finish(false, false, false, 'stopped');
  state.approvedTasks.clear();
  emit('stopped');
}

function requestApproval(desc, { taskId = null, alwaysAsk = false, shell = false } = {}) {
  if (shell && Date.now() < state.shellTrustUntil) return Promise.resolve(true); // the user said: trust PowerShell for a while
  if (!alwaysAsk && taskId && state.approvedTasks.has(taskId)) return Promise.resolve(true);
  const id = ++state.seq;
  return new Promise(resolve => {
    let timer = null;
    const finish = (ok, taskWide, trust, reason) => {
      clearTimeout(timer);
      if (!state.approvals.has(id)) return;
      state.approvals.delete(id);
      emit('approval:close', id);
      // Vision was hidden in the background and the approval itself brought it up: once everything pending is answered, tuck it away again.
      if (state.approvals.size === 0 && state.approvalOpenedWindow) setTimeout(() => { if (state.approvals.size === 0 && state.approvalOpenedWindow) { state.approvalOpenedWindow = false; const w = state.win; if (w && !w.isDestroyed()) w.hide(); } }, 250);
      if (ok && taskWide && taskId && !alwaysAsk) state.approvedTasks.add(taskId);
      if (ok && trust && shell) state.shellTrustUntil = Date.now() + 30 * 60 * 1000;
      resolve(ok ? true : (reason || false)); // true = approved, false = the user said no, 'timeout' / 'stopped' = nobody answered or the user pressed stop
    };
    timer = setTimeout(() => finish(false, false, false, 'timeout'), 90000);
    state.approvals.set(id, { finish, taskId });
    if (state.win && !state.win.isDestroyed() && !state.win.isVisible()) { state.approvalOpenedWindow = true; state.win.showInactive(); }
    emit('approval:request', { id, desc, canTaskWide: !!taskId && !alwaysAsk, shell });
  });
}
function answerApproval(id, ok, taskWide, trust) {
  if (id == null) { // hotkey: answer the oldest pending request
    const first = [...state.approvals.keys()].sort((a, b) => a - b)[0];
    if (first == null) return;
    id = first;
  }
  state.approvals.get(id)?.finish(ok, taskWide, trust);
}
// When a task ends, any approval it left behind is stale and must disappear.
function cancelTask(taskId) { for (const a of [...state.approvals.values()]) if (a.taskId === taskId) a.finish(false, false, false, 'stopped'); }

module.exports = { state, emit, signal, stopSeq, stopAll, requestApproval, answerApproval, cancelTask };
