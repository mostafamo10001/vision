// Gemini Live API client: streaming mic -> model, model audio -> speakers, tool calls, reconnection.
const WS_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
// Google's docs show two slightly different setup shapes; try both until one is accepted, and remember the winner.
const VARIANTS = [
  { key: 'config', flat: true }, { key: 'setup', flat: false }, { key: 'setup', flat: true }, { key: 'config', flat: false }
];
const sleep = ms => new Promise(r => setTimeout(r, ms));

function b64(buf) {
  const bytes = new Uint8Array(buf); let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function parse(data) {
  try { return JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data)); } catch { return null; }
}

class Player {
  constructor() {
    this.ctx = new AudioContext({ sampleRate: 24000 });
    this.analyser = this.ctx.createAnalyser(); this.analyser.fftSize = 512;
    this.analyser.connect(this.ctx.destination);
    this.data = new Uint8Array(512); this.next = 0; this.sources = new Set();
  }
  enqueue(b64data) {
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const bin = atob(b64data), n = bin.length >> 1, f = new Float32Array(n);
    for (let i = 0; i < n; i++) { let v = bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8); if (v & 0x8000) v -= 0x10000; f[i] = v / 32768; }
    const buf = this.ctx.createBuffer(1, n, 24000); buf.copyToChannel(f, 0);
    const src = this.ctx.createBufferSource(); src.buffer = buf; src.connect(this.analyser);
    const at = Math.max(this.next, this.ctx.currentTime + 0.03); src.start(at); this.next = at + buf.duration;
    this.sources.add(src); src.onended = () => this.sources.delete(src);
  }
  flush() { for (const s of this.sources) { s.onended = null; try { s.stop(); } catch {} } this.sources.clear(); this.next = 0; }
  get playing() { return this.sources.size > 0; }
  level() {
    if (!this.playing) return 0;
    this.analyser.getByteTimeDomainData(this.data); let s = 0;
    for (const v of this.data) { const x = (v - 128) / 128; s += x * x; }
    return Math.min(1, Math.sqrt(s / this.data.length) * 3);
  }
  close() { this.flush(); try { this.ctx.close(); } catch {} }
}

async function startMic(onChunk) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: false } });
  let ctx = null, node = null, src = null;
  const stop = () => { try { if (node) node.port.onmessage = null; src && src.disconnect(); } catch {} try { stream.getTracks().forEach(t => t.stop()); } catch {} try { ctx && ctx.close(); } catch {} };
  try {
    ctx = new AudioContext({ sampleRate: 16000 });
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    await ctx.audioWorklet.addModule('mic-worklet.js');
    src = ctx.createMediaStreamSource(stream);
    node = new AudioWorkletNode(ctx, 'mic-processor');
    const mute = ctx.createGain(); mute.gain.value = 0;
    node.port.onmessage = e => onChunk(e.data.pcm, e.data.rms);
    src.connect(node); node.connect(mute); mute.connect(ctx.destination);
  } catch (e) { stop(); throw e; } // do not leave the microphone open when setting it up failed
  return { stop };
}

export class LiveClient {
  constructor(opts, cb) {
    this.o = opts; this.cb = cb || {};
    this.ws = null; this.handle = null; this.closing = false; this.reconnecting = false;
    this.model = null; this.variant = null; this.lean = false;
    this.player = null; this.mic = null; this.micLevel = 0; this.turnPcm = []; this.lastVoiceAt = 0; this.pendingTools = 0; this.cancelers = new Set(); this.stoppedAt = 0;
  }
  get connected() { return !!this.ws && this.ws.readyState === WebSocket.OPEN; }
  get speaking() { return !!this.player?.playing; }
  get busy() { return this.pendingTools > 0; }
  outLevel() { return this.player ? this.player.level() : 0; }

