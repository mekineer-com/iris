import type {AudioChunkData, MiniappSession, UnsubscribeFn} from "@mentra/miniapp/background"

import type {Channels} from "../shared/channels"
import type {
  ConnectionState,
  EarconName,
  ManualAction,
  ManualPhase,
  SessionMode,
  SessionSnapshot,
} from "../shared/types"
import {approxBase64ByteLength, normalizePcm16Audio} from "./audioHelpers"
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
  earconTimeoutMs?: number
  responseWatchdogMs?: number
  config?: OpenAlmaConfig
  createLiveController?: (config: OpenAlmaConfig, callbacks: GeminiCallbacks) => GeminiLiveController
}

const ACTIVE: ReadonlySet<ConnectionState> = new Set(["starting", "listening", "speaking"])
const MAX_MANUAL_AUDIO_BYTES = 16000 * 2 * 120
const MANUAL_LIMIT_MESSAGE = "Manual recording reached 120-second limit"

function trace(event: string, detail: Record<string, unknown> = {}): void {
  if (process.env.NODE_ENV === "test") return
  console.info(`[OpenAlma] ${new Date().toISOString()} ${event}`, detail)
}

export class SessionController {
  private started = false
  private readonly unsubs: Array<() => void> = []
  private send: Send | null = null

  private mode: SessionMode = "continuous"
  private connection: ConnectionState = "idle"
  private manualPhase: ManualPhase = "idle"
  private manualAudio: string[] = []
  private manualAudioBytes = 0
  private manualResponseTimeout: ReturnType<typeof setTimeout> | null = null
  private lastError: string | null = null
  private startInFlight = false
  private startGeneration = 0
  private speakerEpoch = 0
  private speakerWriter: SpeakerWriter | null = null
  private speakerOpenPromise: Promise<SpeakerWriter | null> | null = null
  private readonly pendingSpeechWrites = new Set<Promise<void>>()
  private startupAudio: string[] = []
  private startupTurnComplete = false
  private speechFinishTail: Promise<void> = Promise.resolve()
  private micUnsub: UnsubscribeFn | null = null
  private firstPcmTimeout: ReturnType<typeof setTimeout> | null = null
  private sawMicFrame = false
  private teardownKind: "stop" | "fail" | null = null
  private teardownPromise: Promise<void> | null = null
  private readonly watchdogMs: number
  private readonly earconTimeoutMs: number
  private readonly responseWatchdogMs: number
  private readonly config?: OpenAlmaConfig
  private readonly createLiveController: (config: OpenAlmaConfig, callbacks: GeminiCallbacks) => GeminiLiveController
  private liveController: GeminiLiveController | null

