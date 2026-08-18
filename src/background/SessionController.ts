import type {MiniappSession, UnsubscribeFn} from "@mentra/miniapp/background"

import type {Channels} from "../shared/channels"
import type {ConnectionState, EarconName, SessionMode, SessionSnapshot} from "../shared/types"
import {approxBase64ByteLength} from "./audioHelpers"
import {EARCON_SAMPLE_RATE, EARCONS} from "./earcons"
import type {LiveProvider} from "./liveProvider"
import {MockProvider} from "./MockProvider"

type Send = <C extends keyof Channels & string>(channel: C, payload: Channels[C]) => void

type SpeakerWriter = {
  write(chunk: Uint8Array | ArrayBuffer): Promise<{bufferedMs: number}>
  close(): Promise<{durationMs?: number}>
  abort(): Promise<void>
}

export type SessionControllerOptions = {
  watchdogMs?: number
  provider?: LiveProvider
}

const ACTIVE: ReadonlySet<ConnectionState> = new Set(["starting", "listening", "speaking"])

export class SessionController {
  private started = false
  private readonly unsubs: Array<() => void> = []
  private send: Send | null = null

  private mode: SessionMode = "continuous"
  private connection: ConnectionState = "idle"
  private lastError: string | null = null
  private startInFlight = false
  private startGeneration = 0
  private speakerEpoch = 0
  private speakerWriter: SpeakerWriter | null = null
  private speakerOpenPromise: Promise<SpeakerWriter | null> | null = null
  private micUnsub: UnsubscribeFn | null = null
  private firstPcmTimeout: ReturnType<typeof setTimeout> | null = null
  private sawMicFrame = false
  private writeInFlight = false
  private audioEnded = false
  private disconnectedPlayed = false
  private teardownKind: "stop" | "fail" | null = null
  private readonly watchdogMs: number
  private readonly provider: LiveProvider

  constructor(
    private readonly session: MiniappSession,
    options: SessionControllerOptions = {},
  ) {
    this.watchdogMs = options.watchdogMs ?? 3000
    this.provider = options.provider ?? new MockProvider()
  }

  start(): void {
    if (this.started) return
    this.started = true

    const ui = this.session.ui as unknown as {
      send: Send
      onOpen: (cb: () => void) => () => void
      handle: <C extends keyof Channels & string>(
        channel: C,
        handler: (payload: unknown) => Promise<unknown> | unknown,
      ) => () => void
    }

    this.send = ui.send
    this.unsubs.push(ui.onOpen(() => this.pushSnapshot()))
    this.unsubs.push(
      ui.handle("openalma:start", async (payload) => {
        const mode = (payload as {mode?: SessionMode} | null)?.mode ?? this.mode
        await this.startSession(mode)
        if (this.connection === "error") {
          throw new Error(this.lastError || "start failed")
        }
        return {ok: true as const}
      }),
    )
    this.unsubs.push(
      ui.handle("openalma:stop", async () => {
        await this.stopSession("user")
        return {ok: true as const}
      }),
    )
    this.unsubs.push(
      ui.handle("openalma:set-mode", (payload) => {
        const mode = (payload as {mode?: SessionMode} | null)?.mode
        if (mode === "continuous" || mode === "manual") this.mode = mode
        this.pushSnapshot()
        return {ok: true as const}
      }),
    )
  }

  async interrupt(): Promise<void> {
    this.speakerEpoch += 1
    this.provider.interrupt()
    await this.abortCurrentWriter()
    if (this.connection === "speaking") {
      this.connection = "listening"
      this.pushSnapshot()
    }
  }

