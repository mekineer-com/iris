import {describe, expect, test} from "bun:test"

import {approxBase64ByteLength, normalizePcm16Audio, parsePcmSampleRate, resamplePcm16Le} from "./audioHelpers"

describe("audioHelpers", () => {
  test("approxBase64ByteLength accounts for padding", () => {
    expect(approxBase64ByteLength("AAAA")).toBe(3)
    expect(approxBase64ByteLength("AAA=")).toBe(2)
    expect(approxBase64ByteLength("AA==")).toBe(1)
  })

  test("parsePcmSampleRate reads pcm_N and rejects others", () => {
    expect(parsePcmSampleRate("pcm_16000")).toBe(16000)
    expect(parsePcmSampleRate("pcm_24000")).toBe(24000)
    expect(parsePcmSampleRate("ulaw_8000")).toBeNull()
    expect(parsePcmSampleRate("pcm_")).toBeNull()
  })

  test("resamplePcm16Le doubles sample count when rate doubles", () => {
    const input = new Uint8Array(4)
    const view = new DataView(input.buffer)
    view.setInt16(0, 1000, true)
    view.setInt16(2, -1000, true)
    const out = resamplePcm16Le(input, 16000, 32000)
    expect(out.byteLength).toBe(8)
    expect(resamplePcm16Le(input, 16000, 16000)).toBe(input)
  })

  test("normalizes supported PCM and rejects bad boundaries", () => {
    const pcm = Buffer.from([0, 0, 1, 0]).toString("base64")
    expect(normalizePcm16Audio({data: pcm, format: "pcm_s16le", sampleRate: 16000})).toBe(pcm)
    expect(Buffer.from(normalizePcm16Audio({data: pcm, format: "pcm_8000"}), "base64").length).toBe(8)
    expect(() => normalizePcm16Audio({data: pcm, format: "lc3", sampleRate: 16000})).toThrow(
      "unsupported microphone audio format",
    )
    expect(() => normalizePcm16Audio({data: pcm, format: "pcm_8000", sampleRate: 16000})).toThrow(
      "conflicting microphone sample rates",
    )
    expect(() => normalizePcm16Audio({data: "AA==", format: "pcm_s16le", sampleRate: 16000})).toThrow(
      "complete 16-bit samples",
    )
  })
})
