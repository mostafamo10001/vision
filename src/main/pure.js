'use strict';
// Small pure helpers with no Electron dependency (so they load everywhere and are easy to test).

// Next time a repeating reminder is due, strictly after `now`. A PC that was off for days skips the missed ones instead of firing them all.
function nextDue(due, repeat, now = Date.now()) {
  if (!['daily', 'weekdays', 'weekly', 'monthly'].includes(repeat)) return null;
  const base = new Date(due), d = new Date(due), day = base.getDate();
  const step = () => {
    if (repeat === 'daily') d.setDate(d.getDate() + 1);
    else if (repeat === 'weekdays') { do d.setDate(d.getDate() + 1); while (d.getDay() === 0 || d.getDay() === 6); }
    else if (repeat === 'weekly') d.setDate(d.getDate() + 7);
    else { d.setDate(1); d.setMonth(d.getMonth() + 1); d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate())); }
  };
  let guard = 0;
  do { step(); } while (d.getTime() <= now && ++guard < 5000);
  return guard >= 5000 ? null : d.getTime();
}

// True for addresses that point at this PC or the local network (a web page must not be able to make Vision read those).
function isPrivateHost(host) {
  host = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan') || (!host.includes('.') && !host.includes(':'))) return true;
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) { const a = +v4[1], b = +v4[2]; return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127); }
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) return true; // decimal / hex forms of an IP address
  if (host.includes(':')) return host === '::1' || host === '::' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || /^::ffff:/.test(host);
  return false;
}
module.exports = { nextDue, isPrivateHost };
