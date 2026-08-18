import {pcmTone} from "./earcons"
import {approxBase64ByteLength} from "./audioHelpers"
import type {LiveProvider, LiveProviderHandlers} from "./liveProvider"

const LOOPBACK_PCM = pcmTone(520, 60, 2500)

export type MockProviderOptions = {
  loopbackAfterFrames?: number
}

export class MockProvider implements LiveProvider {
  private handlers: LiveProviderHandlers | null = null
  private frames = 0
  private loopbackStarted = false
  private closed = false
  private readonly loopbackAfterFrames: number

  constructor(options: MockProviderOptions = {}) {
    this.loopbackAfterFrames = options.loopbackAfterFrames ?? 3
  }

  async connect(handlers: LiveProviderHandlers): Promise<void> {
    this.handlers = handlers
    this.frames = 0
    this.loopbackStarted = false
    this.closed = false
  }

  sendPcm(base64Pcm: string, _sampleRate?: number, _format?: string): void {
    if (this.closed || !this.handlers) return
    if (approxBase64ByteLength(base64Pcm) < 1) return
    this.frames += 1
    if (!this.loopbackStarted && this.frames >= this.loopbackAfterFrames) {
      this.loopbackStarted = true
      this.handlers.onAudio(LOOPBACK_PCM)
      this.handlers.onAudioEnd()
    }
  }

  sendToolResponse(_id: string, _result: unknown): void {}

  interrupt(): void {
    this.frames = 0
    this.loopbackStarted = false
  }

  close(): void {
    this.closed = true
    this.handlers = null
  }
}