  async playEarcon(name: EarconName): Promise<void> {
    const pcm = EARCONS[name]
    const epoch = this.speakerEpoch
    const writer = (await this.session.speaker.createStream({
      sampleRate: EARCON_SAMPLE_RATE,
      stopOtherAudio: true,
    })) as SpeakerWriter
    if (epoch !== this.speakerEpoch) {
      try {
        await writer.abort()
      } catch {
        /* abandoned */
      }
      return
    }
    this.speakerWriter = writer
    try {
      await writer.write(pcm)
      if (epoch !== this.speakerEpoch) return
      await writer.close()
    } catch {
      try {
        await writer.abort()
      } catch {
        /* ignore */
      }
    } finally {
      if (this.speakerWriter === writer) this.speakerWriter = null
    }
  }

  private snapshot(): SessionSnapshot {
    return {mode: this.mode, connection: this.connection, lastError: this.lastError}
  }

  private pushSnapshot(): void {
    this.send?.("openalma:update", this.snapshot())
  }

  private async startSession(mode: SessionMode): Promise<void> {
    if (this.startInFlight || ACTIVE.has(this.connection) || this.connection === "stopping") {
      return
    }

    this.startInFlight = true
    const generation = ++this.startGeneration
    this.mode = mode
    this.lastError = null
    this.disconnectedPlayed = false
    this.sawMicFrame = false
    this.connection = "starting"
    this.pushSnapshot()

    try {
      await this.playEarcon("listen-start")
      if (generation !== this.startGeneration) return
      this.subscribeMic()
      if (generation !== this.startGeneration) {
        this.stopMic()
        return
      }
      await this.provider.connect({
        onAudio: (pcm) => this.onProviderAudio(pcm),
        onAudioEnd: () => this.onProviderAudioEnd(),
        onTranscript: () => {},
        onToolCall: () => {},
        onError: (error) => {
          void this.fail(error)
        },
      })
      if (generation !== this.startGeneration) {
        this.provider.close()
        this.stopMic()
        return
      }
      this.connection = "listening"
      this.pushSnapshot()
    } catch (error) {
      if (generation !== this.startGeneration) return
      await this.fail(error)
    } finally {
      if (generation === this.startGeneration) this.startInFlight = false
    }
  }

  private beginTeardown(kind: "stop" | "fail"): number {
    this.connection = "stopping"
    this.teardownKind = kind
    this.startGeneration += 1
    this.startInFlight = false
    this.clearFirstPcmTimeout()
    this.provider.close()
    this.stopMic()
    this.speakerEpoch += 1
    return this.startGeneration
  }

  private async abortCurrentWriter(): Promise<void> {
    const writer = this.speakerWriter
    this.speakerWriter = null
    this.speakerOpenPromise = null
    if (!writer) return
    try {
      await writer.abort()
    } catch {
      /* host may reject a stale abort */
    }
  }

  private async stopSession(_reason: "user" | "error"): Promise<void> {
    if (this.connection === "idle") return
    if (this.connection === "stopping") {
      if (this.teardownKind !== "fail") return
      this.startGeneration += 1
      this.speakerEpoch += 1
      this.teardownKind = "stop"
      this.lastError = null
      this.connection = "idle"
      this.pushSnapshot()
      void this.abortCurrentWriter()
      return
    }
    const userStop = _reason === "user"
    const generation = this.beginTeardown("stop")
    if (userStop) this.lastError = null
    this.pushSnapshot()
    await this.abortCurrentWriter()
    if (generation !== this.startGeneration) return
    if (userStop) {
      try {
        await this.playEarcon("listen-stop")
      } catch {
        /* ignore */
      }
    }
    if (generation !== this.startGeneration) return
    this.teardownKind = null
    this.connection = "idle"
    this.pushSnapshot()
  }

  private async fail(error: unknown): Promise<void> {
    if (this.connection === "idle" || this.connection === "stopping" || this.connection === "error") {
      return
    }
    this.lastError = error instanceof Error ? error.message : String(error)
    const generation = this.beginTeardown("fail")
    this.pushSnapshot()
    await this.abortCurrentWriter()
    if (generation !== this.startGeneration) return
    if (!this.disconnectedPlayed) {
      this.disconnectedPlayed = true
      try {
        await this.playEarcon("disconnected")
      } catch {
        /* ignore */
      }
    }
    if (generation !== this.startGeneration) return
    this.teardownKind = null
    this.connection = "error"
    this.pushSnapshot()
  }

