// Records the microphone (or the sound playing on the PC) as 16 kHz mono 16-bit audio and streams it,
// about once a second, to the main process, which writes it to disk. Nothing is sent to Gemini while recording.
export class Recorder {
  constructor(send) { this.send = send; this.active = false; this.cur = null; }

  async start(source) {
    if (this.active) return;
    let stream;
    if (source === 'system') {
      // The main process answers this request with the system "loopback" audio (what you hear from the speakers).
      stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
      stream.getVideoTracks().forEach(t => t.stop());
      if (!stream.getAudioTracks().length) throw new Error('Windows did not provide the system audio to record.');
    } else {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    }
    const ctx = new AudioContext({ sampleRate: 16000 });
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    await ctx.audioWorklet.addModule('mic-worklet.js');
    const src = ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
    const node = new AudioWorkletNode(ctx, 'mic-processor', { channelCount: 1, channelCountMode: 'explicit' }); // mix stereo down to mono
    const mute = ctx.createGain(); mute.gain.value = 0;
    let parts = [], bytes = 0;
    const flush = () => {
      if (!bytes) return;
      const out = new Uint8Array(bytes); let o = 0;
      for (const p of parts) { out.set(new Uint8Array(p), o); o += p.byteLength; }
      this.send(out.buffer); parts = []; bytes = 0;
    };
    node.port.onmessage = e => { parts.push(e.data.pcm); bytes += e.data.pcm.byteLength; if (bytes >= 32000) flush(); }; // ~1 second per message
    src.connect(node); node.connect(mute); mute.connect(ctx.destination);
    this.cur = { flush, close() { try { node.port.onmessage = null; src.disconnect(); stream.getTracks().forEach(t => t.stop()); ctx.close(); } catch {} } };
    this.active = true;
  }

  stop() { if (!this.cur) return; this.cur.flush(); this.cur.close(); this.cur = null; this.active = false; }
}
