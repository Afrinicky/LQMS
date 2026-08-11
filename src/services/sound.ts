/**
 * Reminder sounds, synthesised in the browser.
 *
 * A laboratory bench is a noisy place and the person who needs to chart the
 * fridge is rarely looking at a screen, so the reminder has to be audible. The
 * awkward part is that this same code has to make a noise inside three shells —
 * the packaged Electron desktop app, a plain browser over the LAN, and the
 * Capacitor native app — on a host that is frequently offline.
 *
 * Shipping audio files would mean bundling assets into all three and keeping
 * them in step. Instead each sound is a short specification (a waveform and a
 * few notes) that the Web Audio API renders on the spot. It is a few hundred
 * bytes, it works with no network, it is identical on every platform, and a
 * laboratory can add its own tone without anybody rebuilding an installer.
 *
 * Two browser realities shape the rest of this module:
 *
 *   1. Audio is blocked until the user has interacted with the page. The
 *      context is therefore created lazily and unlocked on the first click or
 *      key press, and a sound requested before that is dropped rather than
 *      queued — a chime that fires four minutes late is worse than none.
 *   2. There is exactly one AudioContext. Creating one per sound exhausts the
 *      browser's limit after a few dozen reminders and then everything falls
 *      silent, which is the hardest kind of bug to notice.
 */
import type { ToneSpec, SoundEvent } from '../../shared/constants/activities';
import { BUILTIN_SOUNDS, DEFAULT_SOUND_FOR_EVENT } from '../../shared/constants/activities';

type AudioContextCtor = typeof AudioContext;

export type SoundPreferences = {
  enabled: boolean;
  volume: number;
  repeatCount: number;
  desktopEnabled: boolean;
  mobileEnabled: boolean;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  dailyBriefingEnabled: boolean;
};

const DEFAULT_PREFERENCES: SoundPreferences = {
  enabled: true, volume: 0.7, repeatCount: 1,
  desktopEnabled: true, mobileEnabled: true,
  quietHoursStart: null, quietHoursEnd: null, dailyBriefingEnabled: true,
};

let context: AudioContext | null = null;
let unlocked = false;
let preferences: SoundPreferences = { ...DEFAULT_PREFERENCES };
let eventSounds: Record<string, string> = { ...DEFAULT_SOUND_FOR_EVENT };
let catalogue = new Map<string, ToneSpec>(BUILTIN_SOUNDS.map(sound => [sound.key, sound.spec]));

