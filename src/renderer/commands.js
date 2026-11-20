// Commands that must act INSTANTLY, spoken or typed, without waiting for the model to understand them.
const STOP_ALL = [
  /\b(?:stop|cancel|abort|halt|kill)\s+(?:all|everything)\b/i,                      // "stop all tasks", "stop everything", "cancel all"
  /\b(?:stop|cancel|abort)\s+(?:the\s+)?(?:tasks?|operations?|jobs?|actions?)\b/i,  // "stop the tasks"
  /(?:وقف|أوقف|اوقف|الغي|ألغي)\s+(?:كل|جميع|كافة)/                                   // Arabic: stop / cancel everything
];
const STOP_LISTENING = [
  /\bstop\s+listening\b/i,
  /\b(?:end|quit|exit|finish|close|stop)\s+(?:the\s+)?(?:voice\s+)?(?:session|chat|conversation|mic(?:rophone)?)\b/i,
  /\bgo\s+to\s+sleep\b/i,
  /(?:وقف|أوقف|اوقف)\s+(?:ال)?(?:استماع|الاستماع|ميكروفون|المايك)/,
  /(?:اقفل|أقفل|انهي|أنهي)\s+(?:ال)?(?:جلسه|جلسة|ميكروفون|المايك)/
];
// Heard speech: the command may come at the end of a longer sentence, so only the last 8 words count.
// Typed text (whole: true): the whole message must be short, so a long sentence that merely contains the words is not a command.
export function voiceCommand(text, { whole = false } = {}) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length || (whole && words.length > 8)) return null;
  const t = words.slice(-8).join(' ');
  if (STOP_ALL.some(r => r.test(t))) return 'stop_all';
  if (STOP_LISTENING.some(r => r.test(t))) return 'stop_listening';
  return null;
}

// Transcription may start ONLY on the words "transcribe" or "start transcribing" (spoken at the end of an utterance, or typed as a short message).
// "listening", "take notes", "write this down", "transcription" and so on never count.
const TRANSCRIBE = /\b(?:start\s+transcribing|transcribe)\b/i;
export function transcribeCommand(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  return TRANSCRIBE.test(words.slice(-8).join(' '));
}

// Spoken approval for a pending action: "I approve", "approved", "approve this task". Returns 'approve', 'approve_task' or null.
// Negated or questioned phrases ("don't approve", "should I approve?") never count.
const APPROVE_TASK = [/\bapprov(?:e|ed)\b.*\b(?:this\s+)?task\b/, /\btask\b.*\bapprov(?:e|ed)\b/, /\bapprove\s+(?:all|everything)\b/];
const APPROVE = [/\bapprov(?:e|ed)\b/];
const NOT_APPROVE = /\b(?:not|don'?t|do\s+not|never|wait|no|should|can\s+i|do\s+i|would|shall)\b|\?/i;
// Spoken refusal for a pending action: "deny", "I deny", "decline", "reject", "I don't approve". Questions ("should I deny?") and "don't deny" never count.
const DENY = /\b(?:deny|denied|decline|declined|reject|rejected|refuse|refused)\b/i;
const NOT_APPROVING = /\b(?:don'?t|do\s+not|not|never)\s+approv(?:e|ed)\b/i;
const NOT_DENY = /\b(?:not|don'?t|do\s+not|never|should|can\s+i|do\s+i|would|shall|wait)\b|\?/i;
export function denyCommand(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const t = words.slice(-8).join(' ');
  if (/\?|\b(?:should|can\s+i|do\s+i|would|shall)\b/i.test(t)) return null;
  if (NOT_APPROVING.test(t)) return 'deny';
  if (DENY.test(t) && !NOT_DENY.test(t)) return 'deny';
  return null;
}
export function approvalCommand(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const t = words.slice(-8).join(' ');
  if (!/\bapprov/i.test(t) || NOT_APPROVE.test(t)) return null;
  if (APPROVE_TASK.some(r => r.test(t))) return 'approve_task';
  if (APPROVE.some(r => r.test(t))) return 'approve';
  return null;
}
