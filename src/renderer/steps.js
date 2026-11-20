// Spots requests with several parts ("open the folder and then search for X") so that Vision can be told, once,
// to carry on if it stopped after the first part. Kept separate and pure so it can be tested on its own.
const VERBS = 'open|click|type|press|search|find|play|go|close|scroll|select|write|send|download|delete|rename|move|copy|paste|fill|enter|run|start|launch|turn|set|save|take|read|look|show|tell|check|create|make|add|remove|install|upload|share|email|call|message|translate|summari[sz]e';
const SEQ = new RegExp(`\\b(?:and then|then|after that|afterwards|after you|next|followed by|and also|also|and (?:${VERBS})|, (?:${VERBS}))\\b`, 'gi');
// tools that already carry out a whole multi-step job by themselves
const MULTI = new Set(['do_task', 'play_youtube', 'scroll_capture', 'start_transcription', 'transcribe_file', 'open_bookmark']);

export function expectedSteps(text) { const n = (String(text || '').match(SEQ) || []).length; return n ? Math.min(4, 1 + n) : 1; }
export const isMultiStepCall = c => !!c && (MULTI.has(c.name) || (c.name === 'look_at_screen' && !!(c.args && c.args.goal)));
export function shouldContinue({ toolCount, usedMulti, continued, request, sinceToolMs }) {
  return !continued && !usedMulti && toolCount >= 1 && toolCount < expectedSteps(request) && sinceToolMs < 25000;
}
export const continueText = request => `Check my request: "${String(request).slice(0, 300)}". If any part of it is NOT done yet, do it now without waiting for me. If everything is already done, just say "Done." and call no tools.`;
