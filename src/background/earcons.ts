import type {EarconName} from "../shared/types"

export const EARCON_SAMPLE_RATE = 24000

function tone(hz: number, ms: number, amplitude = 4000): Uint8Array {
  const samples = Math.max(1, Math.round((EARCON_SAMPLE_RATE * ms) / 1000))
  const out = new Uint8Array(samples * 2)
  const view = new DataView(out.buffer)
  for (let i = 0; i < samples; i++) {
    const t = i / EARCON_SAMPLE_RATE
    const fade = i < 48 ? i / 48 : i > samples - 48 ? (samples - i) / 48 : 1
    view.setInt16(i * 2, Math.round(Math.sin(2 * Math.PI * hz * t) * amplitude * fade), true)
  }
  return out
}

export const EARCONS: Record<EarconName, Uint8Array> = {
  "listen-start": tone(660, 80),
  "listen-stop": tone(440, 80),
  disconnected: tone(220, 120),
}
