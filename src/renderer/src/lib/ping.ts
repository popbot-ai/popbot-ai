/**
 * Soft notification ping — a single short tone via Web Audio. Used when
 * a chat transitions to "needs you" (wait) status so the user can hear
 * something is asking for them while they're looking at another chat.
 */

let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (ctx) return ctx;
  try {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
    return ctx;
  } catch {
    return null;
  }
}

function singleTone(c: AudioContext, startAt: number, freqStart: number, freqEnd: number, peak: number, lenMs: number): void {
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freqStart, startAt);
  osc.frequency.exponentialRampToValueAtTime(freqEnd, startAt + (lenMs / 1000) * 0.7);
  gain.gain.setValueAtTime(0, startAt);
  gain.gain.linearRampToValueAtTime(peak, startAt + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0005, startAt + lenMs / 1000);
  osc.connect(gain).connect(c.destination);
  osc.start(startAt);
  osc.stop(startAt + lenMs / 1000 + 0.02);
}

export function playPing(): void {
  const c = getCtx();
  if (!c) return;
  if (c.state === 'suspended') void c.resume();
  singleTone(c, c.currentTime, 880, 660, 0.08, 220);
}

/** Louder double-tone for `urgent` notifications — short rising chirp. */
export function playUrgentDing(): void {
  const c = getCtx();
  if (!c) return;
  if (c.state === 'suspended') void c.resume();
  const t = c.currentTime;
  singleTone(c, t,         660, 880, 0.14, 180);
  singleTone(c, t + 0.18,  990, 1320, 0.14, 220);
}