function audioContextCtor(): AudioContextCtor | null {
  const w = window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

function getContext(): AudioContext | null {
  if (context) return context;
  const Ctor = audioContextCtor();
  if (!Ctor) return null;
  try { context = new Ctor(); } catch { context = null; }
  return context;
}

/**
 * Browsers refuse to play audio until the user has done something. This hooks
 * the first interaction of the session, resumes the context, and then removes
 * itself — after which reminders are audible for the rest of the session.
 */
export function primeAudio(): void {
  if (unlocked) return;
  const unlock = () => {
    unlocked = true;
    const ctx = getContext();
    if (ctx && ctx.state === 'suspended') void ctx.resume();
    for (const event of ['pointerdown', 'keydown', 'touchstart']) {
      window.removeEventListener(event, unlock);
    }
  };
  for (const event of ['pointerdown', 'keydown', 'touchstart']) {
    window.addEventListener(event, unlock, { once: false, passive: true });
  }
}

/** True when running inside the Capacitor native shell. */
function isNativeShell(): boolean {
  return Boolean((window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.());
}

/**
 * Whether the clock is inside the user's quiet hours. Handles a window that
 * crosses midnight (22:00–06:00), which is the normal case for a night shift.
 */
function inQuietHours(now = new Date()): boolean {
  const { quietHoursStart: start, quietHoursEnd: end } = preferences;
  if (!start || !end) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  const toMinutes = (value: string) => {
    const [h, m] = value.split(':').map(Number);
    return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
  };
  const from = toMinutes(start);
  const to = toMinutes(end);
  return from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

/** Apply the settings the server resolved for this user. */
export function configureSound(input: {
  preferences?: Partial<SoundPreferences>;
  events?: Array<{ event: string; soundKey: string }>;
  sounds?: Array<{ sound_key: string; tone_spec?: string | null }>;
}): void {
  if (input.preferences) preferences = { ...preferences, ...input.preferences };
  if (input.events) {
    const map: Record<string, string> = { ...DEFAULT_SOUND_FOR_EVENT };
    for (const entry of input.events) map[entry.event] = entry.soundKey;
    eventSounds = map;
  }
  if (input.sounds) {
    const next = new Map<string, ToneSpec>(BUILTIN_SOUNDS.map(sound => [sound.key, sound.spec]));
    for (const sound of input.sounds) {
      if (!sound.tone_spec) continue;
      try {
        const spec = JSON.parse(sound.tone_spec) as ToneSpec;
        if (spec && Array.isArray(spec.steps)) next.set(sound.sound_key, spec);
      } catch { /* a malformed spec falls back to the built-in of the same key */ }
    }
    catalogue = next;
  }
}

export function soundPreferences(): SoundPreferences {
  return { ...preferences };
}

/** Render one tone specification. Returns false when nothing could be played. */
export function playSpec(spec: ToneSpec, volumeOverride?: number): boolean {
  if (!spec || !spec.steps.length) return false;
  const ctx = getContext();
  if (!ctx) return false;
  if (ctx.state === 'suspended') {
    void ctx.resume();
    // Still suspended means the user has not interacted yet: drop it.
    if (ctx.state === 'suspended') return false;
  }

  const volume = Math.max(0, Math.min(1, volumeOverride ?? preferences.volume));
  if (volume === 0) return false;

  let at = ctx.currentTime + 0.01;
  for (const step of spec.steps) {
    const seconds = Math.max(0.02, (step.ms ?? 120) / 1000);
    if (step.freq > 0) {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = spec.waveform ?? 'sine';
      oscillator.frequency.setValueAtTime(step.freq, at);
      // A short attack and a exponential release: a square-edged tone clicks
      // audibly on cheap laboratory speakers, which reads as a fault.
      const peak = Math.max(0.0001, (spec.gain ?? 0.5) * volume);
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(peak, at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + seconds);
      oscillator.connect(gain).connect(ctx.destination);
      oscillator.start(at);
      oscillator.stop(at + seconds + 0.02);
    }
    at += seconds + (step.gap ?? 0) / 1000;
  }
  return true;
}

/** Play a named sound from the catalogue. */
export function playSound(soundKey: string, volumeOverride?: number): boolean {
  if (soundKey === 'silent') return false;
  const spec = catalogue.get(soundKey);
  if (!spec) return false;
  return playSpec(spec, volumeOverride);
}

/**
 * Play the sound configured for an event, honouring every preference: the
 * master switch, the per-platform switches, quiet hours and the repeat count.
 *
 * `force` bypasses the preference gates for one case only — previewing a sound
 * in the settings screen, where the user has explicitly asked to hear it.
 */
export function playEvent(event: SoundEvent | string, opts: { force?: boolean } = {}): boolean {
  if (!opts.force) {
    if (!preferences.enabled) return false;
    if (isNativeShell() ? !preferences.mobileEnabled : !preferences.desktopEnabled) return false;
    // Quiet hours never silence a critical alert. A laboratory that has asked
    // not to be disturbed overnight still needs to know the freezer is failing.
    if (inQuietHours() && event !== 'critical') return false;
  }
  const soundKey = eventSounds[event] ?? DEFAULT_SOUND_FOR_EVENT[event as SoundEvent] ?? 'chime_soft';
  const repeats = opts.force ? 1 : Math.max(1, Math.min(5, preferences.repeatCount));
  let played = playSound(soundKey);
  for (let i = 1; i < repeats; i++) {
    // Space the repeats far enough apart to read as separate rings.
    window.setTimeout(() => playSound(soundKey), i * 1400);
    played = true;
  }
  return played;
}

/** The tone specification behind a key, for the settings preview. */
export function specFor(soundKey: string): ToneSpec | null {
  return catalogue.get(soundKey) ?? null;
}

/** Every sound the client can currently play, for a settings dropdown. */
export function availableSounds(): Array<{ key: string; spec: ToneSpec }> {
  return [...catalogue.entries()].map(([key, spec]) => ({ key, spec }));
}