  private subscribeMic(): void {
    this.stopMic()
    this.micUnsub = this.session.mic.onAudioChunk((chunk) => {
      if (!ACTIVE.has(this.connection) && this.connection !== "starting") return
      if (approxBase64ByteLength(chunk.data) < 1) return
      if (!this.sawMicFrame) {
        this.sawMicFrame = true
        this.clearFirstPcmTimeout()
      }
      this.provider.sendPcm(chunk.data, chunk.sampleRate, chunk.format)
    })
    this.startFirstPcmWatchdog()
  }

  private stopMic(): void {
    if (this.micUnsub) {
      try {
        this.micUnsub()
      } catch {
        /* ignore */
      }
      this.micUnsub = null
    }
    try {
      this.session.mic.stop()
    } catch {
      /* ignore */
    }
  }

  private clearFirstPcmTimeout(): void {
    if (this.firstPcmTimeout) {
      clearTimeout(this.firstPcmTimeout)
      this.firstPcmTimeout = null
    }
  }

  private startFirstPcmWatchdog(): void {
    this.clearFirstPcmTimeout()
    const generation = this.startGeneration
    this.firstPcmTimeout = setTimeout(() => {
      if (generation !== this.startGeneration) return
      if (this.connection !== "starting" && this.connection !== "listening") return
      void this.fail(new Error("no microphone audio"))
    }, this.watchdogMs)
  }

  private onProviderAudio(pcm: Uint8Array): void {
    this.audioEnded = false
    if (this.connection === "listening" || this.connection === "speaking") {
      if (this.connection !== "speaking") {
        this.connection = "speaking"
        this.pushSnapshot()
      }
    }
    void this.writeSpeech(pcm)
  }

  private onProviderAudioEnd(): void {
    this.audioEnded = true
    this.maybeEndSpeech()
  }

  private maybeEndSpeech(): void {
    if (!this.audioEnded || this.writeInFlight || this.connection !== "speaking") return
    this.connection = "listening"
    this.pushSnapshot()
  }

  private async writeSpeech(pcm: Uint8Array): Promise<void> {
    const epoch = this.speakerEpoch
    this.writeInFlight = true
    try {
      const writer = await this.ensureSpeechWriter(epoch)
      if (!writer || epoch !== this.speakerEpoch) return
      if (this.connection === "listening") {
        this.connection = "speaking"
        this.pushSnapshot()
      }
      if (epoch !== this.speakerEpoch) return
      await writer.write(pcm)
    } catch {
      if (epoch === this.speakerEpoch) await this.fail(new Error("speaker write failed"))
    } finally {
      this.writeInFlight = false
      if (epoch === this.speakerEpoch) this.maybeEndSpeech()
    }
  }

  private async ensureSpeechWriter(epoch: number): Promise<SpeakerWriter | null> {
    if (this.speakerWriter && epoch === this.speakerEpoch) return this.speakerWriter
    if (this.speakerOpenPromise) {
      const existing = await this.speakerOpenPromise
      if (epoch !== this.speakerEpoch) return null
      return existing
    }
    this.speakerOpenPromise = (async () => {
      const writer = (await this.session.speaker.createStream({
        sampleRate: EARCON_SAMPLE_RATE,
        stopOtherAudio: true,
      })) as SpeakerWriter
      if (epoch !== this.speakerEpoch) {
        try {
          await writer.abort()
        } catch {
          /* abandoned */
        }
        return null
      }
      this.speakerWriter = writer
      return writer
    })()
    const writer = await this.speakerOpenPromise
    this.speakerOpenPromise = null
    return writer
  }
}
