// Always-on wake word listener: local voice-activity detection cuts the mic into short utterances,
// each utterance is checked by a cheap Gemini model for "Hey Vision" / "Okay Vision".
// Audio spoken after the wake phrase is buffered so nothing is lost while the voice session connects.
const MAX_SEGMENT_CHUNKS = 175;   // 7 s (chunks are 40 ms)
const END_SILENCE_CHUNKS = 15;    // 600 ms of quiet ends an utterance
const PREROLL_CHUNKS = 8;         // keep 320 ms before speech starts
const MIN_VOICED_CHUNKS = 8;      // ignore blips shorter than ~320 ms
const MAX_CHECKS_PER_MIN = 20;    // protects quota in noisy rooms

function b64(buf) {
  const bytes = new Uint8Array(buf); let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function wavBase64(chunks) {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(44 + total), v = new DataView(out.buffer);
  const str = (o, t) => { for (let i = 0; i < t.length; i++) out[o + i] = t.charCodeAt(i); };
  str(0, 'RIFF'); v.setUint32(4, 36 + total, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, total, true);
  let off = 44; for (const c of chunks) { out.set(new Uint8Array(c), off); off += c.byteLength; }
  return b64(out.buffer);
}

export class WakeListener {
  constructor(o) { this.o = o; this.running = false; this.starting = false; this.level = 0; this._reset(); this.stamps = []; }

  _reset() {
    this.seq = 0; this.ring = []; this.nf = 0.01; this.run = 0; this.inSpeech = false; this.silence = 0;
    this.voiced = 0; this.segStart = 0; this.wakeEndSeq = 0; this.busy = false; this.pending = null; this.locked = false;
  }

  async start() {
    if (this.running || this.starting) return;
    this.starting = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: false } });
      const ctx = new AudioContext({ sampleRate: 16000 });
      if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
      await ctx.audioWorklet.addModule('mic-worklet.js');
      const src = ctx.createMediaStreamSource(stream), node = new AudioWorkletNode(ctx, 'mic-processor');
      const mute = ctx.createGain(); mute.gain.value = 0;
      node.port.onmessage = e => this._onChunk(e.data.pcm, e.data.rms);
      src.connect(node); node.connect(mute); mute.connect(ctx.destination);
      this.mic = { stop() { try { node.port.onmessage = null; src.disconnect(); stream.getTracks().forEach(t => t.stop()); ctx.close(); } catch {} } };
      this._reset(); this.running = true;
    } finally { this.starting = false; }
  }

  rearm() { this.locked = false; } // call if starting the voice session failed

  stop() { this.running = false; this.mic?.stop(); this.mic = null; this.level = 0; this._reset(); }

  // Audio recorded after the wake phrase ended (the user's command, possibly still being spoken).
  takeBacklog() { return this.ring.filter(c => c.seq > this.wakeEndSeq).map(c => c.pcm); }

  _onChunk(pcm, rms) {
    const seq = ++this.seq;
    this.ring.push({ seq, pcm }); if (this.ring.length > 250) this.ring.shift();
    this.level = rms;
    const thr = Math.max(this.nf * 2.5, 0.010), voiced = rms > thr;
    if (!this.inSpeech) {
      this.nf = Math.min(0.03, this.nf * 0.97 + rms * 0.03);
      if (voiced) {
        if (++this.run >= 2) { this.inSpeech = true; this.silence = 0; this.voiced = this.run; this.segStart = seq - PREROLL_CHUNKS - this.run; }
      } else this.run = 0;
    } else {
      if (voiced) { this.silence = 0; this.voiced++; } else this.silence++;
      if (this.silence >= END_SILENCE_CHUNKS || seq - this.segStart >= MAX_SEGMENT_CHUNKS) this._endSegment(seq);
    }
  }

  _endSegment(endSeq) {
    const ok = this.voiced >= MIN_VOICED_CHUNKS;
    const chunks = this.ring.filter(c => c.seq > this.segStart && c.seq <= endSeq).map(c => c.pcm);
    this.inSpeech = false; this.run = 0; this.silence = 0; this.voiced = 0;
    if (ok && chunks.length) this._check(wavBase64(chunks), endSeq);
  }

  async _check(wav, endSeq) {
    if (this.locked) return; // a wake word was already accepted; keep the buffered audio intact
    if (this.busy) { this.pending = { wav, endSeq }; return; }
    const now = Date.now(); this.stamps = this.stamps.filter(t => now - t < 60000);
    if (this.stamps.length >= MAX_CHECKS_PER_MIN) return;
    this.stamps.push(now); this.busy = true;
    try {
      const r = await this.o.check(wav);
      if (r && r.wake && this.running) { this.pending = null; this.locked = true; this.wakeEndSeq = endSeq; this.o.onWake({ command: r.command || '' }); }
    } catch (e) { this.o.onError?.(e); }
    finally {
      this.busy = false;
      if (this.pending && this.running) { const p = this.pending; this.pending = null; this._check(p.wav, p.endSeq); }
    }
  }
}
