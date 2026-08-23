import {base64ToBytes, bytesToBase64} from "@mentra/miniapp/background"
import type {AudioChunkData} from "@mentra/miniapp/background"

/** Approximate decoded byte length of a base64 payload (padding-aware). */
export function approxBase64ByteLength(b64: string): number {
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding)
}

export function parsePcmSampleRate(format: string): number | null {
  const match = /^pcm_(\d+)$/.exec(format)
  if (!match) return null
  const rate = Number(match[1])
  return Number.isFinite(rate) && rate > 0 ? rate : null
}

/** Linear resample 16-bit LE mono PCM between sample rates. */
export function resamplePcm16Le(input: Uint8Array, fromRate: number, toRate: number): Uint8Array {
  if (fromRate === toRate || input.byteLength < 2) {
    return input
  }
  const inSamples = input.byteLength >> 1
  const outSamples = Math.max(1, Math.round((inSamples * toRate) / fromRate))
  const out = new Uint8Array(outSamples * 2)
  const inView = new DataView(input.buffer, input.byteOffset, input.byteLength)
  const outView = new DataView(out.buffer)
  for (let i = 0; i < outSamples; i++) {
    const src = (i * fromRate) / toRate
    const i0 = Math.floor(src)
    const i1 = Math.min(i0 + 1, inSamples - 1)
    const frac = src - i0
    const s0 = inView.getInt16(i0 * 2, true)
    const s1 = inView.getInt16(i1 * 2, true)
    outView.setInt16(i * 2, Math.round(s0 + (s1 - s0) * frac), true)
  }
  return out
}

export function normalizePcm16Audio(chunk: AudioChunkData, targetRate = 16000): string {
  const format = chunk.format ?? "<missing>"
  const formatRate = format === "pcm_s16le" ? null : parsePcmSampleRate(format)
  const sampleRate = chunk.sampleRate
  if (format !== "pcm_s16le" && formatRate === null) {
    throw new Error(`unsupported microphone audio format (${format}, sampleRate=${sampleRate ?? "missing"})`)
  }
  if (formatRate !== null && sampleRate !== undefined && sampleRate !== formatRate) {
    throw new Error(`conflicting microphone sample rates (${formatRate} and ${sampleRate})`)
  }
  const sourceRate = formatRate ?? sampleRate
  if (!Number.isFinite(sourceRate) || (sourceRate ?? 0) <= 0) {
    throw new Error(`missing microphone sample rate (${format})`)
  }
  const bytes = base64ToBytes(chunk.data)
  if (bytes.byteLength === 0) throw new Error("microphone audio chunk is empty")
  if (bytes.byteLength % 2 !== 0) throw new Error("microphone audio must contain complete 16-bit samples")
  if (sourceRate === targetRate) return chunk.data
  return bytesToBase64(resamplePcm16Le(bytes, sourceRate as number, targetRate))
}
