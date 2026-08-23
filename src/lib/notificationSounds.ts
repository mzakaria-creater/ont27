export type AlertKind = 'transaction' | 'sms'
export type AlertTone = 'glass' | 'chime' | 'pulse'
export interface SoundSettings { enabled: boolean; transaction: AlertTone; sms: AlertTone }

const KEY = 'ontarget-notification-sounds-v1'
const defaults: SoundSettings = { enabled: false, transaction: 'chime', sms: 'glass' }

export function getSoundSettings(): SoundSettings {
  try { return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') } } catch { return defaults }
}

export function saveSoundSettings(settings: SoundSettings) {
  localStorage.setItem(KEY, JSON.stringify(settings))
  window.dispatchEvent(new CustomEvent('ontarget:sound-settings', { detail: settings }))
}

// Original synthesized alert patterns. No Apple audio files are bundled or
// copied; operators still get short, familiar phone-style notification tones.
export function playNotificationTone(kind: AlertKind, force = false) {
  const settings = getSoundSettings()
  if (!force && !settings.enabled) return
  const tone = settings[kind]
  const AudioCtx = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioCtx) return
  const ctx = new AudioCtx()
  const patterns: Record<AlertTone, { at: number; hz: number; duration: number; gain: number }[]> = {
    glass: [{ at: 0, hz: 1318.5, duration: .09, gain: .12 }, { at: .11, hz: 1760, duration: .17, gain: .09 }],
    chime: [{ at: 0, hz: 659.3, duration: .12, gain: .1 }, { at: .13, hz: 987.8, duration: .2, gain: .1 }],
    pulse: [{ at: 0, hz: 740, duration: .08, gain: .09 }, { at: .1, hz: 740, duration: .08, gain: .08 }, { at: .2, hz: 988, duration: .12, gain: .08 }],
  }
  for (const note of patterns[tone]) {
    const osc = ctx.createOscillator(); const gain = ctx.createGain(); const start = ctx.currentTime + note.at
    osc.type = tone === 'glass' ? 'sine' : 'triangle'; osc.frequency.setValueAtTime(note.hz, start)
    gain.gain.setValueAtTime(0.0001, start); gain.gain.exponentialRampToValueAtTime(note.gain, start + .015); gain.gain.exponentialRampToValueAtTime(0.0001, start + note.duration)
    osc.connect(gain); gain.connect(ctx.destination); osc.start(start); osc.stop(start + note.duration + .02)
  }
  window.setTimeout(() => void ctx.close(), 700)
}