  constructor(
    private readonly session: MiniappSession,
    options: SessionControllerOptions = {},
  ) {
    this.watchdogMs = options.watchdogMs ?? 3000
    // ponytail: one bound covers tiny local cues; split only if remote/long clips are introduced.
    this.earconTimeoutMs = options.earconTimeoutMs ?? 2000
    this.responseWatchdogMs = options.responseWatchdogMs ?? 60_000
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
        if (mode !== "continuous" && mode !== "manual") throw new Error("Unknown speech mode")
        if (this.connection !== "idle" && this.connection !== "error") {
          throw new Error("Stop before changing speech mode")
        }
        this.mode = mode
        this.resetManualState()
        this.pushSnapshot()
        return {ok: true as const}
      }),
    )
    this.unsubs.push(
      ui.handle("openalma:manual-action", (payload) => {
        const action = (payload as {action?: ManualAction} | null)?.action
        if (!action) throw new Error("Manual action is required")
        this.handleManualAction(action)
        return {ok: true as const}
      }),
    )
  }

  async interrupt(): Promise<void> {
    this.speakerEpoch += 1
    await this.abortCurrentWriter()
    const manualFinished = this.completeManualResponse()
    if (this.connection === "speaking") {
      this.connection = "listening"
      this.pushSnapshot()
    } else if (manualFinished) {
      this.pushSnapshot()
    }
  }

  async playEarcon(name: EarconName): Promise<void> {
    const epoch = this.speakerEpoch
    let timeout: ReturnType<typeof setTimeout> | null = null
    try {
      const config = this.config ?? readOpenAlmaConfig()
      await Promise.race([
        this.session.speaker.play({
          audioUrl: `${config.baseUrl}/integration/mentra/earcons/${name}.wav`,
          stopOtherAudio: true,
        }),
        new Promise<void>((resolve) => {
          timeout = setTimeout(() => {
            trace("session.earcon.timeout", {name})
            if (epoch === this.speakerEpoch) {
              try {
                this.session.speaker.stop()
              } catch {
                /* host may reject a stale stop */
              }
            }
            resolve()
          }, this.earconTimeoutMs)
        }),
      ])
    } catch {
      /* a missing cue must not block voice */
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }

  private snapshot(): SessionSnapshot {
    return {
      mode: this.mode,
      connection: this.connection,
      manualPhase: this.manualPhase,
      lastError: this.lastError,
    }
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
    this.resetManualState()
    this.sawMicFrame = false
    this.connection = "starting"
    trace("session.start.requested", {mode})
    this.pushSnapshot()

    try {
      if (!this.liveController) {
        this.liveController = this.createLiveController(this.config ?? readOpenAlmaConfig(), {
          onAudio: (pcm) => this.onGeminiAudio(pcm),
          onTurnComplete: () => {
            if (this.connection === "starting") this.startupTurnComplete = true
            else this.queueFinishSpeech()
          },
          onInterrupted: () => void this.interrupt(),
          onPersistenceError: (message) => {
            if (message || this.lastError === "Transcript sync failed; retrying") {
              this.lastError = message
              this.pushSnapshot()
            }
          },
          onError: (error) => void this.fail(error),
        })
      }
      const controller = this.liveController
      await controller.start(mode)
      trace("session.provider.ready")
      if (generation !== this.startGeneration) {
        await this.stopLiveController(false, controller)
        return
      }
      trace("session.start_earcon.begin")
      await this.playEarcon("listen-start")
      trace("session.start_earcon.end")
      if (generation !== this.startGeneration) {
        await this.stopLiveController(false, controller)
        return
      }
      this.subscribeMic()
      trace("session.microphone.subscribed")
      if (generation !== this.startGeneration) {
        this.stopMic()
        await this.stopLiveController(false, controller)
        return
      }
      this.connection = "listening"
      trace("session.listening")
      this.pushSnapshot()
      for (const pcm of this.startupAudio.splice(0)) this.onGeminiAudio(pcm)
      if (this.startupTurnComplete) {
        this.startupTurnComplete = false
        this.queueFinishSpeech()
      }
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
    this.startupAudio = []
    this.startupTurnComplete = false
    this.resetManualState()
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
    if (this.teardownPromise) {
      if (_reason === "user" && this.teardownKind === "fail") {
        this.teardownKind = "stop"
        this.lastError = null
      }
      await this.teardownPromise
      return
    }
    this.teardownKind = "stop"
    this.teardownPromise = this.runTeardown().finally(() => {
      this.teardownPromise = null
    })
    await this.teardownPromise
  }

  private async fail(error: unknown): Promise<void> {
    if (this.connection === "idle" || this.connection === "error" || this.teardownPromise) return
    this.lastError = error instanceof Error ? error.message : String(error)
    this.teardownKind = "fail"
    this.teardownPromise = this.runTeardown().finally(() => {
      this.teardownPromise = null
    })
    await this.teardownPromise
  }

  private async runTeardown(): Promise<void> {
    const graceful = this.teardownKind === "stop"
    const generation = this.beginTeardown(this.teardownKind ?? "fail")
    trace("session.stop.begin", {kind: this.teardownKind, graceful})
    this.pushSnapshot()
    await this.abortCurrentWriter()
    trace("session.speaker.aborted")
    await this.stopLiveController(graceful)
    trace("session.provider.stopped")
    await this.speechFinishTail
    await this.finishSpeech()
    if (generation !== this.startGeneration) return

    if (this.teardownKind === "stop") {
      try {
        await this.playEarcon("listen-stop")
      } catch {
        /* ignore */
      }
      this.connection = "idle"
      trace("session.idle")
    } else {
      try {
        await this.playEarcon("disconnected")
      } catch {
        /* ignore */
      }
      this.connection = "error"
      trace("session.error", {error: this.lastError})
    }
    if (generation !== this.startGeneration) return
    this.teardownKind = null
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
    if (this.connection === "speaking") return
    try {
      const normalized = normalizePcm16Audio(chunk)
      if (!this.sawMicFrame) {
        this.sawMicFrame = true
        trace("session.microphone.first_frame")
        this.clearFirstPcmTimeout()
      }
      if (this.mode === "continuous") {
        this.liveController?.sendAudio(normalized)
        return
      }
      if (this.manualPhase !== "recording") return
      const bytes = approxBase64ByteLength(normalized)
      if (this.manualAudioBytes + bytes > MAX_MANUAL_AUDIO_BYTES) {
        this.manualPhase = "review"
        this.lastError = MANUAL_LIMIT_MESSAGE
        this.pushSnapshot()
        return
      }
      this.manualAudio.push(normalized)
      this.manualAudioBytes += bytes
    } catch (error) {
      void this.fail(error)
    }
  }

  private onGeminiAudio(base64Pcm: string): void {
    const reflection = this.connection === "stopping" && this.teardownKind === "stop"
    if (this.connection === "starting") {
      this.startupAudio.push(base64Pcm)
      return
    }
    if (!reflection && this.connection !== "listening" && this.connection !== "speaking") return
    if (!reflection && this.connection !== "speaking") {
      this.connection = "speaking"
      trace("session.speaking")
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
    try {
      return await opening
    } finally {
      if (this.speakerOpenPromise === opening) this.speakerOpenPromise = null
    }
  }

  private async finishSpeech(): Promise<void> {
    const epoch = this.speakerEpoch
    await Promise.all(this.pendingSpeechWrites)
    if (epoch !== this.speakerEpoch) return
    const writer = this.speakerWriter ?? (await this.speakerOpenPromise)
    if (!writer || epoch !== this.speakerEpoch) {
      const manualFinished = this.completeManualResponse()
      if (this.connection === "speaking") {
        this.connection = "listening"
        this.pushSnapshot()
      } else if (manualFinished) {
        this.pushSnapshot()
      }
      return
    }
    try {
      await writer.close()
      if (this.speakerWriter === writer) this.speakerWriter = null
      if (epoch === this.speakerEpoch) {
        const manualFinished = this.completeManualResponse()
        if (this.connection === "speaking") {
          this.connection = "listening"
          trace("session.listening")
          this.pushSnapshot()
        } else if (manualFinished) {
          this.pushSnapshot()
        }
      }
    } catch {
      if (epoch === this.speakerEpoch) await this.fail(new Error("speaker close failed"))
    }
  }

  private queueFinishSpeech(): void {
    this.speechFinishTail = this.speechFinishTail.then(() => this.finishSpeech())
  }

  private handleManualAction(action: ManualAction): void {
    if (this.mode !== "manual") throw new Error("Manual controls require Manual mode")
    if (this.connection !== "listening") throw new Error("Manual controls require a ready session")
    if (action === "talk") {
      if (this.manualPhase !== "idle") throw new Error("Manual recording is already active")
      this.clearManualAudio()
      this.lastError = null
      this.manualPhase = "recording"
    } else if (action === "done") {
      if (this.manualPhase !== "recording") throw new Error("No Manual recording is active")
      if (this.manualAudio.length === 0) throw new Error("No audio was recorded")
      this.manualPhase = "review"
    } else if (action === "redo") {
      if (this.manualPhase !== "review") throw new Error("Redo requires a recording in Review")
      this.clearManualAudio()
      this.lastError = null
      this.manualPhase = "recording"
    } else {
      if (this.manualPhase !== "review") throw new Error("Send requires a recording in Review")
      if (!this.liveController) throw new Error("Gemini controller is not available")
      this.liveController.sendActivity(this.manualAudio)
      this.clearManualAudio()
      this.manualPhase = "submitted"
      this.startManualResponseWatchdog()
    }
    this.pushSnapshot()
  }

  private clearManualAudio(): void {
    this.manualAudio = []
    this.manualAudioBytes = 0
  }

  private resetManualState(): void {
    this.clearManualAudio()
    this.manualPhase = "idle"
    this.clearManualResponseWatchdog()
  }

  private completeManualResponse(): boolean {
    if (this.manualPhase !== "submitted") return false
    this.manualPhase = "idle"
    this.clearManualResponseWatchdog()
    return true
  }

  private startManualResponseWatchdog(): void {
    this.clearManualResponseWatchdog()
    this.manualResponseTimeout = setTimeout(() => {
      if (this.manualPhase === "submitted") {
        void this.fail(new Error("Gemini did not answer the Manual recording"))
      }
    }, this.responseWatchdogMs)
  }

  private clearManualResponseWatchdog(): void {
    if (!this.manualResponseTimeout) return
    clearTimeout(this.manualResponseTimeout)
    this.manualResponseTimeout = null
  }

  private async stopLiveController(
    graceful = false,
    expected?: GeminiLiveController,
  ): Promise<void> {
    if (expected && this.liveController !== expected) return
    const controller = this.liveController
    this.liveController = null
    if (controller) await controller.stop(graceful)
  }
}
