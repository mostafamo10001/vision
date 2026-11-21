// The Vision orb, drawn on a 2D canvas. Used by both the main window and the floating overlay so they always match.
// o = { rgb: [r,g,b], lvl: 0..1 audio level, mode: 'idle'|'armed'|'listening'|'speaking'|'thinking'|'acting'|'connecting'|'error', R?, cx?, cy? }
// v5 "J.A.R.V.I.S. HUD": concentric instrument rings in one glowing colour, like the interface from the Iron Man / Avengers films.
//   centre: a bright reactor core.  Then, going outward: a fine ring with sweeping arcs, a thick segmented ring,
//   a ring of voice bars that spike when someone speaks, a ring of dots, long counter-rotating arcs, and a radar-style tick ring.
// Calm: everything turns slowly. Talking: the voice ring moves and the core swells. Working: the rings spin up and the segments chase each other.
const TAU = Math.PI * 2;
const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const mix = (c, k) => c.map(v => v + (255 - v) * k);

export function drawOrb(g, W, H, t, o) {
  const rgb = o.rgb, lvl = o.lvl || 0, mode = o.mode || 'idle';
  const cx = o.cx ?? W / 2, cy = o.cy ?? H / 2, R = o.R ?? Math.min(50, H * 0.22);
  const busy = mode === 'acting' || mode === 'thinking' || mode === 'connecting', live = mode === 'listening' || mode === 'speaking';
  const calm = !live && !busy;
  const c = rgb, hi = mix(rgb, 0.55), speed = busy ? 3.4 : 1; // working = everything spins faster
  const turn = ms => (t / ms) * TAU * speed;

  g.save(); g.lineCap = 'butt'; g.lineJoin = 'round';
  const arc = (r, a0, a1, w, col, al, glow) => { g.beginPath(); g.arc(cx, cy, r, a0, a1); g.strokeStyle = rgba(col, al); g.lineWidth = w; g.shadowColor = rgba(col, 0.9); g.shadowBlur = glow || 0; g.stroke(); g.shadowBlur = 0; };
  const dot = (x, y, r, col, al) => { g.beginPath(); g.arc(x, y, r, 0, TAU); g.fillStyle = rgba(col, al); g.fill(); };

  // soft glow behind everything
  const halo = g.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * 2.3);
  halo.addColorStop(0, rgba(c, 0.20 + lvl * 0.22)); halo.addColorStop(0.55, rgba(c, 0.05 + lvl * 0.06)); halo.addColorStop(1, rgba(c, 0));
  g.fillStyle = halo; g.beginPath(); g.arc(cx, cy, R * 2.3, 0, TAU); g.fill();
  g.globalCompositeOperation = 'lighter';

  // 1. reactor core: a bright disc inside a thin ring
  const cr = R * (0.34 + lvl * 0.1 + (busy ? 0.03 * Math.sin(t / 200) : 0.015 * Math.sin(t / 900)));
  const core = g.createRadialGradient(cx, cy, 0, cx, cy, cr);
  core.addColorStop(0, 'rgba(255,255,255,0.95)'); core.addColorStop(0.45, rgba(hi, 0.85)); core.addColorStop(1, rgba(c, 0.25));
  g.shadowColor = rgba(c, 1); g.shadowBlur = R * (0.45 + lvl * 0.7);
  g.fillStyle = core; g.beginPath(); g.arc(cx, cy, cr, 0, TAU); g.fill(); g.shadowBlur = 0;
  arc(cr * 1.28, 0, TAU, 1.2, hi, 0.75);

  // 2. fine ring with three short bright arcs sweeping the other way
  const r2 = R * 0.66;
  arc(r2, 0, TAU, 1, c, 0.35);
  for (let i = 0; i < 3; i++) { const a = -turn(5200) + i * TAU / 3; arc(r2, a, a + 0.55, 2.2, hi, 0.95, 6); }

  // 3. thick segmented ring (when working the segments light up one after another)
  const r3 = R * 0.9, segs = 6, gap = 0.16, base = turn(16000);
  for (let i = 0; i < segs; i++) {
    const a0 = base + i * TAU / segs + gap / 2, a1 = base + (i + 1) * TAU / segs - gap / 2;
    const chase = busy ? 0.25 + 0.75 * (0.5 + 0.5 * Math.sin(t / 170 - i * 1.1)) : (i % 2 ? 0.5 : 0.78) + lvl * 0.2;
    arc(r3, a0, a1, R * 0.12, c, Math.min(1, chase), 5);
  }
  arc(r3 - R * 0.1, 0, TAU, 1, c, 0.22);

  // 4. voice ring: fine bars that stand up with the voice (a quiet ring of dashes when nobody is talking)
  const r4 = R * 1.08, bars = 80, spec = live ? 0.12 + lvl * 1.1 : busy ? 0.10 + 0.07 * Math.sin(t / 240) : 0.02;
  g.lineWidth = Math.max(1.2, R * 0.032);
  for (let i = 0; i < bars; i++) {
    const a = i * TAU / bars;
    const n = 0.5 + 0.5 * (Math.sin(i * 0.9 + t / 190) * 0.5 + Math.sin(i * 2.1 - t / 310) * 0.3 + Math.sin(i * 3.7 + t / 130) * 0.2);
    const len = R * (0.035 + 0.3 * spec * n);
    g.beginPath(); g.moveTo(cx + Math.cos(a) * r4, cy + Math.sin(a) * r4); g.lineTo(cx + Math.cos(a) * (r4 + len), cy + Math.sin(a) * (r4 + len));
    g.strokeStyle = rgba(mix(c, 0.2 * n), (calm ? 0.35 : 0.3 + 0.6 * n)); g.stroke();
  }

  // 5. ring of dots, slowly turning
  const r5 = R * 1.42, rot5 = turn(24000);
  arc(r5, 0, TAU, 1, c, 0.22);
  for (let i = 0; i < 12; i++) { const a = rot5 + i * TAU / 12; dot(cx + Math.cos(a) * r5, cy + Math.sin(a) * r5, i % 3 === 0 ? 2.1 : 1.3, hi, i % 3 === 0 ? 0.95 : 0.55); }

  // 6. long arcs turning against each other, each ending in a bead
  const r6 = R * 1.6, rot6 = -turn(19000);
  for (const [off, span, w] of [[0, 1.25, 0.06], [2.3, 0.7, 0.05], [4.1, 0.42, 0.04]]) {
    const a0 = rot6 + off, a1 = a0 + span;
    arc(r6, a0, a1, R * w, c, 0.9, 7);
    dot(cx + Math.cos(a1) * r6, cy + Math.sin(a1) * r6, Math.max(1.5, R * 0.035), hi, 1);
  }

  // 7. outermost tick ring, with a radar sweep of light going round it
  const r7 = R * 1.8, ticks = 90, sweep = turn(busy ? 2200 : 7000);
  for (let i = 0; i < ticks; i++) {
    const a = i * TAU / ticks, major = i % 5 === 0;
    let d = ((sweep - a) % TAU + TAU) % TAU; const near = Math.max(0, 1 - d / 1.1); // brightest just behind the sweep
    const len = R * (major ? 0.075 : 0.04);
    g.beginPath(); g.moveTo(cx + Math.cos(a) * r7, cy + Math.sin(a) * r7); g.lineTo(cx + Math.cos(a) * (r7 + len), cy + Math.sin(a) * (r7 + len));
    g.strokeStyle = rgba(near > 0.05 ? mix(c, 0.5 * near) : c, (major ? 0.38 : 0.18) + near * 0.7); g.lineWidth = major ? 1.4 : 1; g.stroke();
  }
  g.globalCompositeOperation = 'source-over';
  g.restore();
}
