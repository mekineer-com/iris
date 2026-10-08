import type {AudioChunkData, MiniappSession, UnsubscribeFn} from "@mentra/miniapp/background"
import {makeRequestId} from "@mentra/miniapp"

import type {Channels} from "../shared/channels"
import type {ImageRequest} from "../shared/channels"
import type {
  ConnectionState,
  EarconName,
  ManualAction,
  ManualPhase,
  SessionMode,
  SessionSnapshot,
} from "../shared/types"
import {approxBase64ByteLength, normalizePcm16Audio} from "./audioHelpers"
import {GeminiLiveController, JOURNAL_KEY, journalSoulId} from "./GeminiLiveController"
import type {GeminiCallbacks} from "./GeminiLiveController"
import type {OpenAlmaConfig} from "./openAlmaConfig"
import {
  OPENALMA_PROFILE_KEY,
  parseOpenAlmaProfile,
  serializeOpenAlmaProfile,
} from "./openAlmaConfig"
import {installationHost, OPENALMA_HOST_KEY, reportInstallation} from "./installation"
import {timeoutSignal} from "./timeoutSignal"

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
  installationDefaults?: unknown
  fetchFn?: typeof fetch
  createLiveController?: (config: OpenAlmaConfig, callbacks: GeminiCallbacks) => GeminiLiveController
}

