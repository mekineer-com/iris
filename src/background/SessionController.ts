import type {AudioChunkData, MiniappSession, UnsubscribeFn} from "@mentra/miniapp/background"

import type {Channels} from "../shared/channels"
import type {ConnectionState, EarconName, SessionMode, SessionSnapshot} from "../shared/types"
import {normalizePcm16Audio} from "./audioHelpers"
import {EARCON_SAMPLE_RATE, EARCONS} from "./earcons"
import {GeminiLiveController} from "./GeminiLiveController"
import type {GeminiCallbacks} from "./GeminiLiveController"
import type {OpenAlmaConfig} from "./openAlmaConfig"
import {readOpenAlmaConfig} from "./openAlmaConfig"

type Send = <C extends keyof Channels & string>(channel: C, payload: Channels[C]) => void

type SpeakerWriter = {
  write(chunk: Uint8Array | ArrayBuffer): Promise<{bufferedMs: number}>
  writeBase64(chunk: string): Promise<{bufferedMs: number}>
  close(): Promise<{durationMs?: number}>
  abort(): Promise<void>
}

export type SessionControllerOptions = {
  watchdogMs?: number
  config?: OpenAlmaConfig
  createLiveController?: (config: OpenAlmaConfig, callbacks: GeminiCallbacks) => GeminiLiveController
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
  private readonly pendingSpeechWrites = new Set<Promise<void>>()
  private micUnsub: UnsubscribeFn | null = null
  private firstPcmTimeout: ReturnType<typeof setTimeout> | null = null
  private sawMicFrame = false
  private disconnectedPlayed = false
  private teardownKind: "stop" | "fail" | null = null
  private readonly watchdogMs: number
  private readonly config?: OpenAlmaConfig
  private readonly createLiveController: (config: OpenAlmaConfig, callbacks: GeminiCallbacks) => GeminiLiveController
  private liveController: GeminiLiveController | null

  constructor(
    private readonly session: MiniappSession,
    options: SessionControllerOptions = {},
  ) {
    this.watchdogMs = options.watchdogMs ?? 3000
    this.config = options.config
    this.createLiveController =
      options.createLiveController ?? ((config, callbacks) => new GeminiLiveController(config, callbacks))
    this.liveController = null
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
        if (mode === "manual") throw new Error("Manual mode is available in Slice 7")
        if (mode === "continuous") this.mode = mode
        this.pushSnapshot()
        return {ok: true as const}
      }),
    )
  }

  async interrupt(): Promise<void> {
    this.speakerEpoch += 1
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
    if (mode !== "continuous") throw new Error("Manual mode is available in Slice 7")

    this.startInFlight = true
    const generation = ++this.startGeneration
    this.mode = mode
    this.lastError = null
    this.disconnectedPlayed = false
    this.sawMicFrame = false
    this.connection = "starting"
    this.pushSnapshot()

    try {
      if (!this.liveController) {
        this.liveController = this.createLiveController(this.config ?? readOpenAlmaConfig(), {
          onAudio: (pcm) => this.onGeminiAudio(pcm),
          onTurnComplete: () => void this.finishSpeech(),
          onInterrupted: () => void this.interrupt(),
          onError: (error) => void this.fail(error),
        })
      }
      await this.liveController.start()
      if (generation !== this.startGeneration) {
        await this.stopLiveController()
        return
      }
      await this.playEarcon("listen-start")
      if (generation !== this.startGeneration) {
        await this.stopLiveController()
        return
      }
      this.subscribeMic()
      if (generation !== this.startGeneration) {
        this.stopMic()
        await this.stopLiveController()
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
      this.session.speaker.stop()
    } catch {
      /* host may reject a stale stop */
    }
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
    await this.stopLiveController()
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
    await this.stopLiveController()
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
      this.handlePcmFrame(chunk)
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

  private handlePcmFrame(chunk: AudioChunkData): void {
    if (!ACTIVE.has(this.connection) && this.connection !== "starting") return
    try {
      const normalized = normalizePcm16Audio(chunk)
      if (!this.sawMicFrame) {
        this.sawMicFrame = true
        this.clearFirstPcmTimeout()
      }
      this.liveController?.sendAudio(normalized)
    } catch (error) {
      void this.fail(error)
    }
  }

  private onGeminiAudio(base64Pcm: string): void {
    if (this.connection !== "listening" && this.connection !== "speaking") return
    if (this.connection !== "speaking") {
      this.connection = "speaking"
      this.pushSnapshot()
    }
    const write = this.writeSpeech(base64Pcm)
    this.pendingSpeechWrites.add(write)
    void write.finally(() => this.pendingSpeechWrites.delete(write))
  }

  private async writeSpeech(base64Pcm: string): Promise<void> {
    const epoch = this.speakerEpoch
    try {
      const writer = await this.ensureSpeechWriter(epoch)
      if (!writer || epoch !== this.speakerEpoch) return
      await writer.writeBase64(base64Pcm)
    } catch {
      if (epoch === this.speakerEpoch) await this.fail(new Error("speaker write failed"))
    }
  }

  private async ensureSpeechWriter(epoch: number): Promise<SpeakerWriter | null> {
    if (this.speakerWriter && epoch === this.speakerEpoch) return this.speakerWriter
    if (this.speakerOpenPromise) {
      const existing = await this.speakerOpenPromise
      if (epoch !== this.speakerEpoch) return null
      return existing
    }
    const opening = (async () => {
      const writer = (await this.session.speaker.createStream({
        sampleRate: 24000,
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
    this.speakerOpenPromise = opening
    const writer = await opening
    if (this.speakerOpenPromise === opening) this.speakerOpenPromise = null
    return writer
  }

  private async finishSpeech(): Promise<void> {
    const epoch = this.speakerEpoch
    await Promise.all(this.pendingSpeechWrites)
    if (epoch !== this.speakerEpoch) return
    const writer = this.speakerWriter ?? (await this.speakerOpenPromise)
    if (!writer || epoch !== this.speakerEpoch) {
      if (this.connection === "speaking") {
        this.connection = "listening"
        this.pushSnapshot()
      }
      return
    }
    try {
      await writer.close()
      if (this.speakerWriter === writer) this.speakerWriter = null
      if (epoch === this.speakerEpoch && this.connection === "speaking") {
        this.connection = "listening"
        this.pushSnapshot()
      }
    } catch {
      if (epoch === this.speakerEpoch) await this.fail(new Error("speaker close failed"))
    }
  }

  private async stopLiveController(): Promise<void> {
    const controller = this.liveController
    this.liveController = null
    if (controller) await controller.stop()
  }
}
