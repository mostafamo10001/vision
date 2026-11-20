'use strict';
// The "brain": a Gemini model (thinking enabled) that sees screenshots and drives the PC with tools until the task is done.
const cfg = require('./config');
const gemini = require('./gemini');
const tools = require('./tools');
const capture = require('./capture');
const vision = require('./vision');
const prompts = require('./prompts');
const runtime = require('./runtime');
const bridge = require('./ps-bridge');
const logger = require('./log');

let counter = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
// After these, the screen probably changed, so attach a fresh screenshot.
const PASSIVE = new Set(['zoom', 'wait', 'screenshot', 'point_at', 'point_at_on_screen']); // looking again, not acting
const VISUAL = new Set(['click_on', 'click_at', 'drag', 'scroll', 'type_text', 'press_keys', 'ui_click', 'ui_set_text', 'window_action', 'open_app', 'open_url', 'open_path', 'wait', 'screenshot', 'media_control']);
// click_on / click_at wait for the screen themselves and report whether it changed. For everything else the loop watches the screen:
// it waits for the first visible change (up to this many ms), then until the screen is calm, instead of sleeping a fixed time.
const SELF_WATCHED = new Set(['click_on', 'click_at']);
const CHANGE_MS = { open_app: 3500, open_url: 3500, open_path: 2500, window_action: 800, press_keys: 700, ui_click: 900, drag: 800, media_control: 600 };
// These almost always change the screen at once, so they are not watched: a short pause is enough (fast).
const QUICK_MS = { type_text: 150, ui_set_text: 150, scroll: 250 };

const imagePart = s => ({ inlineData: { mimeType: s.mime, data: s.data } });

function pruneImages(contents, keep = 2) {
  let seen = 0;
  for (let i = contents.length - 1; i >= 0; i--) {
    const parts = contents[i].parts || [];
    for (let j = parts.length - 1; j >= 0; j--) {
      if (parts[j].inlineData) {
        if (++seen > keep) parts[j] = { text: '[older screenshot removed]' };
      }
    }
  }
}

// Most "read / identify / describe what is on screen" requests need ONE look, not a step-by-step agent run.
// A single fast-model call answers those in a few seconds; anything that needs interaction falls through to the agent.
async function quickLook(task, signal) {
  try {
    const out = await vision.ask(`REQUEST: ${task}\n\nIf the request only needs reading, identifying, counting, describing or summarising what is fully VISIBLE in this screenshot, answer it completely and concisely (plain text, no markdown). If the request contains ANY instruction to act on the screen (click, press, open, type, select, scroll, go to, find-and-click, close, play, fill in), answerable MUST be false. If it needs any clicking, typing, scrolling, opening something, another window or tab, or information that is not fully visible right now, an agent must do it instead. Reply ONLY with JSON: {"answerable": boolean, "answer": string}`, {
      kind: 'triage', text: task, json: true, signal,
      system: 'You decide whether a request can be answered purely by looking at one screenshot of the current screen.',
      validate: t => { const j = vision.parseJsonLoose(t); if (!j || typeof j.answerable !== 'boolean') throw new Error('not the JSON that was asked for'); return j; }
    });
    const j = out.value, answer = String(j.answer || '').trim();
    return j.answerable === true && answer ? answer : null;
  } catch { return null; }
}

// One short line: which window has focus and what else is open. The agent then starts from the right app instead of guessing from the picture.
async function windowContext() {
  try {
    const got = await Promise.race([
      Promise.all([bridge.call('active_window', {}, 3000), bridge.call('windows', {}, 3000)]),
      sleep(2500).then(() => null)
    ]);
    if (!got) return '';
    const [a, w] = got, list = ((w && w.windows) || []).slice(0, 12).map(x => `${String(x.title).slice(0, 50)} (${x.process})`);
    return `\nActive window: "${String((a && a.title) || '').slice(0, 80)}" (${(a && a.process) || '?'}).${list.length ? ' Open windows: ' + list.join(' | ') + '.' : ''}`;
  } catch { return ''; }
}