  _setup(model, variant, lean) {
    const o = this.o;
    const gen = { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: o.voice } } } };
    const base = {
      model: `models/${model}`, systemInstruction: { parts: [{ text: o.systemInstruction }] },
      tools: [{ functionDeclarations: o.tools }], inputAudioTranscription: {}, outputAudioTranscription: {}
    };
    if (!lean) base.realtimeInputConfig = { automaticActivityDetection: { silenceDurationMs: o.silenceMs || 2500 } };
    if (!lean) { base.contextWindowCompression = { slidingWindow: {} }; base.sessionResumption = this.handle ? { handle: this.handle } : {}; }
    return { [variant.key]: variant.flat ? { ...base, ...gen } : { ...base, generationConfig: gen } };
  }

  _attempt(model, variant, lean) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${WS_URL}?key=${encodeURIComponent(this.o.apiKey)}`);
      ws.binaryType = 'arraybuffer';
      let settled = false;
      const fail = e => { if (settled) return; settled = true; clearTimeout(timer); try { ws.close(); } catch {} reject(e); };
      const timer = setTimeout(() => fail(new Error('Timed out connecting to Gemini Live.')), 15000);
      ws.onopen = () => ws.send(JSON.stringify(this._setup(model, variant, lean)));
      ws.onerror = () => {};
      ws.onclose = ev => fail(Object.assign(new Error(ev.reason || `Connection closed (code ${ev.code})`), { code: ev.code }));
      ws.onmessage = ev => {
        const m = parse(ev.data);
        if (settled || !m || !m.setupComplete) return;
        settled = true; clearTimeout(timer);
        if (this.closing) { ws.onclose = null; try { ws.close(); } catch {} reject(new Error('Cancelled')); return; } // the user pressed stop while this was still connecting
        const old = this.ws; this.ws = ws; this.model = model; this.variant = variant; this.lean = lean;
        if (old && old !== ws) { old.onmessage = null; old.onclose = null; try { old.close(); } catch {} }
        ws.onmessage = e2 => this._onMessage(parse(e2.data));
        ws.onclose = e2 => this._onClose(e2);
        resolve();
      };
    });
  }

  async connect() {
    let preferred = 0; try { preferred = Number(localStorage.getItem('jarvis.variant')) || 0; } catch {}
    const order = [...VARIANTS.keys()].sort((a, b) => (a === preferred ? -1 : b === preferred ? 1 : a - b));
    let lastErr = null, up = false;
    search: for (const model of this.o.models) {
      const tries = [...order.map(i => [VARIANTS[i], false]), [VARIANTS[1], true], [VARIANTS[0], true]];
      for (const [variant, lean] of tries) {
        try {
          await this._attempt(model, variant, lean);
          try { localStorage.setItem('jarvis.variant', String(VARIANTS.indexOf(variant))); } catch {}
          this.cb.onModel?.(model, lean);
          up = true; break search;
        } catch (e) {
          lastErr = e;
          if (this.closing) throw e;
          if (/api key|permission|denied|quota|exhausted|billing|unauthenticated/i.test(e.message)) throw e;
          if (/not found|not supported|is not available|invalid model/i.test(e.message)) break; // try next model
        }
      }
    }
    if (!up) throw lastErr || new Error('Could not connect.');
    // Microphone setup happens once, AFTER the connection is up. (Before, a microphone failure made the loop above open a new
    // connection and a new audio player for every setup variant, and a microphone call that never returned hung the whole start.)
    try {
      await Promise.race([this._startAudio(), sleep(12000).then(() => { throw new Error('The microphone did not start (NotReadable). Check that it is plugged in and not used by another app.'); })]);
    } catch (e) { this.close(); throw e; }
  }

  async _startAudio() {
    this.player?.close(); this.player = new Player();
    let ready = !this.o.getPreroll;
    const sendPcm = (pcm, keepAlive) => {
      this._send({ realtimeInput: { audio: { data: b64(pcm), mimeType: 'audio/pcm;rate=16000' } } });
      if (!keepAlive) { this.turnPcm.push(pcm); if (this.turnPcm.length > 750) this.turnPcm.shift(); } // keep this turn's audio (at most 30 s) for the accurate transcript
    };
    // Silence gate: only upload audio while someone is talking (plus a short lead-in, and a tail as long as the silence-wait
    // setting so Gemini can still tell that the turn is over). Quiet rooms upload almost nothing; a noisy room just keeps the gate open.
    const hang = Math.ceil(((this.o.silenceMs || 2500) + 800) / 40), PRE = 15; // 40 ms chunks
    const ring = []; let vrun = 0, nf = 0.01, run = 0, open = false, quiet = 0, lastSent = Date.now();
    const gate = (pcm, rms) => {
      const voiced = rms > Math.max(nf * 2.2, 0.006);
      vrun = voiced ? vrun + 1 : 0; // a cough or a click is not speech: it takes about a tenth of a second of sound
      if (vrun >= 3 && !this.player?.playing) this.lastVoiceAt = Date.now(); // for the orb: you are talking right now
      if (!open) {
        nf = Math.min(0.03, nf * 0.97 + rms * 0.03);
        ring.push(pcm); if (ring.length > PRE) ring.shift();
        run = voiced ? run + 1 : 0;
        if (run >= 2) { open = true; quiet = 0; run = 0; for (const c of ring) sendPcm(c); ring.length = 0; lastSent = Date.now(); }
        else if (Date.now() - lastSent > 10000) { sendPcm(pcm, true); lastSent = Date.now(); } // tiny keep-alive so the connection never looks dead
      } else {
        sendPcm(pcm); lastSent = Date.now();
        if (voiced) quiet = 0; else if (++quiet >= hang) { open = false; ring.length = 0; }
      }
    };
    const mic = await startMic((pcm, rms) => {
      this.micLevel = rms;
      if (!ready || !this.connected) return; // until the backlog is replayed, live chunks overlap it and are dropped
      if (this.o.halfDuplex && this.player.playing) return;
      gate(pcm, rms);
    });
    if (this.closing) { mic.stop(); return; } // stopped while the microphone was starting
    this.mic = mic;
    if (!ready) { // replay what the wake listener heard after "Hey Vision", then continue live
      try { for (const pcm of this.o.getPreroll() || []) sendPcm(pcm); } catch {}
      ready = true;
    }
  }

  // The network came back: a socket that died silently (Wi-Fi switch, sleep, VPN) can still look open. Closing it makes the normal reconnect run.
  takeTurnAudio() { const a = this.turnPcm; this.turnPcm = []; return a; } // everything sent since the last call = what you just said

  nudge() { if (this.connected && !this.reconnecting && !this.closing) { try { this.ws.close(); } catch {} } }

  _send(obj) { if (this.connected) this.ws.send(JSON.stringify(obj)); }
  sendText(text) { this._send({ realtimeInput: { text } }); }

  _onClose(ev) {
    if (this.closing) return;
    this._reconnect(ev.reason || `code ${ev.code}`);
  }
  async _reconnect(reason) {
    if (this.closing || this.reconnecting) return;
    this.reconnecting = true; this.cb.onState?.('reconnecting');
    for (let i = 0; i < 3 && !this.closing; i++) {
      try { await this._attempt(this.model, this.variant, this.lean); this.reconnecting = false; this.cb.onState?.('listening'); return; }
      catch { await sleep(800 * (i + 1)); }
    }
    this.reconnecting = false;
    if (!this.closing) this._finish('Connection lost: ' + reason);
  }
  _finish(reason) { this.close(); this.cb.onClose?.(reason); }

  _onMessage(m) {
    if (!m) return;
    if (m.sessionResumptionUpdate?.newHandle) this.handle = m.sessionResumptionUpdate.newHandle;
    if (m.goAway) { this._reconnect('server asked to reconnect'); }
    const sc = m.serverContent;
    if (sc) {
      if (sc.interrupted) { this.player?.flush(); this.cb.onInterrupted?.(); }
      if (sc.inputTranscription?.text) this.cb.onUser?.(sc.inputTranscription.text);
      if (sc.outputTranscription?.text) this.cb.onAssistant?.(sc.outputTranscription.text);
      for (const p of sc.modelTurn?.parts || []) {
        if (p.inlineData?.data && /audio/i.test(p.inlineData.mimeType || 'audio')) { this.player?.enqueue(p.inlineData.data); this.cb.onAudio?.(); }
      }
      if (sc.turnComplete) this.cb.onTurnComplete?.();
    }
    if (m.toolCall?.functionCalls?.length) this._handleTools(m.toolCall.functionCalls);
  }

  async _handleTools(calls) {
    this.pendingTools++;
    this.cb.onTool?.(calls);
    const batchStart = Date.now(), results = [];
    for (const c of calls) {
      let out;
      if (this.stoppedAt >= batchStart) out = 'STOPPED by the user before this ran. Do not retry; ask what they want next.';
      else if (this.cb.allowTool && !(await this.cb.allowTool(c.name, c.args || {}))) out = 'REFUSED: the user did not say "transcribe" or "start transcribing", so recording was NOT started. Do not retry and do not mention this; just carry on with the conversation normally.';
      else {
        let cancel, timer;
        const cancelled = new Promise(res => { cancel = () => res('STOPPED by the user. Do not retry it; briefly acknowledge and ask what they want next.'); this.cancelers.add(cancel); });
        const timedOut = new Promise(res => { timer = setTimeout(() => res('ERROR: that took too long and was given up on.'), c.name === 'do_task' ? 180000 : 75000); });
        try { out = await Promise.race([window.jarvis.invokeTool(c.name, c.args || {}), cancelled, timedOut]); }
        catch (e) { out = 'ERROR: ' + e.message; }
        finally { clearTimeout(timer); this.cancelers.delete(cancel); }
      }
      let text = String(out);
      if (!/^(STOPPED|DENIED|REFUSED|ALREADY|TASK COMPLETE|TASK NOT COMPLETED)/.test(text)) { // remind the model what the user actually asked for, so a multi-part request is not dropped after part one
        const req = this.cb.lastRequest ? this.cb.lastRequest() : '';
        text += `\n[Keep going until the user's whole request is done${req ? `: "${String(req).slice(0, 280)}"` : ''}. If any part is still left, call the next tool right now in this same turn; never stop or wait for the user between steps. When everything is done, say the result in one short sentence.]`;
      }
      results.push({ id: c.id, name: c.name, response: { result: text } });
    }
    this.pendingTools--;
    this._send({ toolResponse: { functionResponses: results } });
  }
  // Unblock the model right now, whatever the running tool is doing (the real work is aborted separately in the main process).
  stopTools() { this.stoppedAt = Date.now(); for (const f of [...this.cancelers]) f(); }

  close() {
    this.closing = true;
    this.mic?.stop(); this.mic = null;
    this.player?.close(); this.player = null;
    try { this.ws && (this.ws.onclose = null, this.ws.close()); } catch {}
    this.ws = null;
  }
}
