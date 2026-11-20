// The Vision orb, drawn on a 2D canvas. Used by both the main window and the floating overlay so they always match.
// o = { rgb: [r,g,b], lvl: 0..1 audio level, mode: 'idle'|'armed'|'listening'|'speaking'|'thinking'|'acting'|'connecting'|'error', R?, cx?, cy? }
const TAU = Math.PI * 2;
const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const mix = (c, k) => c.map(v => v + (255 - v) * k);

export function drawOrb(g, W, H, t, o) {
  const rgb = o.rgb, lvl = o.lvl || 0, mode = o.mode || 'idle';
  const cx = o.cx ?? W / 2, cy = o.cy ?? H / 2, R = o.R ?? Math.min(46, H * 0.22);
  const busy = mode === 'acting' || mode === 'thinking' || mode === 'connecting', live = mode === 'listening' || mode === 'speaking';
  const spin = busy ? 2.6 : 1;
  g.save(); g.lineCap = 'round';

  // soft halo
  const halo = g.createRadialGradient(cx, cy, R * 0.5, cx, cy, R * 3.1);
  halo.addColorStop(0, rgba(rgb, 0.24 + lvl * 0.22)); halo.addColorStop(0.5, rgba(rgb, 0.07 + lvl * 0.07)); halo.addColorStop(1, rgba(rgb, 0));
  g.fillStyle = halo; g.beginPath(); g.arc(cx, cy, R * 3.1, 0, TAU); g.fill();

  // outer tick ring (slow drift)
  const rot = t / 9000 * spin;
  for (let i = 0; i < 90; i++) {
    const a = rot + i * TAU / 90, major = i % 10 === 0, r1 = R * 2.12, r2 = r1 - R * (major ? 0.16 : 0.07);
    g.beginPath(); g.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); g.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
    g.strokeStyle = rgba(rgb, major ? 0.5 : 0.2); g.lineWidth = major ? 1.6 : 1; g.stroke();
  }

  // spectrum ring: reacts to the voice (yours while listening, Vision's while speaking)
  const N = 72, rb = R * 1.58;
  for (let i = 0; i < N; i++) {
    const a = -Math.PI / 2 + i * TAU / N;
    const n = 0.5 + 0.5 * Math.sin(t / 170 + i * 1.9) * Math.sin(t / 310 + i * 0.7);
    const amp = live ? lvl * (0.25 + 0.75 * n) : busy ? 0.1 + 0.12 * n : 0.04 + 0.03 * n;
    const len = R * 0.07 + R * 0.62 * amp;
    g.beginPath(); g.moveTo(cx + Math.cos(a) * rb, cy + Math.sin(a) * rb); g.lineTo(cx + Math.cos(a) * (rb + len), cy + Math.sin(a) * (rb + len));
    g.strokeStyle = rgba(rgb, 0.3 + 0.65 * Math.min(1, amp * 1.4)); g.lineWidth = Math.max(1.3, R * 0.05); g.stroke();
  }

  // two segmented rings turning in opposite directions
  const arcs = (r, count, span, ang, w, alpha) => { for (let i = 0; i < count; i++) { const s = ang + i * TAU / count; g.beginPath(); g.arc(cx, cy, r, s, s + span); g.strokeStyle = rgba(rgb, alpha); g.lineWidth = w; g.stroke(); } };
  arcs(R * 1.30, 3, 1.35, t / 2600 * spin, Math.max(2, R * 0.075), 0.85);
  arcs(R * 1.16, 2, 0.9, -t / 1900 * spin + 1, Math.max(1.2, R * 0.04), 0.55);
  g.beginPath(); g.arc(cx, cy, R * 1.04, 0, TAU); g.strokeStyle = rgba(rgb, 0.22); g.lineWidth = 1; g.stroke();

  // when working or thinking: bright orbiting dots
  if (busy) {
    for (let k = 0; k < 3; k++) {
      const a = t / (900 + k * 330) * (k % 2 ? -1 : 1) + k * 2.1, r = R * (1.9 - k * 0.12);
      g.beginPath(); g.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, Math.max(1.8, R * 0.06), 0, TAU);
      g.fillStyle = rgba(mix(rgb, 0.6), 0.95); g.shadowColor = rgba(rgb, 1); g.shadowBlur = 10; g.fill(); g.shadowBlur = 0;
    }
  }

  // glowing core sphere
  const cr = R * (0.8 + lvl * 0.2);
  const core = g.createRadialGradient(cx, cy - cr * 0.3, cr * 0.1, cx, cy, cr);
  core.addColorStop(0, rgba(mix(rgb, 0.85), 1)); core.addColorStop(0.45, rgba(rgb, 0.95)); core.addColorStop(1, rgba(rgb, 0.18));
  g.shadowColor = rgba(rgb, 1); g.shadowBlur = R * (0.7 + lvl * 0.9);
  g.beginPath(); g.arc(cx, cy, cr, 0, TAU); g.fillStyle = core; g.fill(); g.shadowBlur = 0;

  // the gem from the Vision logo, at the heart of the orb
  const s = R * (0.34 + lvl * 0.07);
  const P = [[-0.5, -0.78], [0.5, -0.78], [0.92, -0.22], [0.58, 0.62], [0, 1.0], [-0.58, 0.62], [-0.92, -0.22]].map(([x, y]) => [cx + x * s, cy + y * s - s * 0.06]);
  const gem = g.createLinearGradient(cx - s, cy - s, cx + s, cy + s);
  gem.addColorStop(0, 'rgba(255,255,255,0.98)'); gem.addColorStop(1, rgba(mix(rgb, 0.55), 0.95));
  g.beginPath(); P.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.fillStyle = gem; g.fill();
  g.strokeStyle = 'rgba(255,255,255,0.75)'; g.lineWidth = Math.max(1, R * 0.03); g.stroke();
  g.beginPath(); g.moveTo(P[0][0] + s * 0.3, P[0][1]); g.lineTo(cx, cy + s * 0.05); g.lineTo(P[1][0] - s * 0.3, P[1][1]); g.moveTo(cx, cy + s * 0.05); g.lineTo(P[4][0], P[4][1]);
  g.strokeStyle = rgba(rgb, 0.5); g.lineWidth = Math.max(1, R * 0.025); g.stroke();
  g.restore();
}