const ACTIVE: ReadonlySet<ConnectionState> = new Set(["starting", "reconnecting", "listening", "speaking"])
const MAX_MANUAL_AUDIO_BYTES = 16000 * 2 * 120
const MANUAL_LIMIT_MESSAGE = "Manual recording reached 120-second limit"
const MICROPHONE_ENABLED_KEY = "openalma.microphone-enabled"
const CAMERA_ENABLED_KEY = "openalma.camera-enabled"
const SOUL_ID_KEY = "openalma.soul-id"

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
  private soulId = ""
  private souls: string[] = []
  private soulLoading = true
  private soulConfirmed = false
  private soulSelecting = false
  private memuAvailable: boolean | null = null
  private recoverySoulId: string | null = null
  private manualPhase: ManualPhase = "idle"
  private microphoneEnabled = true
  private cameraEnabled = true
  private preferencesLoaded: Promise<void> = Promise.resolve()
  private photoRetryPending = false
  private manualAudio: string[] = []
  private manualAudioBytes = 0
  private manualResponseTimeout: ReturnType<typeof setTimeout> | null = null
  private interruptPromise: Promise<void> | null = null
  private lastError: string | null = null
  private usageTotalTokens: number | null = null
  private durationWarning = false
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
  private config?: OpenAlmaConfig
  private readonly installationDefaults?: unknown
  private readonly fetchFn: typeof fetch
  private readonly createLiveController: (config: OpenAlmaConfig, callbacks: GeminiCallbacks) => GeminiLiveController
  private liveController: GeminiLiveController | null

  constructor(
    private readonly session: MiniappSession,
    options: SessionControllerOptions = {},
  ) {
    this.installationDefaults = options.installationDefaults
    this.watchdogMs = options.watchdogMs ?? 3000
    // ponytail: one bound covers tiny local cues; split only if remote/long clips are introduced.
    this.earconTimeoutMs = options.earconTimeoutMs ?? 2000
    this.responseWatchdogMs = options.responseWatchdogMs ?? 60_000
    this.config = options.config
    this.soulId = options.config?.soulId ?? ""
    this.fetchFn = options.fetchFn ?? fetch
    this.createLiveController =
      options.createLiveController ??
      ((config, callbacks) => new GeminiLiveController(config, callbacks, {storage: this.session.storage}))
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
    this.preferencesLoaded = this.loadPreferences()
    this.unsubs.push(ui.onOpen(() => this.pushSnapshot()))
    this.unsubs.push(
      ui.handle("openalma:set-profile", async (payload) => {
        await this.preferencesLoaded
        if (this.connectionLocked()) {
          throw new Error("Wait for settings or stop this sitting before changing its connection")
        }
        let submitted = parseOpenAlmaProfile(payload)
        if (this.config && (submitted.deviceSessionId !== this.config.deviceSessionId || submitted.userId !== this.config.userId)) {
          throw new Error("Connection edits cannot change the owner or installation ID")
        }
        if (this.config) submitted = {...this.config, baseUrl: submitted.baseUrl}
        this.soulSelecting = true
        this.pushSnapshot()
        try {
          const identity = this.installationPending() ? undefined : await this.resolveProfileIdentity(submitted)
          const config = identity?.config ?? submitted
          await this.session.storage.set(OPENALMA_PROFILE_KEY, serializeOpenAlmaProfile(config))
          this.config = config
          this.soulLoading = true
          this.memuAvailable = null
          this.lastError = null
          this.preferencesLoaded = this.loadPreferences(identity)
          await this.preferencesLoaded
          if (this.installationPending()) throw new Error(this.lastError || "Installation is not confirmed")
          return {ok: true as const}
        } finally {
          this.soulSelecting = false
          this.pushSnapshot()
        }
      }),
    )
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
      ui.handle("openalma:set-soul", async (payload) => {
        await this.preferencesLoaded
        const value = payload as {soulId?: unknown; useExisting?: unknown} | null
        if (typeof value?.soulId !== "string" || typeof value?.useExisting !== "boolean") {
          throw new Error("Invalid soul selection")
        }
        if (this.soulLocked()) throw new Error("Finish or recover this sitting before changing souls")
        const soulId = value.soulId.trim()
        if (!soulId) throw new Error("Enter a soul name")
        this.soulSelecting = true
        this.pushSnapshot()
        try {
          const config = this.currentConfig()
          if (this.memuAvailable === false) {
            const identity = await this.resolveProfileIdentity(config)
            this.souls = identity.souls
            this.memuAvailable = true
            this.lastError = null
          }
          const response = await this.fetchFn(`${config.baseUrl}/integration/mentra/souls`, {
            method: "POST",
            signal: timeoutSignal(10_000),
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({soul_id: soulId, use_existing: value.useExisting}),
          })
          if (response.status === 409) {
            const detail = await response.json().catch(() => null) as {detail?: {reason?: unknown; message?: unknown}} | null
            if (detail?.detail?.reason === "existing_exact" && !value.useExisting) return {soulId, confirmationRequired: true as const}
            if (typeof detail?.detail?.message === "string") throw new Error(detail.detail.message)
          }
          if (!response.ok) throw new Error(`Soul selection failed (${response.status})`)
          const result = await response.json() as Partial<{soul_id: string; created: boolean}>
          if (result.soul_id !== soulId || typeof result.created !== "boolean") {
            throw new Error("Soul selection returned an invalid response")
          }
          const selectedSoul = result.soul_id
          await this.session.storage.set(SOUL_ID_KEY, selectedSoul)
          this.soulId = selectedSoul
          this.soulConfirmed = true
          if (!this.souls.includes(selectedSoul)) this.souls = [...this.souls, selectedSoul]
          await this.reportSelectedSoul()
          return {soulId: selectedSoul, created: result.created}
        } finally {
          this.soulSelecting = false
          this.pushSnapshot()
        }
      }),
    )
    this.unsubs.push(
      ui.handle("openalma:stop", async () => {
        await this.stopSession("user")
        return {ok: true as const}
      }),
    )
    this.unsubs.push(
      ui.handle("openalma:pending-image", async (payload) => {
        const action = (payload as {action?: string} | null)?.action
        await this.preferencesLoaded
        if (!this.liveController) throw new Error("Gemini controller is not available")
        if (action === "retry") await this.liveController.retryImage()
        else if (action === "discard") await this.liveController.discardImage()
        else throw new Error("Unknown pending photo action")
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
      ui.handle("openalma:set-capabilities", async (payload) => {
        await this.preferencesLoaded
        const next = payload as {
          microphoneEnabled?: unknown
          cameraEnabled?: unknown
        } | null
        if (
          (next?.microphoneEnabled === undefined && next?.cameraEnabled === undefined) ||
          (next.microphoneEnabled !== undefined && typeof next.microphoneEnabled !== "boolean") ||
          (next.cameraEnabled !== undefined && typeof next.cameraEnabled !== "boolean")
        ) {
          throw new Error("Invalid capability setting")
        }
        if (next.microphoneEnabled !== undefined) {
          await this.session.storage.set(
            MICROPHONE_ENABLED_KEY,
            next.microphoneEnabled ? "1" : "0",
          )
          this.microphoneEnabled = next.microphoneEnabled
          if (!this.microphoneEnabled && this.micUnsub) this.stopMic()
          else if (
            this.microphoneEnabled &&
            (this.connection === "listening" ||
              this.connection === "speaking" ||
              this.connection === "reconnecting")
          ) {
            this.subscribeMic()
          }
        }
        if (next.cameraEnabled !== undefined) {
          await this.session.storage.set(CAMERA_ENABLED_KEY, next.cameraEnabled ? "1" : "0")
          this.cameraEnabled = next.cameraEnabled
        }
        this.pushSnapshot()
        return {ok: true as const}
      }),
    )
    this.unsubs.push(
      ui.handle("openalma:manual-action", (payload) => {
        const action = (payload as {action?: ManualAction} | null)?.action
        if (!action || !["talk", "done", "redo", "send"].includes(action)) {
          throw new Error("Unknown Manual action")
        }
        this.handleManualAction(action)
        return {ok: true as const}
      }),
    )
    this.unsubs.push(
      ui.handle("openalma:image", async (payload) => {
        await this.preferencesLoaded
        if (!this.cameraEnabled) throw new Error("Camera is disabled")
        if (this.connection !== "listening" && this.connection !== "speaking") {
          throw new Error("Start Iris before sending a photo")
        }
        if (!this.liveController) throw new Error("Gemini is not ready")
        await this.liveController.sendImage(payload as ImageRequest)
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
      const config = this.currentConfig()
      await Promise.race([
        this.session.speaker.play({
          audioUrl: `${config.baseUrl}/integration/mentra/earcons/${name}.wav`,
          stopOtherAudio: true,
        }),
        new Promise<void>((resolve) => {
          timeout = setTimeout(() => {
            trace("session.earcon.timeout", {name})
            if (epoch === this.speakerEpoch) {
              this.lastError ??= "Audio cue unavailable; voice is still active"
              this.pushSnapshot()
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
      this.lastError ??= "Audio cue unavailable; voice is still active"
      this.pushSnapshot()
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }

  private snapshot(): SessionSnapshot {
    return {
      configured: Boolean(this.config),
      connectionProfile: this.config ? {baseUrl: this.config.baseUrl,
        userId: this.config.userId, deviceSessionId: this.config.deviceSessionId} : null,
      mode: this.mode,
      connection: this.connection,
      soulId: this.soulId,
      souls: this.souls,
      soulLoading: this.soulLoading,
      soulConfirmed: this.soulConfirmed,
      soulLocked: this.soulLocked(),
      connectionLocked: this.connectionLocked(),
      memuAvailable: this.memuAvailable,
      manualPhase: this.manualPhase,
      microphoneEnabled: this.microphoneEnabled,
      cameraEnabled: this.cameraEnabled,
      photoRetryPending: this.photoRetryPending,
      lastError: this.liveController?.activityPauseReason || this.lastError,
      usageTotalTokens: this.usageTotalTokens,
      durationWarning: this.durationWarning,
    }
  }

  private pushSnapshot(): void {
    this.send?.("openalma:update", this.snapshot())
  }

  private async startSession(mode: SessionMode): Promise<void> {
    if (this.soulSelecting) throw new Error("Wait for settings to finish")
    if (this.startInFlight || ACTIVE.has(this.connection) || this.connection === "stopping") {
      return
    }
    this.startInFlight = true
    const generation = ++this.startGeneration
    this.mode = mode
    this.photoRetryPending = false
    this.lastError = null
    this.usageTotalTokens = null
    this.durationWarning = false
    this.resetManualState()
    this.sawMicFrame = false
    this.connection = "starting"
    trace("session.start.requested", {mode})
    this.pushSnapshot()

    try {
      await this.preferencesLoaded
      if (generation !== this.startGeneration) return
      this.currentConfig()
      if (!this.soulId) throw new Error("Choose a soul before starting Iris")
      if (!this.soulConfirmed && !this.recoverySoulId) {
        throw new Error("Select or create this soul before starting Iris")
      }
      if (this.memuAvailable === false) {
        const identity = await this.resolveProfileIdentity(this.currentConfig())
        if (generation !== this.startGeneration) return
        this.souls = identity.souls
        this.memuAvailable = true
      }
      if (generation !== this.startGeneration) return
      this.recoverySoulId = this.soulId
      if (!this.liveController) {
        this.liveController = this.createLiveController({...this.currentConfig(), soulId: this.soulId}, {
          onAudio: (pcm) => this.onGeminiAudio(pcm),
          onTurnComplete: (finalResponse) => {
            if (this.connection === "starting") this.startupTurnComplete = true
            else this.queueFinishSpeech(finalResponse)
          },
          onInterrupted: () => {
            const interrupting = this.interrupt().finally(() => {
              if (this.interruptPromise === interrupting) this.interruptPromise = null
            })
            this.interruptPromise = interrupting
          },
          onReconnecting: (reconnecting) => {
            if (reconnecting && (this.connection === "listening" || this.connection === "speaking")) {
              this.connection = "reconnecting"
            } else if (!reconnecting && this.connection === "reconnecting") {
              this.connection = "listening"
              const generation = this.startGeneration
              void this.speechFinishTail.then(() => {
                if (generation === this.startGeneration && this.connection === "listening") {
                  return this.playEarcon("listen-start")
                }
              })
            }
            this.pushSnapshot()
          },
          onUsage: (totalTokens) => {
            this.usageTotalTokens = totalTokens
            this.pushSnapshot()
          },
          onDurationWarning: () => {
            this.durationWarning = true
            this.pushSnapshot()
          },
          onPhotoRetryChange: (pending) => {
            this.photoRetryPending = pending
            this.pushSnapshot()
          },
          onPersistenceError: (message) => {
            if (this.teardownKind === "fail") return
            if (message === null && this.lastError === MANUAL_LIMIT_MESSAGE) return
            this.lastError = message
            this.pushSnapshot()
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
      await this.preferencesLoaded
      if (generation !== this.startGeneration) {
        await this.stopLiveController(false, controller)
        return
      }
      if (this.microphoneEnabled) {
        this.subscribeMic()
        trace("session.microphone.subscribed")
      }
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
    const opening = this.speakerOpenPromise
    this.speakerWriter = null
    this.speakerOpenPromise = null
    if (!writer) {
      try {
        await opening
      } catch {
        /* stale opening failed on its own */
      }
      return
    }
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
    if (graceful) {
      await this.speechFinishTail
      await this.finishSpeech()
    } else {
      this.speechFinishTail = Promise.resolve()
      this.pendingSpeechWrites.clear()
    }
    if (generation !== this.startGeneration) return

    await this.refreshRecoveryLock()

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

  reportInstallationError(): void {
    if (this.connection !== "idle") return
    this.memuAvailable = false
    this.pushSnapshot()
  }

  private async reportSelectedSoul(): Promise<void> {
    if (process.env.NODE_ENV !== "production" || !this.config || this.installationPending()) return
    try {
      const host = installationHost(await this.session.storage.get(OPENALMA_HOST_KEY))
      await reportInstallation({...this.currentConfig(), soulId: this.soulId}, this.fetchFn, host)
    } catch (error) {
      console.error("[OpenAlma] installation report failed:", error)
      this.lastError ??= error instanceof Error ? error.message : String(error)
      this.reportInstallationError()
    }
  }

  private subscribeMic(): void {
    this.stopMic()
    this.sawMicFrame = false
    this.micUnsub = this.session.mic.onAudioChunk((chunk) => {
      this.handlePcmFrame(chunk)
    })
    this.startFirstPcmWatchdog()
  }

  private stopMic(): void {
    this.clearFirstPcmTimeout()
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
    if (!ACTIVE.has(this.connection)) return
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
    if (this.manualPhase === "submitted") this.clearManualResponseWatchdog()
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

  private async finishSpeech(finalResponse = true): Promise<void> {
    const epoch = this.speakerEpoch
    await Promise.all(this.pendingSpeechWrites)
    if (this.interruptPromise) await this.interruptPromise
    if (epoch !== this.speakerEpoch) return
    try {
      const writer = this.speakerWriter ?? (await this.speakerOpenPromise)
      if (!writer || epoch !== this.speakerEpoch) {
        const manualFinished = finalResponse && this.completeManualResponse()
        if (this.connection === "speaking") {
          this.connection = "listening"
          this.pushSnapshot()
        } else if (manualFinished) {
          this.pushSnapshot()
        }
        return
      }
      await writer.close()
      if (this.speakerWriter === writer) this.speakerWriter = null
      if (epoch === this.speakerEpoch) {
        const manualFinished = finalResponse && this.completeManualResponse()
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

  private queueFinishSpeech(finalResponse = true): void {
    this.speechFinishTail = this.speechFinishTail.then(() => this.finishSpeech(finalResponse))
  }

  private handleManualAction(action: ManualAction): void {
    if (this.mode !== "manual") throw new Error("Manual controls require Manual mode")
    if (this.connection !== "listening") throw new Error("Manual controls require a ready session")
    if (this.liveController?.activityPauseReason && (action === "talk" || action === "send")) return
    if ((action === "talk" || action === "redo") && !this.microphoneEnabled) {
      throw new Error("Microphone is disabled")
    }
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
      this.lastError = null
      this.manualPhase = "submitted"
      this.beginManualResponse()
    }
    this.pushSnapshot()
  }

  private clearManualAudio(): void {
    this.manualAudio = []
    this.manualAudioBytes = 0
  }

  private async loadPreferences(
    resolvedIdentity?: {config: OpenAlmaConfig; souls: string[]},
  ): Promise<void> {
    let storedSoul: string | null = null
    try {
      let [storedProfile, microphone, camera, savedSoul, journal] = await Promise.all([
        this.session.storage.get(OPENALMA_PROFILE_KEY),
        this.session.storage.get(MICROPHONE_ENABLED_KEY),
        this.session.storage.get(CAMERA_ENABLED_KEY),
        this.session.storage.get(SOUL_ID_KEY),
        this.session.storage.get(JOURNAL_KEY),
      ])
      const host = installationHost(await this.session.storage.get(OPENALMA_HOST_KEY))
      if (!this.config && storedProfile === null && this.installationDefaults !== undefined) {
        const raw = this.installationDefaults as Partial<OpenAlmaConfig> | null
        const defaults = parseOpenAlmaProfile(host ? raw : {...raw,
          deviceSessionId: makeRequestId(), installationTicket: raw?.installationTicket ?? "", installationConfirmed: false})
        if (host && defaults.deviceSessionId !== host.deviceSessionId) {
          throw new Error("Install Iris from its OpenAlma Mentra row in the launcher")
        }
        storedProfile = serializeOpenAlmaProfile(defaults)
        if (defaults.installationTicket) this.config = defaults
        else await this.session.storage.set(OPENALMA_PROFILE_KEY, storedProfile)
      }
      if (!this.config && storedProfile === null) {
        this.soulLoading = false
        this.pushSnapshot()
        return
      }
      if (!this.config) this.config = parseOpenAlmaProfile(storedProfile)
      const ticket = (this.installationDefaults as Partial<OpenAlmaConfig> | null)?.installationTicket
      if (!host && ticket !== undefined && ticket !== this.config.installationTicket) {
        this.config = parseOpenAlmaProfile({...this.config, installationTicket: ticket, installationConfirmed: false})
      }
      let config = this.config
      storedSoul = savedSoul
      this.microphoneEnabled = microphone !== "0"
      this.cameraEnabled = camera !== "0"
      this.soulId = storedSoul?.trim() || config.soulId
      this.recoverySoulId = journalSoulId(journal, config)
      if (this.recoverySoulId) this.soulId = this.recoverySoulId
      if (this.installationPending()) {
        await this.session.storage.set(OPENALMA_PROFILE_KEY, serializeOpenAlmaProfile(config))
        await reportInstallation({...config, soulId: this.soulId}, this.fetchFn, host)
        const confirmed = {...config, installationConfirmed: true}
        await this.session.storage.set(OPENALMA_PROFILE_KEY, serializeOpenAlmaProfile(confirmed))
        this.config = config = confirmed
      }
      const identity = resolvedIdentity ?? await this.resolveProfileIdentity(config)
      this.config = identity.config
      this.souls = identity.souls
      this.memuAvailable = true
    } catch (error) {
      this.memuAvailable = false
      this.lastError = error instanceof Error ? error.message : String(error)
    }
    this.soulConfirmed = !this.installationPending() && Boolean(this.recoverySoulId || (storedSoul?.trim() && this.souls.includes(this.soulId)))
    this.soulLoading = false
    this.pushSnapshot()
    await this.reportSelectedSoul()
  }

  private currentConfig(): OpenAlmaConfig {
    if (!this.config) throw new Error("Set up the OpenAlma connection first")
    if (this.installationPending()) throw new Error("Installation is not confirmed; edit the connection or reopen Iris to retry")
    return this.config
  }

  private installationPending(): boolean {
    return Boolean(this.config?.installationTicket && !this.config.installationConfirmed)
  }

  private async resolveProfileIdentity(
    config: OpenAlmaConfig,
  ): Promise<{config: OpenAlmaConfig; souls: string[]}> {
    const ownerResponse = await this.fetchFn(`${config.baseUrl}/integration/mentra/owner`, {
      signal: timeoutSignal(10_000),
    })
    if (!ownerResponse.ok) throw new Error(`Owner discovery failed (${ownerResponse.status})`)
    const ownerResult = await ownerResponse.json() as Partial<{user_id: unknown}>
    if (ownerResult.user_id !== null && typeof ownerResult.user_id !== "string") {
      throw new Error("Owner discovery returned an invalid response")
    }

    const userId = ownerResult.user_id?.trim() ?? ""
    if (!userId) throw new Error("Set up the OpenAlma owner in the launcher")
    if (userId !== config.userId) {
      throw new Error(`Connection user does not match OpenAlma owner "${userId}"`)
    }
    const soulsResponse = await this.fetchFn(`${config.baseUrl}/integration/mentra/souls`, {
      signal: timeoutSignal(10_000),
    })
    if (!soulsResponse.ok) throw new Error(`Soul discovery failed (${soulsResponse.status})`)
    const soulsResult = await soulsResponse.json() as Partial<{souls: unknown}>
    if (!Array.isArray(soulsResult.souls) || soulsResult.souls.some((soul) => typeof soul !== "string")) {
      throw new Error("Soul discovery returned an invalid response")
    }

    return {config: {...config, userId}, souls: soulsResult.souls}
  }

  private connectionLocked(): boolean {
    return this.soulLoading || this.soulSelecting || ACTIVE.has(this.connection) ||
      this.connection === "stopping"
  }

  private soulLocked(): boolean {
    return this.connectionLocked() || this.installationPending() || this.recoverySoulId !== null
  }

  private async refreshRecoveryLock(): Promise<void> {
    if (this.installationPending()) return
    try {
      this.recoverySoulId = journalSoulId(await this.session.storage.get(JOURNAL_KEY), this.currentConfig())
    } catch {
      this.lastError = "Local recovery state unavailable; reopen Iris to retry"
    }
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

  private beginManualResponse(): void {
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