async function runTask(task) {
  const taskId = ++counter;
  try { return await runTaskInner(task, taskId); } finally { runtime.cancelTask(taskId); }
}
async function runTaskInner(task, taskId) {
  const signal = runtime.signal();
  const maxSteps = Math.min(Math.max(Number(cfg.get().maxSteps) || 25, 3), 60);
  const declarations = tools.declarations('worker');
  const ctx = { scope: 'worker', taskId, task };
  runtime.emit('step', { kind: 'task', text: task });
  runtime.emit('activity', { state: 'acting', text: 'Working on it…' });

  try {
    // A request that starts with an action word needs the agent anyway: skip the extra screenshot upload and model call.
    const obviousAction = /^\s*(?:please\s+|can you\s+|could you\s+)?(?:open|launch|start|run|click|press|type|close|play|pause|scroll|go to|navigate|search|install|download|save|create|delete|send|write|set|turn|switch|mute|unmute|fill|select|enter|choose|pick|toggle|tick|untick|check|uncheck|add|change|move|drag|copy|paste|rename|upload|log in|login|sign in|sign out|accept|dismiss|minimi[sz]e|maximi[sz]e|refresh|reload|go back|expand|collapse|apply|submit|book|buy|order|post)\b/i.test(task);
    const quick = obviousAction ? null : await quickLook(task, signal);
    if (quick) return quick;
    const [wctx, firstShot] = await Promise.all([windowContext(), capture.capture({ fresh: true })]);
    let shot = firstShot;
    const contents = [{ role: 'user', parts: [{ text: `TASK: ${task}\n\nThe current screen is attached (0-1000 grid).${wctx}` }, imagePart(shot)] }];
    let final = '';
    let switched = false;
    const sigs = []; // recent action signatures, to notice a loop
    let noChange = 0, notFound = 0, boost = false; // steps in a row where the screen did not react / the target was not found; boost = use the strongest model

    for (let step = 1; step <= maxSteps; step++) {
      if (signal.aborted) return 'Stopped by the user.';
      pruneImages(contents);
      let tModel = 0, tTools = 0, tWatch = 0, tShot = 0; const tStep = Date.now();
      if (!boost && (noChange >= 2 || notFound >= 2)) { boost = true; runtime.emit('step', { kind: 'info', text: 'Not making progress: switching to a stronger model' }); }
      let res;
      const tg = Date.now();
      try {
        res = await gemini.generate('worker', {
          systemInstruction: { parts: [{ text: prompts.workerSystem() }] },
          contents,
          tools: [{ functionDeclarations: declarations }],
          toolConfig: { functionCallingConfig: { mode: 'AUTO' } }
        }, { signal, preferPro: boost, onSwitch: (m, e) => { if (!switched) { switched = true; runtime.emit('step', { kind: 'info', text: `Switched model (${m}: ${e.message.slice(0, 80)})` }); } } });
      } catch (e) {
        return `ERROR: the planning model failed: ${e.message}`;
      }
      tModel = Date.now() - tg;
      const cand = res.candidates?.[0];
      if (!cand?.content?.parts?.length) {
        const why = res.promptFeedback?.blockReason || cand?.finishReason || 'empty response';
        return `ERROR: the model returned nothing (${why}).`;
      }
      contents.push(cand.content); // keep the model's exact turn (thought signatures included)

      const calls = cand.content.parts.filter(p => p.functionCall);
      const said = cand.content.parts.filter(p => p.text && !p.thought).map(p => p.text).join('').trim();
      if (!calls.length) { final = said || 'Done.'; break; }
      if (said) runtime.emit('step', { kind: 'say', text: said.slice(0, 200) });
      const fin = calls.find(c => c.functionCall.name === 'finish');
      if (fin) { final = String((fin.functionCall.args || {}).summary || said || 'Done.'); break; } // the agent said it is finished: stop right now
      // it announced it is done and only wants to look again: that is the end, not another step
      if (said && /\b(done|finished|completed|all set|here it is|is now open|has been)\b/i.test(said) && calls.every(c => PASSIVE.has(c.functionCall.name))) { final = said; break; }
      // it says the job is complete: believe it and stop, whatever else it was about to call
      if (said && said.length < 240 && /\b(?:the\s+)?(?:task|goal|job|request)\s+(?:is\s+|has been\s+|was\s+)?(?:now\s+)?(?:complete|completed|done|finished|achieved|accomplished)\b/i.test(said)) { final = said; break; }
      // the same action again and again: it is stuck in a loop
      for (const c of calls) sigs.push(c.functionCall.name + '|' + JSON.stringify(c.functionCall.args || {}));
      if (sigs.length >= 3 && new Set(sigs.slice(-3)).size === 1 && !PASSIVE.has(calls[0].functionCall.name)) { final = `I stopped because I was repeating the same action (${calls[0].functionCall.name}) without progress. ${said || ''}`.trim(); break; }

      const responseParts = [];
      let needShot = false, settle = 0, attached = null;
      const acting = calls.map(c => c.functionCall.name).filter(n => VISUAL.has(n) && !PASSIVE.has(n));
      const needWatch = acting.some(n => !SELF_WATCHED.has(n) && !QUICK_MS[n]);
      const before = needWatch ? await capture.signature().catch(() => null) : null; // what the screen looks like right before we act
      const texts = [];
      let halted = ''; // when one action in a chain fails, the rest of the chain is NOT run (so a missed click never gets typed into the wrong place)
      const tt = Date.now();
      for (const c of calls) {
        const { name, args } = c.functionCall;
        if (halted) {
          const t = `SKIPPED: not run because an earlier action in this step did not work (${halted}). Look at the screenshot and decide again.`;
          texts.push(t); responseParts.push({ functionResponse: { name, ...(c.functionCall.id ? { id: c.functionCall.id } : {}), response: { result: t } } });
          continue;
        }
        const out = await tools.invoke(name, args, ctx);
        const text = typeof out === 'string' ? out : out.text;
        texts.push(String(text));
        if (typeof out !== 'string' && out.image) attached = out.image;
        responseParts.push({ functionResponse: { name, ...(c.functionCall.id ? { id: c.functionCall.id } : {}), response: { result: text } } });
        if (VISUAL.has(name) && !String(text).startsWith('ERROR') && !String(text).startsWith('DENIED')) { needShot = true; settle = Math.max(settle, QUICK_MS[name] || 250); }
        if (String(text).startsWith('DENIED')) final = final || '';
        if (/^(ERROR|DENIED|NOT FOUND|REFUSED)/.test(String(text)) || /no visible change after the click/.test(String(text))) halted = String(text).slice(0, 60);
        if (signal.aborted) return 'Stopped by the user.';
      }
      tTools = Date.now() - tt;
      const extra = [];
      if (attached) extra.push({ text: 'Zoomed view:' }, imagePart(attached));
      let changed = null; // did the screen visibly react to what we just did? (null = unknown)
      if (needShot) {
        if (needWatch) {
          const tw = Date.now();
          const w = await capture.waitStable({ before, changeMs: Math.max(...acting.filter(n => !QUICK_MS[n]).map(n => CHANGE_MS[n] || 600)) }).catch(() => null);
          if (w) changed = w.changed;
          tWatch = Date.now() - tw;
        } else await sleep(settle);
        const selfChanged = texts.some(t => /The screen changed after the click/.test(t)), selfStill = texts.some(t => /no visible change after the click/.test(t));
        if (selfChanged) changed = true; else if (selfStill && changed !== true) changed = false;
        const ts = Date.now(); shot = await capture.capture({ fresh: false }); tShot = Date.now() - ts; extra.push({ text: 'Screen after the action:' }, imagePart(shot));
      }
      logger.log('timing', `step ${step}: model ${tModel} ms, tools ${tTools} ms, screen-wait ${tWatch} ms, screenshot ${tShot} ms, total ${Date.now() - tStep} ms [${calls.map(c => c.functionCall.name).join(',')}]${boost ? ' (strong model)' : ''}`);
      if (acting.length) { if (changed === false) noChange++; else if (changed === true) noChange = 0; }
      if (texts.some(t => /^NOT FOUND/.test(t))) notFound++; else if (acting.length && changed !== false) notFound = 0;
      if (acting.length && changed === false) extra.push({ text: noChange >= 2 ? 'NOTE: the screen has not visibly reacted to several actions in a row. Stop repeating. Use ui_list / ui_click by control name, zoom to find the exact control, a keyboard route (Tab, Enter, shortcuts), scroll to reveal it, or finish and explain exactly what blocks you. If the goal is in fact already achieved, call finish.' : 'NOTE: no visible change was detected after that action. Check the new screenshot: if it already shows the goal achieved, call finish now. If it did not work, try a different way instead of repeating it.' });
      if (notFound >= 2) extra.push({ text: 'NOTE: click_on could not find its target more than once. Use ui_list for control names, zoom into the area, scroll, or describe the target differently (position, colour, nearby text).' });
      contents.push({ role: 'user', parts: [...responseParts, ...extra] });
      if (noChange >= 5) { final = `I stopped because the screen stopped reacting to my actions. ${said || ''}`.trim(); break; }

      if (step === maxSteps) final = `I ran out of steps (${maxSteps}) before finishing. Here is where things stand: ${said || 'task incomplete'}.`;
    }
    return final || 'Done.';
  } catch (e) {
    return `ERROR: ${e.message}`;
  } finally {
    runtime.emit('activity', { state: 'idle' });
  }
}
module.exports = { runTask };
