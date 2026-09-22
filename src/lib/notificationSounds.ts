export type AlertKind = 'transaction' | 'sms'
export type AlertTone = 'glass' | 'chime' | 'pulse' | 'bell' | 'sonar' | 'pop' | 'double' | 'urgent' | 'tritone' | 'cash'
export interface SoundSettings { enabled: boolean; transaction: AlertTone; sms: AlertTone }

const KEY = 'ontarget-notification-sounds-v2'
// 'cash' for money in/out and 'tritone' for SMS are distinct from each other
// on purpose — an operator hearing either needs to tell, without looking,
// whether it's a transaction event or a raw SMS arriving.
const defaults: SoundSettings = { enabled: true, transaction: 'cash', sms: 'tritone' }
let sharedContext: AudioContext | null = null
let unlockInstalled = false
let pendingTone: AlertKind | null = null

function audioConstructor() {
  return window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
}

export function isNotificationAudioReady() { return sharedContext?.state === 'running' }

export function installNotificationAudioUnlock() {
  if (unlockInstalled) return
  unlockInstalled = true
  const unlock = () => {
    const AudioCtx = audioConstructor()
    if (!AudioCtx) return
    sharedContext ??= new AudioCtx()
    void sharedContext.resume().then(() => {
      window.dispatchEvent(new CustomEvent('ontarget:audio-ready'))
      const queued = pendingTone; pendingTone = null
      if (queued) playNotificationTone(queued, true)
    })
  }
  window.addEventListener('pointerdown', unlock, { passive: true })
  window.addEventListener('keydown', unlock)
}

export function getSoundSettings(): SoundSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<SoundSettings>
    return { ...defaults, ...saved, enabled: saved.enabled ?? true }
  } catch { return defaults }
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
  const AudioCtx = audioConstructor()
  if (!AudioCtx) return
  sharedContext ??= new AudioCtx()
  const ctx = sharedContext
  if (ctx.state !== 'running') { pendingTone = kind; void ctx.resume(); return }
  // A short master-compressor gives small phone/laptop speakers a clearer,
  // louder alert while preventing clipping when several realtime events land.
  const master = ctx.createGain()
  const compressor = ctx.createDynamicsCompressor()
  master.gain.setValueAtTime(1.85, ctx.currentTime)
  compressor.threshold.setValueAtTime(-18, ctx.currentTime)
  compressor.knee.setValueAtTime(12, ctx.currentTime)
  compressor.ratio.setValueAtTime(6, ctx.currentTime)
  compressor.attack.setValueAtTime(.003, ctx.currentTime)
  compressor.release.setValueAtTime(.18, ctx.currentTime)
  master.connect(compressor); compressor.connect(ctx.destination)
  const patterns: Record<AlertTone, { at: number; hz: number; duration: number; gain: number }[]> = {
    glass: [{ at: 0, hz: 1318.5, duration: .09, gain: .12 }, { at: .11, hz: 1760, duration: .17, gain: .09 }],
    chime: [{ at: 0, hz: 659.3, duration: .12, gain: .1 }, { at: .13, hz: 987.8, duration: .2, gain: .1 }],
    pulse: [{ at: 0, hz: 740, duration: .08, gain: .09 }, { at: .1, hz: 740, duration: .08, gain: .08 }, { at: .2, hz: 988, duration: .12, gain: .08 }],
    bell: [{ at: 0, hz: 523.3, duration: .22, gain: .1 }, { at: .04, hz: 1046.5, duration: .38, gain: .065 }],
    sonar: [{ at: 0, hz: 440, duration: .16, gain: .09 }, { at: .18, hz: 659.3, duration: .16, gain: .08 }, { at: .36, hz: 880, duration: .2, gain: .07 }],
    pop: [{ at: 0, hz: 988, duration: .055, gain: .12 }, { at: .065, hz: 1318.5, duration: .085, gain: .08 }],
    double: [{ at: 0, hz: 784, duration: .11, gain: .1 }, { at: .16, hz: 784, duration: .11, gain: .1 }],
    urgent: [{ at: 0, hz: 587.3, duration: .1, gain: .11 }, { at: .12, hz: 880, duration: .1, gain: .11 }, { at: .24, hz: 587.3, duration: .1, gain: .1 }, { at: .36, hz: 1174.7, duration: .16, gain: .09 }],
    // Three quick ascending bell notes — the classic iPhone text-message
    // shape (short, bright, unmistakably "a message just arrived").
    tritone: [{ at: 0, hz: 1046.5, duration: .1, gain: .11 }, { at: .1, hz: 1318.5, duration: .1, gain: .11 }, { at: .2, hz: 1568.0, duration: .22, gain: .1 }],
    // A bright two-note "cha-ching" — deliberately different in shape and
    // timbre from tritone so a transaction event never gets mistaken for a
    // raw SMS arriving.
    cash: [{ at: 0, hz: 1567.98, duration: .07, gain: .13 }, { at: .07, hz: 2093.0, duration: .1, gain: .11 }, { at: .2, hz: 1567.98, duration: .16, gain: .08 }],
  }
  for (const note of patterns[tone]) {
    const osc = ctx.createOscillator(); const gain = ctx.createGain(); const start = ctx.currentTime + note.at
    osc.type = tone === 'glass' || tone === 'bell' || tone === 'sonar' || tone === 'tritone' ? 'sine' : 'triangle'; osc.frequency.setValueAtTime(note.hz, start)
    gain.gain.setValueAtTime(0.0001, start); gain.gain.exponentialRampToValueAtTime(note.gain, start + .015); gain.gain.exponentialRampToValueAtTime(0.0001, start + note.duration)
    osc.connect(gain); gain.connect(master); osc.start(start); osc.stop(start + note.duration + .02)
  }
}
