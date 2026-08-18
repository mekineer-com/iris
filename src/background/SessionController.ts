import type {MiniappSession, UnsubscribeFn} from "@mentra/miniapp/background"

import type {Channels} from "../shared/channels"
import type {ConnectionState, EarconName, SessionMode, SessionSnapshot} from "../shared/types"
import {approxBase64ByteLength} from "./audioHelpers"
import {EARCON_SAMPLE_RATE, EARCONS, LOOPBACK_PCM} from "./earcons"

type Send = <C extends keyof Channels & string>(channel: C, payload: Channels[C]) => void

type SpeakerWriter = {
  write(chunk: Uint8Array | ArrayBuffer): Promise<{bufferedMs: number}>
  close(): Promise<{durationMs?: number}>
  abort(): Promise<void>
}

export type SessionControllerOptions = {
  watchdogMs?: number
  loopbackAfterFrames?: number
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
  private loopbackTimer: ReturnType<typeof setTimeout> | null = null
  private micFrames = 0
  private loopbackStarted = false
  private disconnectedPlayed = false
  private readonly watchdogMs: number
  private readonly loopbackAfterFrames: number

  constructor(
    private readonly session: MiniappSession,
    options: SessionControllerOptions = {},
  ) {
    this.watchdogMs = options.watchdogMs ?? 3000
    this.loopbackAfterFrames = options.loopbackAfterFrames ?? 3
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
    this.cancelLoopback()
    const writer = this.speakerWriter
    this.speakerWriter = null
    this.speakerOpenPromise = null
    if (writer) {
      try {
        await writer.abort()
      } catch {
        /* host may reject a stale abort */
      }
    }
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
    this.micFrames = 0
    this.loopbackStarted = false
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
      this.connection = "listening"
      this.pushSnapshot()
    } catch (error) {
      if (generation !== this.startGeneration) return
      await this.fail(error)
    } finally {
      if (generation === this.startGeneration) this.startInFlight = false
    }
  }

  private async stopSession(_reason: "user" | "error"): Promise<void> {
    if (this.connection === "idle" || this.connection === "stopping") return
    const userStop = _reason === "user"
    this.connection = "stopping"
    this.startGeneration += 1
    this.startInFlight = false
    this.clearFirstPcmTimeout()
    this.cancelLoopback()
    this.stopMic()
    this.speakerEpoch += 1
    const writer = this.speakerWriter
    this.speakerWriter = null
    this.speakerOpenPromise = null
    if (writer) {
      try {
        await writer.abort()
      } catch {
        /* ignore */
      }
    }
    if (userStop) {
      try {
        await this.playEarcon("listen-stop")
      } catch {
        /* ignore */
      }
    }
    this.connection = "idle"
    this.pushSnapshot()
  }

  private async fail(error: unknown): Promise<void> {
    this.lastError = error instanceof Error ? error.message : String(error)
    this.clearFirstPcmTimeout()
    this.cancelLoopback()
    this.stopMic()
    this.speakerEpoch += 1
    const writer = this.speakerWriter
    this.speakerWriter = null
    this.speakerOpenPromise = null
    if (writer) {
      try {
        await writer.abort()
      } catch {
        /* ignore */
      }
    }
    if (!this.disconnectedPlayed) {
      this.disconnectedPlayed = true
      try {
        await this.playEarcon("disconnected")
      } catch {
        /* ignore */
      }
    }
    this.connection = "error"
    this.startInFlight = false
    this.pushSnapshot()
  }

  private subscribeMic(): void {
    this.stopMic()
    this.micUnsub = this.session.mic.onAudioChunk((chunk) => {
      this.handlePcmFrame(chunk.data)
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

  private handlePcmFrame(base64Pcm: string): void {
    if (!ACTIVE.has(this.connection) && this.connection !== "starting") return
    if (approxBase64ByteLength(base64Pcm) < 1) return
    this.micFrames += 1
    if (this.micFrames === 1) this.clearFirstPcmTimeout()
    if (!this.loopbackStarted && this.micFrames >= this.loopbackAfterFrames) {
      this.loopbackStarted = true
      void this.playLoopback()
    }
  }

  private cancelLoopback(): void {
    this.loopbackStarted = true
    if (this.loopbackTimer) {
      clearTimeout(this.loopbackTimer)
      this.loopbackTimer = null
    }
  }

  private async playLoopback(): Promise<void> {
    const epoch = this.speakerEpoch
    if (this.speakerOpenPromise) {
      const existing = await this.speakerOpenPromise
      if (epoch !== this.speakerEpoch) return
      if (existing) return
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
    if (!writer || epoch !== this.speakerEpoch) return
    this.connection = "speaking"
    this.pushSnapshot()
    try {
      if (epoch !== this.speakerEpoch) return
      await writer.write(LOOPBACK_PCM)
      if (epoch !== this.speakerEpoch) return
      this.connection = "listening"
      this.pushSnapshot()
    } catch {
      if (epoch === this.speakerEpoch) await this.fail(new Error("speaker write failed"))
    }
  }
}
