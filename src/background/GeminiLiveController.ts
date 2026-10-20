import {approxBase64ByteLength} from "./audioHelpers"
import {timeoutSignal} from "./timeoutSignal"
import type {OpenAlmaConfig} from "./openAlmaConfig"
import type {ImageRequest} from "../shared/channels"
import {MIC_SOURCES, PHOTO_RETRY_MESSAGE, type MicSource, type SessionMode} from "../shared/types"

type StartResponse = {
  session_id: string
  next_transcript_sequence: number
  ephemeral_token: string
  websocket: {
    api_version: string
    method: string
    input_audio_rate_hz: number
    output_audio_rate_hz: number
  }
  lease_seconds: number
  session_warning_seconds: number
}

export type GeminiCallbacks = {
  onAudio: (base64Pcm: string) => void
  onTurnComplete: (finalResponse: boolean) => void
  onInterrupted: () => void
  onReconnecting: (reconnecting: boolean) => void
  onUsage: (totalTokens: number) => void
  onDurationWarning: () => void
  onPhotoRetryChange: (pending: boolean) => void
  onPersistenceError: (message: string | null) => void
  onError: (error: Error) => void
}

type TranscriptEvent = {
  event_id: string
  sequence: number
  event_kind: "transcript" | "sitting_summary" | "image" | "photo_caption" | "transcript_gap"
  role: "user" | "assistant"
  content: string
  status?: "complete" | "interrupted"
  media_ref?: string
  mic_source?: MicSource
}

type PendingImage = {
  imageId: string
  mediaRef: string
  providerSent: boolean
  captureAfterCurrent: boolean
  generation: number
  sessionId: string
  imageSequence?: number
  caption?: string
  assistantSequence?: number
  speakDescription?: boolean
  retryRequested?: boolean
}

type StorageLike = {
  get(key: string): Promise<string | null>
  keys(): Promise<string[]>
  set(key: string, value: string): Promise<void>
}

type SessionJournal = {
  version: 1
  scope: {userId: string; soulId: string; deviceSessionId: string}
  resumption: {handle: string; updatedAt: number} | null
  pendingTranscripts: TranscriptEvent[]
  pendingImage?: PendingImage | null
}

type PendingToolCall = {
  name: string
  generation: number
  sessionId: string
  response?: string | Record<string, unknown>
}

function trace(event: string, detail: Record<string, unknown> = {}): void {
  if (process.env.NODE_ENV === "test") return
  console.info(`[OpenAlma] ${new Date().toISOString()} ${event}`, detail)
}

type SocketLike = {
  readyState: number
  send(data: string): void
  close(): void
  addEventListener(type: "open" | "message" | "error" | "close", listener: (event: any) => void): void
}

export type GeminiLiveControllerOptions = {
  fetchFn?: typeof fetch
  openSocket?: (url: string) => SocketLike
  setupTimeoutMs?: number
  heartbeatMs?: number
  photoDrainTimeoutMs?: number
  storage?: StorageLike
}

const WS_OPEN = 1
const REQUEST_TIMEOUT_MS = 10_000
const TRANSCRIPT_CONTENT_LIMIT = 16_000
const SNAPSHOT_TIMEOUT_MS = 120_000
const PHOTO_UPLOAD_UNCONFIRMED_MESSAGE = "Photo may have been saved. Retry checks the original."
const TOOL_TIMEOUT_MS = 30_000
const WRITE_UNCERTAINTY_MESSAGE =
  "Write outcome is uncertain; it may have saved. Read current working state before deciding whether to try again."
const REFLECTION_TIMEOUT_MS = 8_000
const PHOTO_DRAIN_TIMEOUT_MS = 8_000
const RECONNECT_SETUP_ATTEMPTS = 6
const GO_AWAY_MARGIN_MS = 2_000
export const JOURNAL_KEY = "openalma:gemini-session-v1"
export const RECOVERED_CHATS_KEY = "openalma:recovered-chats"
const RESUMPTION_MAX_AGE_MS = 30 * 60 * 1000
export const SITTING_REFLECTION_PROMPT =
  "Reflect briefly in first person on the emotional tone, subtext, or meaningful shift in this sitting that the literal transcript may not preserve. Do not recap the conversation. Respond with one or two natural sentences, or exactly NO_SUMMARY if nothing worthwhile would be added."
export const PHOTO_CAPTION_INSTRUCTION =
  "If a photo successfully arrives, use save_photo_caption(image_id, caption) to save your perception of the photo, so you will remember what this moment was about later on. Do not speak the caption out loud."

function selectJournalKey(keys: string[], fresh = false): string {
  const prefix = `${JOURNAL_KEY}:`
  let generation = 0
  for (const key of keys) {
    const suffix = key.slice(prefix.length)
    const value = Number(suffix)
    if (key.startsWith(prefix) && Number.isSafeInteger(value) && String(value) === suffix && value > generation) {
      generation = value
    }
  }
  generation += Number(fresh)
  return generation ? `${prefix}${generation}` : JOURNAL_KEY
}

async function readJournalValue(storage: Pick<StorageLike, "get" | "keys">, key: string, keys?: string[]): Promise<string | null> {
  const raw = await storage.get(key)
  if (raw === null && (keys ?? await storage.keys()).includes(key)) throw new Error("Local transcript backup could not be read")
  return raw
}

export async function readSessionJournal(storage: Pick<StorageLike, "get" | "keys">) {
  let keys: string[]
  try { keys = await storage.keys() } catch { return {key: null, raw: null, unreadable: true} }
  const key = selectJournalKey(keys)
  try {
    const raw = await readJournalValue(storage, key, keys)
    return {key, raw: raw || null, unreadable: false}
  } catch {
    return {key: selectJournalKey(keys, true), raw: null, unreadable: true}
  }
}

export function journalSoulId(raw: string | null, config: Pick<OpenAlmaConfig, "userId" | "deviceSessionId">): string | null {
  try {
    const journal = JSON.parse(raw ?? "") as Partial<SessionJournal>
    const scope = journal.scope
    if (
      journal.version !== 1 ||
      scope?.userId !== config.userId ||
      scope.deviceSessionId !== config.deviceSessionId ||
      typeof scope.soulId !== "string" ||
      !scope.soulId.trim()
    ) return null
    if (
      !journal.pendingTranscripts?.length && !journal.pendingImage &&
      !(journal.resumption?.handle?.trim() && Number.isFinite(journal.resumption.updatedAt) &&
        Date.now() - journal.resumption.updatedAt <= RESUMPTION_MAX_AGE_MS)
    ) return null
    return scope.soulId
  } catch {
    return null
  }
}

class TokenRefreshError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message)
  }
}

export class GeminiLiveController {
  private readonly fetchFn: typeof fetch
  private readonly openSocket: (url: string) => SocketLike
  private readonly setupTimeoutMs: number
  private readonly heartbeatMs?: number
  private readonly photoDrainTimeoutMs: number
  private readonly storage?: StorageLike
  private socket: SocketLike | null = null
  private token = ""
  private sessionId = ""
  private nextTranscriptSequence = 1
  private resumptionHandle = ""
  private resumptionUpdatedAt = 0
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private durationWarningTimer: ReturnType<typeof setTimeout> | null = null
  private goAwayTimer: ReturnType<typeof setTimeout> | null = null
  private goAwayPending = false
  private goAwayDeadlineAt = 0
  private stopping = false
  private ended = true
  private reconnectAttempted = false
  private backgroundImageErrorVisible = false
  activityPauseReason: string | null = null
  private reconnecting = false
  private errorReported = false
  private inputTranscript = ""
  private outputTranscript = ""
  private turnMicSource: MicSource | undefined
  private interruptionFinalized = false
  private turnActive = false
  private turnHasToolCall = false
  private turnAudioDelivered = false
  private voiceActive = false
  private hasCompletedProviderTurn = false
  private completeUserTurns = 0
  private pendingEvents: TranscriptEvent[] = []
  private pendingImage: PendingImage | null = null
  private acceptedCaptions = new Map<string, string>()
  private spokenPhotos: string[] = []
  private describingPhoto = false
  private imageUpload: Promise<void> | null = null
  private draining = false
  private outputMuted = false
  private drainDeadlineAt = 0
  private drainResolve: (() => void) | null = null
  private imageRetrying = false
  private appendTail: Promise<void> = Promise.resolve()
  private imageFinalization: Promise<void> | null = null
  private imageFinalizationExplicit = false
  private journalTail: Promise<void> = Promise.resolve()
  private journalLoaded = false
  private journalKey: string | null = JOURNAL_KEY
  private loadedJournal: string | null = null
  private persistenceFatal = false
  private journalUnavailable = false
  private reflecting = false
  private reflectionResolve: ((value: string | null) => void) | null = null
  private stopPromise: Promise<void> | null = null
  private generation = 0
  private ready = false
  private pendingToolCalls = new Map<string, PendingToolCall>()
  private deliveredToolResultIds = new Set<string>()
  private audioFramesSent = 0
  private providerAudioChunks = 0
  private mode: SessionMode = "continuous"
  private latestUsageTotal: number | null = null
  private leaseDurationMs = 0
  private lastHeartbeatSuccessAt = 0

  constructor(
    private readonly config: OpenAlmaConfig,
    private readonly callbacks: GeminiCallbacks,
    options: GeminiLiveControllerOptions = {},
  ) {
    this.fetchFn = options.fetchFn ?? fetch
    this.openSocket = options.openSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike)
    this.setupTimeoutMs = options.setupTimeoutMs ?? REQUEST_TIMEOUT_MS
    this.heartbeatMs = options.heartbeatMs
    this.photoDrainTimeoutMs = options.photoDrainTimeoutMs ?? PHOTO_DRAIN_TIMEOUT_MS
    this.storage = options.storage
  }

  async start(mode: SessionMode = "continuous"): Promise<void> {
    trace("provider.start.begin")
    const generation = ++this.generation
    await this.journalTail
    if (generation !== this.generation) throw new Error("Gemini start cancelled")
    this.stopping = false
    this.activityPauseReason = null
    this.ready = false
    this.ended = true
    this.resumptionHandle = ""
    this.resumptionUpdatedAt = 0
    this.reconnectAttempted = false
    this.reconnecting = false
    this.errorReported = false
    this.clearTurn()
    this.interruptionFinalized = false
    this.turnActive = false
    this.turnHasToolCall = false
    this.voiceActive = false
    this.hasCompletedProviderTurn = false
    this.completeUserTurns = 0
    this.pendingEvents = []
    this.pendingImage = null
    this.acceptedCaptions.clear()
    this.spokenPhotos = []
    this.describingPhoto = false
    this.imageUpload = null
    this.draining = false
    this.outputMuted = false
    this.drainResolve = null
    this.imageRetrying = false
    this.appendTail = Promise.resolve()
    this.imageFinalization = null
    this.imageFinalizationExplicit = false
    this.persistenceFatal = false
    this.journalUnavailable = false
    this.journalLoaded = false
    this.loadedJournal = null
    this.reflecting = false
    this.reflectionResolve = null
    this.stopPromise = null
    this.pendingToolCalls.clear()
    this.deliveredToolResultIds.clear()
    this.audioFramesSent = 0
    this.providerAudioChunks = 0
    this.mode = mode
    this.latestUsageTotal = null
    this.clearDurationWarning()
    this.clearGoAway()
    try {
      await this.hydrateJournal(generation)
      if (this.stopping || generation !== this.generation) throw new Error("Gemini start cancelled")
      const response = await this.requestStart(mode)
      if (this.stopping || generation !== this.generation) {
        await this.endLease()
        throw new Error("Gemini start cancelled")
      }
      await this.reconcileJournal()
      trace("provider.bootstrap.ready")
      this.token = response.ephemeral_token
      this.leaseDurationMs = response.lease_seconds * 1000
      this.lastHeartbeatSuccessAt = Date.now()
      if (generation !== this.generation) {
        await this.endLease()
        throw new Error("Gemini start cancelled")
      }
      const hydratedHandle = this.resumptionHandle
      try {
        await this.connectSocket(hydratedHandle)
      } catch (error) {
        if (!hydratedHandle || generation !== this.generation) throw error
        this.socket?.close()
        this.socket = null
        try {
          await this.connectSocket("")
          this.resumptionHandle = ""
          this.resumptionUpdatedAt = 0
          await this.persistJournal()
        } catch (coldError) {
          if (!this.stopping && generation === this.generation) {
            this.resumptionHandle = hydratedHandle
            await this.persistJournal()
          }
          throw coldError
        }
      }
      trace("provider.socket.ready")
      if (generation !== this.generation) throw new Error("Gemini start cancelled")
      this.heartbeatTimer = setInterval(
        () => void this.heartbeat(),
        this.heartbeatMs ?? Math.floor((response.lease_seconds * 1000) / 3),
      )
      if (response.session_warning_seconds > 0) {
        const sittingId = response.session_id
        this.durationWarningTimer = setTimeout(() => {
          if (!this.stopping && this.sessionId === sittingId) this.callbacks.onDurationWarning()
        }, response.session_warning_seconds * 1000)
      }
      if (this.pendingEvents.length) this.scheduleAppend()
    } catch (error) {
      await this.stop()
      throw error
    }
  }

  sendAudio(base64Pcm: string, micSource?: MicSource): void {
    if (this.activityPauseReason || this.stopPromise) return
    if (!this.ready && !this.stopping) {
      // ponytail: drop audio during the single reconnect; add a bounded queue only if field tests show speech loss.
      return
    }
    if (!this.socket || this.socket.readyState !== WS_OPEN) return
    this.sendAudioToSocket(this.socket, base64Pcm)
    this.turnMicSource = micSource
  }

  sendActivity(audioChunks: readonly string[], micSource?: MicSource): void {
    if (this.activityPauseReason) throw new Error(this.activityPauseReason)
    const socket = this.socket
    if (this.mode !== "manual") throw new Error("Manual activity requires Manual mode")
    if (audioChunks.length === 0) throw new Error("Manual recording is empty")
    if (!this.ready || this.stopPromise || this.stopping || !socket || socket.readyState !== WS_OPEN) {
      throw new Error("Gemini socket is not ready")
    }
    let started = false
    let ended = false
    try {
      socket.send(JSON.stringify({realtimeInput: {activityStart: {}}}))
      started = true
      this.turnActive = true
      for (const chunk of audioChunks) {
        if (socket.readyState !== WS_OPEN) throw new Error("socket closed during Manual activity")
        this.sendAudioToSocket(socket, chunk)
        this.turnMicSource = micSource
      }
      if (socket.readyState !== WS_OPEN) throw new Error("socket closed during Manual activity")
      socket.send(JSON.stringify({realtimeInput: {activityEnd: {}}}))
      ended = true
    } catch {
      if (started && !ended && socket.readyState === WS_OPEN) {
        try {
          socket.send(JSON.stringify({realtimeInput: {activityEnd: {}}}))
        } catch {
          /* provider state is already fatal */
        }
      }
      const error = new Error("Gemini manual activity send failed")
      this.reportError(error)
      throw error
    }
  }

  sendImage(image: ImageRequest): Promise<void> {
    if (this.stopPromise) return Promise.reject(new Error("Photo send cancelled"))
    if (this.imageUpload) return Promise.reject(new Error("Wait for the current photo upload to finish"))
    const upload = this.performSendImage(image).finally(() => {
      if (this.imageUpload === upload) this.imageUpload = null
    })
    this.imageUpload = upload
    return upload
  }

  private async performSendImage(image: ImageRequest): Promise<void> {
    if (this.activityPauseReason) throw new Error(this.activityPauseReason)
    if (!this.storage) throw new Error("Local image journal unavailable")
    const socket = this.socket
    if (!this.ready || this.stopping || !socket || socket.readyState !== WS_OPEN) {
      throw new Error("Gemini socket is not ready")
    }
    if (this.pendingImage && this.pendingImage.imageId !== image.imageId) {
      if (this.pendingImage.retryRequested) this.callbacks.onPhotoRetryChange(true)
      throw new Error("Another photo is still pending")
    }
    if (this.pendingImage?.providerSent) return

    const generation = this.generation
    const sessionId = this.sessionId
    const pendingBeforeUpload = this.pendingImage
    const pending: PendingImage = pendingBeforeUpload ?? {
      imageId: image.imageId, mediaRef: "", providerSent: false, captureAfterCurrent: false,
      generation, sessionId,
    }
    pending.speakDescription = image.speakDescription === true
    pending.retryRequested = true
    this.pendingImage = pending
    await this.persistJournal()
    if (this.journalUnavailable) throw new Error("Local image journal unavailable")
    if (this.stopping || this.reflecting || generation !== this.generation || this.pendingImage !== pending) {
      throw new Error("Photo send cancelled")
    }
    const response = await this.request(`/integration/mentra/session/${this.sessionId}/snapshot`, {
      user_id: this.config.userId,
      soul_id: this.config.soulId,
      image_id: image.imageId,
      mime_type: image.mimeType,
      data: image.data,
    }, SNAPSHOT_TIMEOUT_MS)
    if (!response.ok) {
      if (!this.stopping && !this.reflecting && generation === this.generation &&
          this.pendingImage === pending && !pending.mediaRef && !pendingBeforeUpload &&
          response.status >= 400 && response.status < 500) {
        this.pendingImage = null
        await this.persistJournal()
      }
      throw new Error(`OpenAlma snapshot failed (${response.status})`)
    }
    const result = (await response.json()) as {media_ref?: unknown}
    if (
      this.stopping || this.reflecting || generation !== this.generation || sessionId !== this.sessionId
    ) {
      throw new Error("Photo send cancelled")
    }
    if (this.pendingImage !== pending) throw new Error("Photo send cancelled")
    const mediaRef = typeof result.media_ref === "string" ? result.media_ref.trim() : ""
    if (!mediaRef.startsWith("mentra_media/") || mediaRef.includes("..")) {
      throw new Error("OpenAlma snapshot returned an invalid media reference")
    }

    if (pending.mediaRef && pending.mediaRef !== mediaRef) throw new Error("OpenAlma snapshot media reference changed")
    pending.mediaRef = mediaRef
    pending.speakDescription = image.speakDescription === true
    pending.captureAfterCurrent = this.turnActive
    pending.generation = this.generation
    pending.sessionId = this.sessionId
    this.pendingImage = pending
    await this.persistJournal()
    if (this.journalUnavailable) throw new Error("Local image journal unavailable")
    if (this.pendingImage !== pending || generation !== this.generation) throw new Error("Photo send cancelled")
    if (pending.providerSent) return
    if (this.stopPromise) {
      pending.retryRequested = false
      return
    }

    const activeSocket = this.socket
    if (!this.ready || !activeSocket || activeSocket.readyState !== WS_OPEN) {
      await this.requestPhotoRetry(pending)
      throw new Error("Photo send cancelled")
    }
    pending.retryRequested = false
    if (this.turnActive && !this.draining) {
      pending.captureAfterCurrent = true
      await this.persistJournal()
      return
    }
    let sent: boolean
    try {
      pending.captureAfterCurrent = this.turnActive && !this.draining
      sent = this.sendImageTurn(activeSocket, image.mimeType, image.data)
    } catch {
      await this.requestPhotoRetry(pending)
      throw new Error(this.activityPauseReason || "Gemini image send failed")
    }
    if (!sent) throw new Error("Photo send cancelled")
    pending.providerSent = true
    pending.retryRequested = false
    this.callbacks.onPhotoRetryChange(false)
    this.enqueueImageMarker()
    await this.persistJournal()
    this.scheduleAppend()
  }

  async retryImage(): Promise<void> {
    if (this.stopping || this.imageRetrying || !this.ready || this.socket?.readyState !== WS_OPEN) {
      throw new Error("Wait for Gemini to reconnect before retrying the photo")
    }
    if (this.turnActive && !this.pendingImage?.caption) throw new Error("Wait for the current reply to finish before retrying the photo")
    if (this.pendingImage?.caption) {
      await this.scheduleImageFinalize(true)
      return
    }
    if (!this.pendingImage || this.pendingImage.providerSent) {
      throw new Error("No photo is waiting to retry")
    }
    await this.retryPendingImage(true)
  }

  async discardImage(): Promise<void> {
    if (!this.journalLoaded) throw new Error("Wait for local recovery to finish before discarding the photo")
    if (this.pendingImage) {
      this.pendingImage = null
      await this.persistJournal()
    }
    this.callbacks.onPhotoRetryChange(false)
    this.clearPersistenceErrorIfSynced()
  }

  private sendImageTurn(socket: SocketLike, mimeType: "image/jpeg" | "image/png", data: string): boolean {
    if (this.activityPauseReason) throw new Error(this.activityPauseReason)
    if (this.stopping || this.reflecting || (this.turnActive && !this.draining) || !this.ready || this.socket !== socket || socket.readyState !== WS_OPEN) return false
    const pending = this.pendingImage!
    socket.send(JSON.stringify({
      realtimeInput: {video: {data, mimeType}},
    }))
    socket.send(JSON.stringify({realtimeInput: {text: `image_id: ${pending.imageId}\n${PHOTO_CAPTION_INSTRUCTION}`}}))
    return true
  }

  private async retryPendingImage(userRequested = false): Promise<void> {
    const pending = this.pendingImage
    const socket = this.socket
    if (
      this.activityPauseReason || (this.turnActive && !this.draining) || !pending || (!pending.mediaRef && !userRequested) || (pending.retryRequested && !userRequested) || pending.caption || pending.providerSent || this.imageRetrying || this.stopping ||
      !this.ready || !socket || socket.readyState !== WS_OPEN
    ) return
    this.imageRetrying = true
    let retryOnReplacement = false
    try {
      pending.retryRequested = false
      this.callbacks.onPhotoRetryChange(false)
      const response = await this.request(`/integration/mentra/session/${this.sessionId}/snapshot/replay`, {
        user_id: this.config.userId,
        soul_id: this.config.soulId,
        image_id: pending.imageId,
      }, SNAPSHOT_TIMEOUT_MS).catch(() => null)
      if (this.pendingImage !== pending || pending.providerSent || this.stopping) return
      if (!response?.ok) {
        await this.requestPhotoRetry(pending)
        return
      }
      const replay = await response.json().catch(() => null) as {
        mime_type?: unknown; data?: unknown; media_ref?: unknown; filing?: unknown
      } | null
      if (this.pendingImage !== pending || pending.providerSent || this.stopping) return
      const filing = this.filingCaption(replay?.filing)
      if (filing !== null) {
        this.acceptedCaptions.set(pending.imageId, filing)
        this.pendingImage = null
        await this.persistJournal()
        this.callbacks.onPhotoRetryChange(false)
        this.clearPersistenceErrorIfSynced()
        this.finishPhotoDrainIfAcknowledged()
        return
      }
      const mimeType = replay?.mime_type
      const data = replay?.data
      if (!pending.mediaRef && typeof replay?.media_ref === "string" &&
          /^mentra_media\/[^/]+\/[^/]+$/.test(replay.media_ref) && !replay.media_ref.includes("..")) {
        pending.mediaRef = replay.media_ref
      }
      if (
        (mimeType !== "image/jpeg" && mimeType !== "image/png") || typeof data !== "string" ||
        !data || !pending.mediaRef
      ) {
        await this.requestPhotoRetry(pending)
        return
      }
      if (this.activityPauseReason) {
        await this.requestPhotoRetry(pending)
        return
      }
      if (this.socket !== socket || socket.readyState !== WS_OPEN) {
        retryOnReplacement = true
        return
      }
      try {
        pending.captureAfterCurrent = this.turnActive && !this.draining
        if (!this.sendImageTurn(socket, mimeType, data)) return
      } catch {
        this.reportError(new Error("Gemini image replay send failed"))
        return
      }
      pending.providerSent = true
      pending.generation = this.generation
      pending.sessionId = this.sessionId
      this.enqueueImageMarker()
      await this.persistJournal()
      this.scheduleAppend()
      this.callbacks.onPhotoRetryChange(false)
      this.clearPersistenceErrorIfSynced()
    } finally {
      this.imageRetrying = false
      if (retryOnReplacement) void this.retryPendingImage()
    }
  }

  private enqueueImageMarker(): void {
    const pending = this.pendingImage
    if (pending?.providerSent && !pending.captureAfterCurrent && pending.imageSequence === undefined) {
      pending.imageSequence = this.enqueueEvent("image", "user", "Shared a photo.", undefined, pending.mediaRef).sequence
    }
  }

  private releaseImageFence(): void {
    if (this.pendingImage?.captureAfterCurrent) {
      this.pendingImage.captureAfterCurrent = false
      this.enqueueImageMarker()
      void this.persistJournal()
    }
  }

  private sendAudioToSocket(socket: SocketLike, base64Pcm: string): void {
    socket.send(
      JSON.stringify({
        realtimeInput: {audio: {data: base64Pcm, mimeType: "audio/pcm;rate=16000"}},
      }),
    )
    this.audioFramesSent += 1
  }

  stop(graceful = false): Promise<void> {
    this.stopPromise ??= this.performStop(graceful)
    return this.stopPromise
  }

  muteForStop(): void {
    this.outputMuted = true
  }

  private async performStop(graceful: boolean): Promise<void> {
    this.muteForStop()
    trace("provider.stop.begin", {graceful, turnActive: this.turnActive})
    try {
      const stoppedMidTurn = this.turnActive
      const drainAttempted = graceful && Boolean(this.pendingImage && (this.imageUpload || !this.pendingImage.retryRequested))
      if (drainAttempted) await this.drainPhoto()
      if (stoppedMidTurn || this.inputTranscript.trim() || this.outputTranscript.trim()) {
        this.finalizeInterruptedTurn()
        this.interruptionFinalized = false
      }
      if (graceful && !this.pendingImage && !this.activityPauseReason && !stoppedMidTurn && this.ready && this.completeUserTurns >= 2) {
        trace("provider.reflection.begin")
        const reflection = await this.requestReflection()
        trace("provider.reflection.end", {persisted: Boolean(reflection && reflection !== "NO_SUMMARY")})
        if (reflection && reflection !== "NO_SUMMARY") {
          this.enqueueEvent("sitting_summary", "assistant", reflection)
        }
      }
      this.stopping = true
      this.ready = false
      await this.appendTail
      trace("provider.transcript_queue.drained")
      if (!this.persistenceFatal) await this.flushPendingEvents()
      // Explicit Retry may outlive Stop; its generation checks retain uncertain recovery.
      if (!this.imageFinalizationExplicit && !drainAttempted) await this.imageFinalization
      if (this.pendingEvents.length) {
        this.callbacks.onPersistenceError(!this.storage || this.journalUnavailable
          ? "Transcript sync failed; local transcript backup unavailable"
          : "Transcript sync failed; pending turns remain saved on this device")
      }
    } catch (error) {
      this.persistenceFatal = true
      this.callbacks.onPersistenceError(!this.storage || this.journalUnavailable
        ? "Transcript sync failed; local transcript backup unavailable"
        : "Transcript sync failed; pending turns remain saved on this device")
      this.reportError(error instanceof Error ? error : new Error(String(error)))
    } finally {
      if (this.pendingImage?.mediaRef === "") {
        this.callbacks.onPhotoRetryChange(true)
        this.callbacks.onPersistenceError(PHOTO_UPLOAD_UNCONFIRMED_MESSAGE)
      }
      this.generation += 1
      this.stopping = true
      this.ready = false
      this.clearHeartbeat()
      this.clearDurationWarning()
      this.clearGoAway()
      if (graceful) {
        this.resumptionHandle = ""
        this.resumptionUpdatedAt = 0
      }
      await this.persistJournal()
      const socket = this.socket
      this.socket = null
      socket?.close()
      this.pendingToolCalls.clear()
      this.deliveredToolResultIds.clear()
      await this.endLease()
      trace("provider.stop.end")
    }
  }

  private async drainPhoto(): Promise<void> {
    this.draining = true
    this.drainDeadlineAt = Date.now() + this.photoDrainTimeoutMs
    let timeout!: ReturnType<typeof setTimeout>
    const completion = new Promise<void>(resolve => { this.drainResolve = resolve })
    const deadline = new Promise<void>(resolve => { timeout = setTimeout(resolve, this.photoDrainTimeoutMs) })
    const work = async () => {
      await this.imageUpload?.catch(() => {})
      if (!this.draining || this.stopping) return
      if (this.pendingImage && !this.pendingImage.caption) {
        const pending = this.pendingImage
        if (this.mode === "continuous" && this.audioFramesSent > 0) {
          const silence = btoa("\0".repeat(3200))
          for (let frame = 0; frame < 18; frame += 1) {
            if (!this.draining || !this.ready || this.socket?.readyState !== WS_OPEN) return
            this.sendAudioToSocket(this.socket, silence)
            await new Promise(resolve => setTimeout(resolve, 100))
          }
          if (!this.draining || !this.ready || this.socket?.readyState !== WS_OPEN) return
          this.socket.send(JSON.stringify({realtimeInput: {audioStreamEnd: true}}))
        }
        if (!this.draining) return
        if (this.pendingImage === pending) {
          pending.captureAfterCurrent = false
          if (!pending.providerSent) await this.retryPendingImage()
        }
      }
      if (this.pendingImage?.caption) {
        await this.appendTail
        await this.scheduleImageFinalize()
      }
      this.finishPhotoDrainIfAcknowledged()
      await completion
    }
    try {
      await Promise.race([work(), deadline])
    } catch (error) {
      this.reportError(error instanceof Error ? error : new Error(String(error)))
    } finally {
      clearTimeout(timeout)
      this.draining = false
      this.drainResolve?.()
      this.drainResolve = null
      if (this.pendingImage) {
        console.error("[OpenAlma] Photo caption drain ended before durable handoff; retaining pending work")
        await this.requestPhotoRetry(this.pendingImage)
      }
    }
  }

  private finishPhotoDrainIfAcknowledged(): void {
    if (!this.pendingImage && ![...this.pendingToolCalls.values()].some(call => call.name === "save_photo_caption")) {
      this.drainResolve?.()
    }
  }

  private async requestStart(mode: SessionMode): Promise<StartResponse> {
    let response: Response
    for (let attempt = 0; ; attempt += 1) {
      response = await this.request("/integration/mentra/session/start", {
        user_id: this.config.userId,
        soul_id: this.config.soulId,
        device_session_id: this.config.deviceSessionId,
        mode,
      })
      if (response.ok) break
      const errorBody = response.status === 409 ? await response.clone().json().catch(() => null) : null
      if (
        attempt === 0 &&
        errorBody?.detail?.code === "mentra_history_changed"
      ) {
        continue
      }
      if (errorBody?.detail?.code === "soul_paused") throw new Error(errorBody.detail.message)
      throw new Error(`OpenAlma Start failed (${response.status})`)
    }
    const body = (await response.json()) as Partial<StartResponse>
    if (typeof body.session_id === "string" && body.session_id.trim()) {
      this.sessionId = body.session_id
      this.ended = false
    }
    const ws = body.websocket
    if (
      typeof body.session_id !== "string" ||
      !body.session_id.trim() ||
      !Number.isSafeInteger(body.next_transcript_sequence) ||
      Number(body.next_transcript_sequence) < 1 ||
      typeof body.ephemeral_token !== "string" ||
      !body.ephemeral_token ||
      !ws ||
      ws.api_version !== "v1beta" ||
      ws.method !== "BidiGenerateContentConstrained" ||
      ws.input_audio_rate_hz !== 16000 ||
      ws.output_audio_rate_hz !== 24000 ||
      typeof body.lease_seconds !== "number" ||
      !Number.isFinite(body.lease_seconds) ||
      body.lease_seconds <= 0 ||
      typeof body.session_warning_seconds !== "number" ||
      !Number.isFinite(body.session_warning_seconds) ||
      body.session_warning_seconds < 0
    ) {
      throw new Error("OpenAlma Start returned an invalid session contract")
    }
    this.nextTranscriptSequence = Number(body.next_transcript_sequence)
    return body as StartResponse
  }

  private async connectSocket(handle: string, timeoutMs = this.setupTimeoutMs): Promise<SocketLike> {
    const url =
      "wss://generativelanguage.googleapis.com/ws/" +
      "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained" +
      `?access_token=${encodeURIComponent(this.token)}`
    const socket = this.openSocket(url)
    this.socket = socket

    await new Promise<void>((resolve, reject) => {
      let settled = false
      let ready = false
      const timeout = setTimeout(() => finish(new Error("Gemini setup timed out")), timeoutMs)
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (error) reject(error)
        else resolve()
      }

      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({setup: {sessionResumption: handle ? {handle} : {}}}))
      })
      socket.addEventListener("message", (event) => {
        if (this.stopping || this.socket !== socket) return
        try {
          const message = this.parseMessage(event.data)
          if (message.setupComplete !== undefined) {
            ready = true
            this.ready = true
            this.flushToolResponses()
            if (this.pendingEvents.length || this.pendingImage?.caption) this.scheduleAppend()
            void this.retryPendingImage()
            trace("provider.setup_complete", {resumed: Boolean(handle)})
            finish()
          }
          this.handleMessage(message)
        } catch (error) {
          const normalized = error instanceof Error ? error : new Error(String(error))
          if (this.reflecting) this.finishReflection(null)
          if (ready) this.reportError(normalized)
          else finish(normalized)
        }
      })
      socket.addEventListener("error", () => {
        if (this.stopping || this.socket !== socket) return
        const error = new Error(ready ? "Gemini socket failed" : "Gemini socket failed during setup")
        if (ready) {
          this.ready = false
          socket.close()
        }
        else finish(error)
      })
      socket.addEventListener("close", (event) => {
        trace("provider.socket.close_event", {
          code: Number.isSafeInteger(event?.code) ? event.code : null,
          reason: typeof event?.reason === "string" ? event.reason : "",
          wasClean: event?.wasClean === true,
        })
        if (!settled) finish(new Error("Gemini socket closed during setup"))
        if (ready && !this.stopping && this.socket === socket) void this.handleUnexpectedClose()
      })
    })
    return socket
  }

  private parseMessage(data: unknown): Record<string, any> {
    if (data instanceof ArrayBuffer) data = new TextDecoder().decode(new Uint8Array(data))
    if (typeof data !== "string") throw new Error("Gemini returned a non-text message")
    const parsed = JSON.parse(data)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Gemini returned malformed JSON")
    }
    return parsed
  }

  private handleMessage(message: Record<string, any>): void {
    if (message.voiceActivity !== undefined) {
      const type = message.voiceActivity?.type
      if (type !== "ACTIVITY_START" && type !== "ACTIVITY_END") throw new Error("Gemini returned malformed voice activity")
      this.voiceActive = type === "ACTIVITY_START"
      if (this.voiceActive) this.turnActive = true
    }
    const usage = message.usageMetadata
    if (
      usage &&
      typeof usage === "object" &&
      Number.isSafeInteger(usage.totalTokenCount) &&
      usage.totalTokenCount >= 0
    ) {
      this.latestUsageTotal = usage.totalTokenCount
    }
    const update = message.sessionResumptionUpdate
    if (update?.resumable === false) {
      this.resumptionHandle = ""
      this.resumptionUpdatedAt = 0
      void this.persistJournal()
    } else if (update?.resumable === true && typeof update.newHandle === "string" && update.newHandle.trim()) {
      this.resumptionHandle = update.newHandle
      this.resumptionUpdatedAt = Date.now()
      void this.persistJournal()
    }

    if (message.goAway !== undefined) this.handleGoAway(message.goAway)

    const hasToolCall = message.toolCall !== undefined
    this.turnHasToolCall ||= hasToolCall
    if (hasToolCall) trace("provider.tool_call")
    if (message.serverContent !== undefined) {
      this.handleServerContent(message.serverContent, hasToolCall)
    }
    if (hasToolCall) this.handleToolCall(message.toolCall)
    if (message.toolCallCancellation !== undefined) {
      this.handleToolCancellation(message.toolCallCancellation)
    }
    if (this.goAwayPending && !this.turnActive && !this.reflecting) void this.rotateForGoAway()
  }

  private handleGoAway(value: unknown): void {
    const timeLeft = value && typeof value === "object" ? (value as {timeLeft?: unknown}).timeLeft : null
    const match = typeof timeLeft === "string" ? /^(\d+(?:\.\d+)?)s$/.exec(timeLeft) : null
    const seconds = match ? Number(match[1]) : Number.NaN
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("Gemini returned malformed GoAway")
    if (this.goAwayPending || this.reconnecting) return
    this.goAwayPending = true
    this.goAwayDeadlineAt = Date.now() + seconds * 1000
    this.goAwayTimer = setTimeout(
      () => void this.rotateForGoAway(),
      Math.max(
        0,
        this.goAwayDeadlineAt - Date.now() - REQUEST_TIMEOUT_MS - this.setupTimeoutMs - GO_AWAY_MARGIN_MS,
      ),
    )
  }

  private async rotateForGoAway(): Promise<void> {
    if (!this.goAwayPending || this.reconnecting || this.stopping) return
    const deadlineAt = this.goAwayDeadlineAt
    this.clearGoAway()
    if (!this.resumptionHandle) {
      this.reportError(new Error("Gemini requested rollover without a resumable handle"))
      return
    }
    this.reconnecting = true
    this.voiceActive = false
    this.ready = false
    this.callbacks.onReconnecting(true)
    if (this.reflecting) this.finishReflection(null)
    const generation = this.generation
    const sessionId = this.sessionId
    const oldSocket = this.socket
    try {
      if (this.turnActive || this.inputTranscript.trim() || this.outputTranscript.trim()) {
        this.finalizeInterruptedTurn()
        this.interruptionFinalized = false
        this.turnActive = false
        this.callbacks.onInterrupted()
      }
      this.resetImageDelivery()
      const replacement = await this.connectReplacement(generation, sessionId, deadlineAt, () => {
        if (this.socket === oldSocket) this.socket = null
        oldSocket?.close()
      })
      if (replacement.readyState !== WS_OPEN) {
        throw new Error("Gemini replacement socket closed after setup")
      }
      if (!this.stopPromise && !this.stopping) this.callbacks.onReconnecting(false)
    } catch (error) {
      if (!this.stopPromise && generation === this.generation && sessionId === this.sessionId) {
        this.reportError(error instanceof Error ? error : new Error(String(error)))
      }
    } finally {
      this.reconnecting = false
    }
  }

  private handleServerContent(content: any, hasToolCall: boolean): void {
    if (!content || typeof content !== "object") throw new Error("Gemini returned malformed server content")
    const interrupted = content.interrupted === true
    const parts = content.modelTurn?.parts
    if (parts !== undefined && !Array.isArray(parts)) throw new Error("Gemini returned malformed model parts")
    if (content.modelTurn !== undefined || content.inputTranscription !== undefined || content.outputTranscription !== undefined) {
      this.turnActive = true
    }
    const input = this.transcriptText(content.inputTranscription, "input")
    const output = this.transcriptText(content.outputTranscription, "output")
    for (const part of interrupted ? [] : (parts ?? [])) {
      const inline = part?.inlineData
      if (inline === undefined) continue
      if (
        typeof inline?.data !== "string" ||
        inline.data.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(inline.data) ||
        approxBase64ByteLength(inline.data) < 2 ||
        approxBase64ByteLength(inline.data) % 2 !== 0
      ) {
        throw new Error("Gemini returned malformed audio")
      }
      if (!this.outputMuted || this.reflecting) {
        this.callbacks.onAudio(inline.data)
        this.turnAudioDelivered = true
      }
      this.providerAudioChunks += 1
    }

    if (this.reflecting) {
      if (input) throw new Error("Gemini returned input transcription during reflection")
      this.outputTranscript += output
      if (interrupted) {
        trace("provider.reflection.interrupted")
        this.callbacks.onInterrupted()
        this.finishReflection(null)
      } else if (content.generationComplete === true || content.turnComplete === true) {
        this.callbacks.onTurnComplete(true)
        this.finishReflection(this.outputTranscript.trim() || null)
      }
      return
    }

    this.inputTranscript += input
    if (!this.outputMuted) this.outputTranscript += output
    if (interrupted) {
      trace("provider.interrupted", {
        audioChunks: this.providerAudioChunks,
        inputChars: this.inputTranscript.length,
        outputChars: this.outputTranscript.length,
      })
      this.finalizeInterruptedTurn(true)
      this.callbacks.onInterrupted()
    }
    if (content.turnComplete === true) {
      const messageHasToolCall = hasToolCall
      hasToolCall ||= this.turnHasToolCall
      this.hasCompletedProviderTurn = true
      trace("provider.turn_complete", {
        hasToolCall,
        interrupted: this.interruptionFinalized,
        ...(this.interruptionFinalized ? {} : {
          audioChunks: this.providerAudioChunks,
          inputChars: this.inputTranscript.length,
          outputChars: this.outputTranscript.length,
        }),
      })
      this.providerAudioChunks = 0
      const interruptedTurn = this.interruptionFinalized
      if (interruptedTurn) {
        this.interruptionFinalized = false
      } else {
        this.finalizeCompleteTurn(hasToolCall)
      }
      this.turnActive = this.voiceActive
      this.turnHasToolCall = false
      this.reconnectAttempted = false
      if (this.latestUsageTotal !== null) this.callbacks.onUsage(this.latestUsageTotal)
      this.callbacks.onTurnComplete(!messageHasToolCall)
      this.describingPhoto = false
      this.requestSpokenPhotoDescription()
      // Barge-in completes the old response before the interrupting voice turn is finished.
      if (!interruptedTurn) void this.retryPendingImage()
    }
  }

  private transcriptText(value: unknown, label: string): string {
    if (value === undefined) return ""
    if (!value || typeof value !== "object" || typeof (value as {text?: unknown}).text !== "string") {
      throw new Error(`Gemini returned malformed ${label} transcription`)
    }
    return (value as {text: string}).text
  }

  private finalizeCompleteTurn(toolCallBoundary = false): void {
    const input = this.inputTranscript.trim()
    const output = this.turnAudioDelivered ? this.outputTranscript.trim() : ""
    const micSource = this.turnMicSource
    const audible = this.turnAudioDelivered
    this.clearTurn()
    if (!input && !output) {
      if (!audible) return
      this.enqueueEvent("transcript_gap", "user", "Transcript unavailable.")
      this.enqueueEvent("transcript_gap", "assistant", "Transcript unavailable.")
      this.releaseImageFence()
      this.scheduleAppend()
      throw new Error("Gemini completed a turn without transcription")
    }
    const followsToolResult = !input && output && (this.describingPhoto || this.deliveredToolResultIds.size > 0)
    if ((!input || !output) && !(input && (toolCallBoundary || !audible)) && !followsToolResult) {
      if (input) {
        this.enqueueEvent("transcript", "user", input, "complete", undefined, micSource)
        this.completeUserTurns += 1
      } else {
        this.enqueueEvent("transcript_gap", "user", "Transcript unavailable.")
      }
      if (output) this.enqueueEvent("transcript", "assistant", output, "complete")
      else this.enqueueEvent("transcript_gap", "assistant", "Transcript unavailable.")
      this.releaseImageFence()
      this.scheduleAppend()
      throw new Error("Gemini completed a turn without both transcriptions")
    }
    if (input) {
      this.enqueueEvent("transcript", "user", input, "complete", undefined, micSource)
      this.completeUserTurns += 1
    }
    if (output) this.enqueueEvent("transcript", "assistant", output, "complete")
    this.releaseImageFence()
    this.deliveredToolResultIds.clear()
    this.scheduleAppend()
  }

  private handleToolCall(value: unknown): void {
    if (this.stopping || this.reflecting) throw new Error("Gemini requested memory during teardown")
    if (!value || typeof value !== "object") throw new Error("Gemini returned malformed tool call")
    const calls = (value as {functionCalls?: unknown}).functionCalls
    if (!Array.isArray(calls) || !calls.length) {
      throw new Error("Gemini returned malformed tool call")
    }
    const parsed: Array<{id: string; name: string; args: Record<string, unknown>}> = []
    const ids = new Set<string>()
    let invalid = false
    for (const call of calls) {
      const id = typeof call?.id === "string" ? call.id.trim() : ""
      const name = typeof call?.name === "string" ? call.name : ""
      const argumentsValid = call?.args && typeof call.args === "object" && !Array.isArray(call.args)
      const args = argumentsValid ? call.args : {}
      let keys: string[]
      let valid: boolean
      switch (name) {
        case "recall_memory":
          keys = ["query"]
          valid = typeof args.query === "string" && !!args.query.trim()
          break
        case "read_working_state":
          keys = []
          valid = true
          break
        case "save_working_thought":
          keys = ["thought"]
          valid = typeof args.thought === "string" && !!args.thought.trim()
          break
        case "annul_intention":
          keys = ["intention_id", "status", "note"]
          valid = typeof args.intention_id === "string" && !!args.intention_id.trim() &&
            (args.status === "completed" || args.status === "deleted") &&
            (args.note === undefined || typeof args.note === "string")
          break
        case "save_photo_caption":
          keys = ["image_id", "caption"]
          valid = typeof args.image_id === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(args.image_id) &&
            typeof args.caption === "string" && !!args.caption.trim() && Array.from(args.caption).length <= TRANSCRIPT_CONTENT_LIMIT
          break
        default:
          throw new Error("Gemini returned unknown tool call")
      }
      if (
        !id ||
        ids.has(id) ||
        this.pendingToolCalls.has(id) ||
        this.deliveredToolResultIds.has(id)
      ) {
        throw new Error(`Gemini returned malformed ${name} call`)
      }
      invalid ||= !argumentsValid || !valid || Object.keys(args).some((key) => !keys.includes(key))
      ids.add(id)
      parsed.push({id, name, args: Object.fromEntries(Object.entries(args).map(([key, value]) =>
        [key, typeof value === "string" ? value.trim() : value],
      ))})
    }
    for (const {id, name, args} of parsed) {
      const pending: PendingToolCall = {
        name,
        generation: this.generation,
        sessionId: this.sessionId,
      }
      this.pendingToolCalls.set(id, pending)
      if (invalid) this.completeToolCall(id, pending, {
        ok: false, status: "invalid", message: "Invalid tool arguments; no calls in this batch were run.",
      }, false)
      else if (name === "recall_memory") void this.runRecall(id, args.query as string, pending)
      else if (name === "save_photo_caption") void this.runPhotoCaption(id, args, pending).catch(error => {
        if (this.isCurrentToolCall(id, pending)) this.reportError(error instanceof Error ? error : new Error(String(error)))
      })
      else void this.runWorkingTool(id, args, pending)
    }
  }

  private handleToolCancellation(value: unknown): void {
    if (!value || typeof value !== "object") throw new Error("Gemini returned malformed tool cancellation")
    const ids = (value as {ids?: unknown}).ids
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !id.trim())) {
      throw new Error("Gemini returned malformed tool cancellation")
    }
    for (const id of ids) {
      const pending = this.pendingToolCalls.get(id)
      if (pending?.name === "save_working_thought" || pending?.name === "annul_intention") {
        this.callbacks.onPersistenceError(WRITE_UNCERTAINTY_MESSAGE)
      }
      this.pendingToolCalls.delete(id)
    }
  }

  private async runRecall(id: string, query: string, pending: PendingToolCall): Promise<void> {
    const startedAt = Date.now()
    trace("recall.begin", {id, queryLength: query.length})
    let response: Response
    try {
      response = await this.request(
        `/integration/mentra/session/${pending.sessionId}/recall`,
        {user_id: this.config.userId, soul_id: this.config.soulId, query},
        TOOL_TIMEOUT_MS,
      )
    } catch {
      trace("recall.network_failure", {id, elapsedMs: Date.now() - startedAt})
      this.completeToolCall(id, pending, "Memory recall is temporarily unavailable.", true)
      return
    }
    if (!this.isCurrentToolCall(id, pending)) return
    if (response.status === 409) {
      const body = await response.clone().json().catch(() => null)
      if (!this.isCurrentToolCall(id, pending)) return
      if (body?.detail?.code === "soul_paused") {
        this.activityPauseReason = body.detail.message
        this.callbacks.onPersistenceError(this.activityPauseReason)
        this.completeToolCall(id, pending, "Memory recall is paused; recovery is in OpenAlma launcher.", false)
        return
      }
    }
    if (response.status === 422) {
      this.completeToolCall(id, pending, {ok: false, status: "invalid", message: "Invalid recall arguments."}, false)
      return
    }
    if ([400, 401, 403, 404, 409].includes(response.status)) {
      trace("recall.fatal", {id, status: response.status, elapsedMs: Date.now() - startedAt})
      this.failToolCall(id, pending, `OpenAlma memory recall failed (${response.status})`)
      return
    }
    if (!response.ok) {
      trace("recall.temporary_failure", {id, status: response.status, elapsedMs: Date.now() - startedAt})
      this.completeToolCall(id, pending, "Memory recall is temporarily unavailable.", true)
      return
    }
    let body: {context?: unknown; retrieve_ms?: unknown} | null
    try {
      body = await response.json()
    } catch (error) {
      if (error instanceof Error && ["AbortError", "TypeError"].includes(error.name)) {
        this.completeToolCall(id, pending, "Memory recall is temporarily unavailable.", true)
        return
      }
      body = null
    }
    if (
      !body ||
      typeof body.context !== "string" ||
      !body.context.trim() ||
      (body.retrieve_ms !== null && body.retrieve_ms !== undefined &&
        (typeof body.retrieve_ms !== "number" || !Number.isFinite(body.retrieve_ms)))
    ) {
      this.failToolCall(id, pending, "OpenAlma memory recall returned an invalid response")
      return
    }
    this.completeToolCall(id, pending, body.context.trim(), false)
    trace("recall.end", {id, elapsedMs: Date.now() - startedAt, contextLength: body.context.trim().length})
  }

  private async runPhotoCaption(id: string, args: Record<string, unknown>, call: PendingToolCall): Promise<void> {
    const imageId = args.image_id as string
    const caption = args.caption as string
    let accepted = this.acceptedCaptions.get(imageId)
    if (accepted === undefined && this.pendingImage?.imageId !== imageId) {
      const response = await this.request(`/integration/mentra/session/${this.sessionId}/snapshot/replay`, {
        user_id: this.config.userId, soul_id: this.config.soulId, image_id: imageId,
      }, SNAPSHOT_TIMEOUT_MS).catch(() => null)
      if (!this.isCurrentToolCall(id, call)) return
      if (!response || response.status >= 500) {
        this.completeToolCall(id, call, {ok: false, status: "unavailable", message: "Photo filing status is temporarily unavailable."}, true)
        return
      }
      if ([401, 403, 409].includes(response.status)) {
        this.failToolCall(id, call, `OpenAlma photo filing lookup failed (${response.status})`)
        return
      }
      if (response?.ok) {
        const replay = await response.json()
        if (!this.isCurrentToolCall(id, call)) return
        const caption = this.filingCaption(replay.filing)
        if (caption !== null) {
          accepted = caption
          this.acceptedCaptions.set(imageId, caption)
        }
      }
    }
    if (accepted !== undefined) {
      this.completeToolCall(id, call, {ok: accepted === caption, durable: accepted === caption,
        ...(accepted === caption ? {} : {status: "conflict"})}, false)
      return
    }
    const image = this.pendingImage
    if (!image?.mediaRef || image.imageId !== imageId || (!image.providerSent && image.imageSequence === undefined) ||
        (image.caption !== undefined && image.caption !== caption)) {
      this.completeToolCall(id, call, {ok: false, status: "invalid", message: "Photo does not match the pending original."}, false)
      return
    }
    if (image.retryRequested) {
      this.completeToolCall(id, call, {ok: false, status: "failed", message: PHOTO_RETRY_MESSAGE}, false)
      return
    }
    if (!image.caption) {
      image.caption = caption
      image.assistantSequence = this.enqueueEvent("photo_caption", "assistant", caption, undefined, image.mediaRef).sequence
      await this.persistJournal()
    }
    this.scheduleAppend()
    await this.appendTail
    await this.scheduleImageFinalize()
    this.completeToolCall(id, call, {ok: this.acceptedCaptions.get(imageId) === caption,
      durable: this.acceptedCaptions.get(imageId) === caption}, false)
  }

  private filingCaption(value: unknown): string | null {
    if (value === undefined) return null
    const filing = value as {caption?: unknown; caption_event_id?: unknown; status?: unknown} | null
    if (!filing || typeof filing.caption !== "string" || !filing.caption.trim() ||
        typeof filing.caption_event_id !== "string" || !filing.caption_event_id ||
        !["queued", "running", "complete", "failed", "discarded"].includes(String(filing.status))) {
      throw new Error("OpenAlma snapshot returned an invalid filing receipt")
    }
    return filing.caption
  }

  private async runWorkingTool(id: string, args: Record<string, unknown>, pending: PendingToolCall): Promise<void> {
    const endpoint = pending.name === "read_working_state" ? "working-state" :
      pending.name === "save_working_thought" ? "working-thought" : "annul-intention"
    const writing = pending.name !== "read_working_state"
    const unavailable = writing
      ? WRITE_UNCERTAINTY_MESSAGE
      : "Working state is temporarily unavailable."
    let response: Response
    try {
      response = await this.request(
        `/integration/mentra/session/${pending.sessionId}/${endpoint}`,
        {user_id: this.config.userId, soul_id: this.config.soulId, ...args},
        TOOL_TIMEOUT_MS,
      )
    } catch {
      this.completeToolCall(id, pending, {ok: false, status: writing ? "uncertain" : "unavailable", message: unavailable}, true)
      return
    }
    if (!this.isCurrentToolCall(id, pending)) return
    const body = await response.json().catch(() => null)
    if (!this.isCurrentToolCall(id, pending)) return
    if (body?.ok === false && body.status === "busy" && body.message === "busy, not saved") {
      this.completeToolCall(id, pending, body, false)
      return
    }
    if (response.status === 409 && body?.detail?.code === "soul_paused") {
      this.activityPauseReason = body.detail.message
      this.callbacks.onPersistenceError(this.activityPauseReason)
      this.completeToolCall(id, pending, {ok: false, status: "paused", message: "Working state is paused; recovery is in OpenAlma launcher."}, false)
      return
    }
    if (response.status === 422) {
      this.completeToolCall(id, pending, {ok: false, status: "invalid", message: "Invalid working-state arguments; not saved."}, false)
      return
    }
    if ([400, 401, 403, 404, 409].includes(response.status)) {
      this.failToolCall(id, pending, `OpenAlma working-state tool failed (${response.status})`)
      return
    }
    if (!response.ok || !body || typeof body.ok !== "boolean") {
      this.completeToolCall(id, pending, {ok: false, status: writing ? "uncertain" : "unavailable", message: unavailable}, true)
      return
    }
    this.completeToolCall(id, pending, body, false)
  }

  private isCurrentToolCall(id: string, pending: PendingToolCall): boolean {
    return this.pendingToolCalls.get(id) === pending &&
      pending.generation === this.generation && pending.sessionId === this.sessionId &&
      !this.stopping && !this.reflecting
  }

  private completeToolCall(id: string, pending: PendingToolCall, result: string | Record<string, unknown>, failed: boolean): void {
    if (!this.isCurrentToolCall(id, pending)) return
    pending.response = result
    if (failed) this.callbacks.onPersistenceError(pending.name === "recall_memory"
      ? "Memory recall unavailable; voice is continuing"
      : typeof result === "object" ? String(result.message) : result)
    this.flushToolResponses()
  }

  private failToolCall(id: string, pending: PendingToolCall, message: string): void {
    if (!this.isCurrentToolCall(id, pending)) return
    this.pendingToolCalls.delete(id)
    this.reportError(new Error(message))
  }

  private flushToolResponses(): void {
    for (const [id, pending] of this.pendingToolCalls) {
      if (!pending.response) continue
      if (!this.isCurrentToolCall(id, pending)) {
        this.pendingToolCalls.delete(id)
        continue
      }
      if (!this.ready || !this.socket || this.socket.readyState !== WS_OPEN) continue
      this.socket.send(JSON.stringify({
        toolResponse: {
          functionResponses: [{
            id,
            name: pending.name,
            response: typeof pending.response === "string" ? {result: pending.response} : pending.response,
            scheduling: "SILENT",
          }],
        },
      }))
      this.deliveredToolResultIds.add(id)
      this.pendingToolCalls.delete(id)
    }
    this.finishPhotoDrainIfAcknowledged()
    this.requestSpokenPhotoDescription()
  }

  private finalizeInterruptedTurn(userComplete = false): void {
    const input = this.inputTranscript.trim()
    const output = this.turnAudioDelivered ? this.outputTranscript.trim() : ""
    const micSource = this.turnMicSource
    this.clearTurn()
    if (input) this.enqueueEvent("transcript", "user", input, userComplete ? "complete" : "interrupted", undefined, micSource)
    if (output) this.enqueueEvent("transcript", "assistant", output, "interrupted")
    if (input && userComplete) this.completeUserTurns += 1
    this.interruptionFinalized = true
    if (!this.stopPromise && this.pendingImage?.providerSent && !this.pendingImage.caption) {
      this.pendingImage.providerSent = false
      this.pendingImage.retryRequested = false
      void this.persistJournal()
    }
    this.releaseImageFence()
    this.scheduleAppend()
  }

  private clearTurn(): void {
    this.inputTranscript = ""
    this.outputTranscript = ""
    this.turnMicSource = undefined
    this.turnAudioDelivered = false
  }

  private enqueueEvent(
    eventKind: TranscriptEvent["event_kind"],
    role: TranscriptEvent["role"],
    content: string,
    status?: TranscriptEvent["status"],
    mediaRef?: string,
    micSource?: MicSource,
  ): TranscriptEvent {
    const characters = Array.from(content)
    let event!: TranscriptEvent
    for (let offset = 0; offset < characters.length; offset += TRANSCRIPT_CONTENT_LIMIT) {
      const sequence = this.nextTranscriptSequence++
      event = {
        event_id: `${this.sessionId}:${sequence}`,
        sequence,
        event_kind: eventKind,
        role,
        content: characters.slice(offset, offset + TRANSCRIPT_CONTENT_LIMIT).join(""),
        ...(status ? {status} : {}),
        ...(mediaRef ? {media_ref: mediaRef} : {}),
        ...(micSource ? {mic_source: micSource} : {}),
      }
      this.pendingEvents.push(event)
    }
    void this.persistJournal()
    return event
  }

  private scheduleAppend(): void {
    this.appendTail = this.appendTail.then(() => this.flushPendingEvents()).catch((error) => {
      this.persistenceFatal = true
      this.reportError(error instanceof Error ? error : new Error(String(error)))
    })
  }

  private async flushPendingEvents(): Promise<void> {
    if (!this.journalLoaded) return
    while (this.pendingEvents.length && !this.persistenceFatal) {
      const batch = this.pendingEvents.slice(0, 16)
      await this.persistJournal()
      let response: Response
      try {
        response = await this.request(`/integration/mentra/session/${this.sessionId}/transcripts/append`, {
          user_id: this.config.userId,
          soul_id: this.config.soulId,
          events: batch,
        })
      } catch {
        this.callbacks.onPersistenceError("Transcript sync failed; retrying")
        return
      }
      if (response.status >= 500) {
        this.callbacks.onPersistenceError("Transcript sync failed; retrying")
        return
      }
      if (!response.ok) throw new Error(`OpenAlma transcript append failed (${response.status})`)
      let result: {ack_sequence?: unknown}
      try {
        result = await response.json()
      } catch (error) {
        if (!(error instanceof Error) || !["AbortError", "TypeError"].includes(error.name)) throw error
        this.callbacks.onPersistenceError("Transcript sync failed; retrying")
        return
      }
      const ack = result.ack_sequence
      if (!Number.isSafeInteger(ack) || Number(ack) !== batch[batch.length - 1].sequence) {
        throw new Error("OpenAlma transcript append returned an invalid acknowledgement")
      }
      this.pendingEvents = this.pendingEvents.filter((event) => event.sequence > Number(ack))
      await this.persistJournal()
      void this.scheduleImageFinalize()
    }
    void this.scheduleImageFinalize()
    if (!this.pendingImage) this.clearPersistenceErrorIfSynced()
  }

  private clearPersistenceErrorIfSynced(): void {
    if (!this.pendingEvents.length && !this.journalUnavailable) this.callbacks.onPersistenceError(null)
  }

  private async requestPhotoRetry(pending: PendingImage): Promise<void> {
    if (this.pendingImage !== pending) return
    pending.retryRequested = true
    this.callbacks.onPhotoRetryChange(true)
    this.callbacks.onPersistenceError(pending.mediaRef ? PHOTO_RETRY_MESSAGE : PHOTO_UPLOAD_UNCONFIRMED_MESSAGE)
    await this.persistJournal()
  }

  private scheduleImageFinalize(userRequested = false): Promise<void> {
    const pending = this.pendingImage
    if (!pending?.caption || (pending.retryRequested && !userRequested) || !pending.assistantSequence ||
        this.pendingEvents.some(event => event.sequence <= pending.assistantSequence!)) return Promise.resolve()
    if (this.imageFinalization) return this.imageFinalization
    this.imageFinalizationExplicit = userRequested
    const finalization = this.finalizePendingImage(pending).finally(() => {
      if (this.imageFinalization === finalization) {
        this.imageFinalization = null
        this.imageFinalizationExplicit = false
      }
    })
    this.imageFinalization = finalization
    return finalization
  }

  private async finalizePendingImage(pending: PendingImage): Promise<void> {
    const generation = this.generation
    let response: Response
    try {
      response = await this.request(`/integration/mentra/session/${this.sessionId}/snapshot/finalize`, {
        user_id: this.config.userId,
        soul_id: this.config.soulId,
        image_id: pending.imageId,
        caption: pending.caption,
        caption_event_id: `${pending.sessionId}:${pending.assistantSequence}`,
      })
    } catch {
      if (generation !== this.generation || this.pendingImage !== pending) return
      await this.requestPhotoRetry(pending)
      return
    }
    if (generation !== this.generation || this.pendingImage !== pending) return
    if (!response.ok) {
      await this.requestPhotoRetry(pending)
      return
    }
    const result = await response.json().catch(() => null) as {ok?: boolean; durable?: boolean; discarded?: boolean} | null
    if (generation !== this.generation || this.pendingImage !== pending) return
    if (result?.ok !== true) {
      await this.requestPhotoRetry(pending)
      return
    }
    if (result.discarded === true) {
      try { await this.archiveJournal(this.journalSnapshot()) } catch {
        if (generation === this.generation && this.pendingImage === pending) await this.requestPhotoRetry(pending)
        return
      }
      if (generation !== this.generation || this.pendingImage !== pending) return
      await this.requestPhotoRetry(pending)
      return
    }
    if (result.durable !== true) {
      await this.requestPhotoRetry(pending)
      return
    }
    this.acceptedCaptions.set(pending.imageId, pending.caption!)
    if (pending.speakDescription) this.spokenPhotos.push(pending.imageId)
    this.pendingImage = null
    await this.persistJournal()
    this.callbacks.onPhotoRetryChange(false)
    this.clearPersistenceErrorIfSynced()
    if (![...this.pendingToolCalls.values()].some(call => call.name === "save_photo_caption")) this.requestSpokenPhotoDescription()
    this.finishPhotoDrainIfAcknowledged()
  }

  private requestSpokenPhotoDescription(): void {
    if (!this.spokenPhotos.length || this.turnActive || this.stopPromise || this.stopping || this.reflecting ||
        !this.ready || this.socket?.readyState !== WS_OPEN) return
    const imageId = this.spokenPhotos.shift()!
    this.describingPhoto = true
    this.socket.send(JSON.stringify({clientContent: {
      turns: [{role: "user", parts: [{text: `image_id: ${imageId}\nDescribe this image.  What do you want to remember about it?`}]}],
      turnComplete: true,
    }}))
    this.turnActive = true
  }

  private async hydrateJournal(generation: number): Promise<void> {
    if (!this.storage) {
      this.journalLoaded = true
      return
    }
    const selected = await readSessionJournal(this.storage)
    if (this.stopping || generation !== this.generation) throw new Error("Gemini start cancelled")
    this.journalKey = selected.key
    const raw = selected.raw
    this.loadedJournal = raw
    if (selected.unreadable) {
      this.callbacks.onPersistenceError("Local backup unavailable; starting fresh without replacing existing data")
    }
    if (raw === null) {
      this.journalLoaded = true
      return
    }
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      value = null
    }
    const journal = value && typeof value === "object" && !Array.isArray(value) ? value as Partial<SessionJournal> : null
    const scope = journal?.scope
    if (
      !journal ||
      journal.version !== 1 ||
      scope?.userId !== this.config.userId ||
      scope.soulId !== this.config.soulId ||
      scope.deviceSessionId !== this.config.deviceSessionId ||
      !this.validPendingEvents(journal.pendingTranscripts) ||
      !this.validPendingImage(journal.pendingImage)
    ) {
      await this.preserveJournal(raw, generation)
      this.journalLoaded = true
      this.callbacks.onPhotoRetryChange(false)
      this.callbacks.onPersistenceError("Original conversation backup kept on this device")
      return
    }
    this.pendingEvents = journal.pendingTranscripts.map((event) => ({...event}))
    this.pendingImage = journal.pendingImage ? {...journal.pendingImage} : null
    if (this.pendingImage?.retryRequested) {
      this.callbacks.onPhotoRetryChange(true)
      this.callbacks.onPersistenceError(this.pendingImage.mediaRef ? PHOTO_RETRY_MESSAGE : PHOTO_UPLOAD_UNCONFIRMED_MESSAGE)
    }
    const resumption = journal.resumption
    if (
      resumption &&
      typeof resumption.handle === "string" &&
      resumption.handle.trim() &&
      Number.isFinite(resumption.updatedAt) &&
      Date.now() - resumption.updatedAt <= RESUMPTION_MAX_AGE_MS
    ) {
      this.resumptionHandle = resumption.handle
      this.resumptionUpdatedAt = resumption.updatedAt
    }
  }

  private validPendingEvents(value: unknown): value is TranscriptEvent[] {
    return (
      Array.isArray(value) &&
      value.every((event) => {
        if (!event || typeof event !== "object") return false
        const keys = Object.keys(event)
        if (keys.some((key) => !["event_id", "sequence", "event_kind", "role", "content", "status", "media_ref", "mic_source"].includes(key))) {
          return false
        }
        if (event.mic_source !== undefined && (event.event_kind !== "transcript" || event.role !== "user" ||
          !MIC_SOURCES.some(source => source === event.mic_source))) return false
        if (
          typeof event.event_id !== "string" ||
          event.event_id !== event.event_id.trim() ||
          event.event_id.length < 1 ||
          event.event_id.length > 256 ||
          !Number.isSafeInteger(event.sequence) ||
          event.sequence < 1 ||
          typeof event.content !== "string" ||
          event.content.length < 1 ||
          Array.from(event.content).length > TRANSCRIPT_CONTENT_LIMIT
        ) {
          return false
        }
        if (event.event_kind === "transcript") {
          return (
            (event.role === "user" || event.role === "assistant") &&
            (event.status === "complete" || event.status === "interrupted") &&
            event.media_ref === undefined
          )
        }
        if (event.event_kind === "image" || event.event_kind === "photo_caption") {
          const parts = typeof event.media_ref === "string" ? event.media_ref.split("/") : []
          return (event.event_kind === "photo_caption" ? event.role === "assistant" :
            event.role === "user" && event.content === "Shared a photo.") && event.status === undefined &&
            parts.length === 3 && parts[0] === "mentra_media" && !parts.includes("..")
        }
        if (event.event_kind === "transcript_gap") {
          return (event.role === "user" || event.role === "assistant") &&
            event.status === undefined && event.media_ref === undefined && event.content === "Transcript unavailable."
        }
        return event.event_kind === "sitting_summary" && event.role === "assistant" &&
          event.status === undefined && event.media_ref === undefined
      })
    )
  }

  private validPendingImage(value: unknown): value is PendingImage | null | undefined {
    if (value === undefined || value === null) return true
    if (!value || typeof value !== "object") return false
    const image = value as Partial<PendingImage>
    const parts = typeof image.mediaRef === "string" ? image.mediaRef.split("/") : []
    return typeof image.imageId === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(image.imageId) &&
      ((image.mediaRef === "" && image.providerSent === false && image.imageSequence === undefined &&
        image.caption === undefined && image.assistantSequence === undefined) ||
        (parts.length === 3 && parts[0] === "mentra_media" && !parts.includes(".."))) &&
      typeof image.providerSent === "boolean" && typeof image.captureAfterCurrent === "boolean" &&
      Number.isSafeInteger(image.generation) && typeof image.sessionId === "string" &&
      (image.imageSequence === undefined || (Number.isSafeInteger(image.imageSequence) && image.imageSequence > 0)) &&
      (image.caption === undefined || (typeof image.caption === "string" && image.caption.length > 0)) &&
      (image.assistantSequence === undefined || (Number.isSafeInteger(image.assistantSequence) && image.assistantSequence > 0)) &&
      (image.retryRequested === undefined || typeof image.retryRequested === "boolean") &&
      (image.speakDescription === undefined || typeof image.speakDescription === "boolean")
  }

  private async reconcileJournal(): Promise<void> {
    const generation = this.generation
    const pendingEvents = this.pendingEvents.filter((event) => event.sequence >= this.nextTranscriptSequence)
    let keep = pendingEvents.length
    for (let index = 0; index < pendingEvents.length; index += 1) {
      if (pendingEvents[index].sequence !== this.nextTranscriptSequence + index) {
        keep = index
        break
      }
    }
    const photoOutsideHistory = [this.pendingImage?.imageSequence, this.pendingImage?.assistantSequence]
      .some(sequence => sequence !== undefined && sequence >= this.nextTranscriptSequence + keep)
    if (this.loadedJournal !== null && (keep !== this.pendingEvents.length || photoOutsideHistory)) {
      await this.preserveJournal(this.loadedJournal, generation)
    }
    if (keep !== pendingEvents.length || photoOutsideHistory) {
      this.resumptionHandle = ""
      this.resumptionUpdatedAt = 0
      this.pendingImage = null
      this.callbacks.onPhotoRetryChange(false)
    }
    this.pendingEvents = pendingEvents.slice(0, keep)
    this.journalLoaded = true
    if (this.pendingImage?.caption && this.pendingEvents.some(
      (event) => event.event_id === `${this.pendingImage!.sessionId}:${this.pendingImage!.assistantSequence}`,
    )) {
      this.pendingImage.sessionId = this.sessionId
    }
    this.pendingEvents = this.pendingEvents.map((event) => ({
      ...event,
      event_id: `${this.sessionId}:${event.sequence}`,
    }))
    this.nextTranscriptSequence += this.pendingEvents.length
    if (this.pendingImage && !this.pendingImage.caption) {
      this.pendingImage.providerSent = false
      this.pendingImage.captureAfterCurrent = false
      this.pendingImage.generation = this.generation
      this.pendingImage.sessionId = this.sessionId
      this.callbacks.onPhotoRetryChange(this.pendingImage.retryRequested === true)
    }
    await this.persistJournal()
  }

  private persistJournal(): Promise<void> {
    const write = this.journalTail.then(async () => {
      if (!this.storage || !this.journalLoaded) return
      try {
        this.journalKey ??= selectJournalKey(await this.storage.keys(), true)
        const empty = !this.resumptionHandle && !this.pendingEvents.length && !this.pendingImage
        await this.storage.set(this.journalKey, empty ? "" : this.journalSnapshot())
        this.journalUnavailable = false
      } catch {
        this.journalUnavailable = true
        this.callbacks.onPersistenceError("Local transcript backup unavailable")
      }
    })
    this.journalTail = write
    return write
  }

  private journalSnapshot(): string {
    const journal: SessionJournal = {
      version: 1,
      scope: {
        userId: this.config.userId,
        soulId: this.config.soulId,
        deviceSessionId: this.config.deviceSessionId,
      },
      resumption: this.resumptionHandle
        ? {handle: this.resumptionHandle, updatedAt: this.resumptionUpdatedAt}
        : null,
      pendingTranscripts: this.pendingEvents,
      pendingImage: this.pendingImage,
    }
    return JSON.stringify(journal)
  }

  private archiveJournal(raw: string): Promise<void> {
    const write = this.journalTail.then(async () => {
      const previous = await readJournalValue(this.storage!, RECOVERED_CHATS_KEY)
      let recovered: unknown
      try { recovered = JSON.parse(previous ?? "[]") } catch { recovered = null }
      // ponytail: one rare-recovery list; split entries into keys only if its size becomes a problem.
      const valid = Array.isArray(recovered) && recovered.every(value => typeof value === "string")
      const entries: string[] = valid ? recovered as string[] : previous === null ? [] : [previous]
      const exists = entries.includes(raw)
      if (!exists) entries.push(raw)
      if (!valid || !exists) await this.storage!.set(RECOVERED_CHATS_KEY, JSON.stringify(entries))
    })
    this.journalTail = write.catch(() => {})
    return write
  }

  private async preserveJournal(raw: string, generation: number): Promise<void> {
    try { await this.archiveJournal(raw) } catch {
      this.journalKey = selectJournalKey([this.journalKey!], true)
    }
    if (this.stopping || generation !== this.generation) throw new Error("Gemini start cancelled")
    this.loadedJournal = null
  }

  private requestReflection(): Promise<string | null> {
    this.reflecting = true
    this.clearTurn()
    return new Promise((resolve) => {
      const timeout = setTimeout(() => this.finishReflection(null), REFLECTION_TIMEOUT_MS)
      this.reflectionResolve = (value) => {
        clearTimeout(timeout)
        resolve(value)
      }
      try {
        this.socket!.send(
          JSON.stringify({
            clientContent: {
              turns: [{role: "user", parts: [{text: SITTING_REFLECTION_PROMPT}]}],
              turnComplete: true,
            },
          }),
        )
      } catch {
        this.finishReflection(null)
      }
    })
  }

  private finishReflection(value: string | null): void {
    if (!this.reflecting) return
    this.reflecting = false
    this.turnActive = false
    this.clearTurn()
    const resolve = this.reflectionResolve
    this.reflectionResolve = null
    resolve?.(value)
  }

  private async handleUnexpectedClose(): Promise<void> {
    if (this.reconnecting) return
    this.clearGoAway()
    this.reconnecting = true
    this.voiceActive = false
    try {
      trace("provider.socket.closed", {resumable: Boolean(this.resumptionHandle)})
      this.socket = null
      this.ready = false
      if (this.reflecting) {
        this.finishReflection(null)
        return
      }
      const interrupted = this.turnActive || Boolean(this.inputTranscript.trim() || this.outputTranscript.trim())
      try {
        if (interrupted) {
          this.finalizeInterruptedTurn()
        } else {
          this.clearTurn()
        }
      } catch (error) {
        this.reportError(error instanceof Error ? error : new Error(String(error)))
        return
      }
      this.interruptionFinalized = false
      this.turnActive = false
      this.resetImageDelivery()
      if (interrupted) this.callbacks.onInterrupted()
      if ((this.resumptionHandle || !this.hasCompletedProviderTurn) && !this.reconnectAttempted) {
        this.reconnectAttempted = true
        this.callbacks.onReconnecting(true)
        const generation = this.generation
        const sessionId = this.sessionId
        try {
          const replacement = await this.connectReplacement(generation, sessionId)
          if (replacement.readyState !== WS_OPEN) {
            throw new Error("Gemini replacement socket closed after setup")
          }
          this.reconnectAttempted = false
          this.callbacks.onReconnecting(false)
          return
        } catch (error) {
          this.callbacks.onReconnecting(false)
          if (!this.stopPromise && generation === this.generation && sessionId === this.sessionId) {
            this.reportError(error instanceof Error ? error : new Error(String(error)))
          }
          return
        }
      }
      this.reportError(new Error("Gemini connection closed"))
    } finally {
      this.reconnecting = false
    }
  }

  private resetImageDelivery(): void {
    if (this.pendingImage?.providerSent && !this.pendingImage.caption) {
      this.pendingImage.providerSent = false
      this.pendingImage.captureAfterCurrent = false
      void this.persistJournal()
    }
  }

  private async connectReplacement(
    generation: number,
    sessionId: string,
    goAwayDeadlineAt = Number.POSITIVE_INFINITY,
    beforeFirstConnect?: () => void,
  ): Promise<SocketLike> {
    let lastError = new Error("Gemini reconnect failed")
    for (let attempt = 0; attempt < RECONNECT_SETUP_ATTEMPTS; attempt += 1) {
      const deadlineAt = Math.min(
        goAwayDeadlineAt,
        this.lastHeartbeatSuccessAt + this.leaseDurationMs,
        this.draining ? this.drainDeadlineAt : Number.POSITIVE_INFINITY,
      )
      if (!this.reconnectOwned(generation, sessionId) || (attempt > 0 && Date.now() >= deadlineAt)) break
      try {
        await this.refreshToken(generation, sessionId, deadlineAt)
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        if (!(error instanceof TokenRefreshError) || !error.retryable) throw error
        if (attempt + 1 < RECONNECT_SETUP_ATTEMPTS) await this.reconnectDelay(deadlineAt)
        continue
      }
      beforeFirstConnect?.()
      beforeFirstConnect = undefined
      try {
        return await this.connectSocket(
          this.resumptionHandle,
          Math.max(1, Math.min(this.setupTimeoutMs, deadlineAt - Date.now())),
        )
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        this.socket?.close()
        if (attempt + 1 < RECONNECT_SETUP_ATTEMPTS) await this.reconnectDelay(deadlineAt)
      }
    }
    throw lastError
  }

  private reconnectOwned(generation: number, sessionId: string): boolean {
    return (
      (!this.stopPromise || this.draining) &&
      !this.stopping &&
      !this.errorReported &&
      generation === this.generation &&
      sessionId === this.sessionId
    )
  }

  private async refreshToken(generation: number, sessionId: string, deadlineAt: number): Promise<void> {
    if (!this.reconnectOwned(generation, sessionId)) {
      throw new TokenRefreshError("Gemini reconnect cancelled", false)
    }
    let response: Response
    try {
      response = await this.request(`/integration/mentra/session/${sessionId}/token`, {
        user_id: this.config.userId,
        soul_id: this.config.soulId,
      }, Math.max(1, Math.min(REQUEST_TIMEOUT_MS, deadlineAt - Date.now())))
    } catch {
      throw new TokenRefreshError("OpenAlma token refresh failed", true)
    }
    if (!response.ok) {
      throw new TokenRefreshError(
        `OpenAlma token refresh failed (${response.status})`,
        response.status >= 500,
      )
    }
    let body
    try {
      body = await response.json()
    } catch (error) {
      throw new TokenRefreshError("OpenAlma token refresh returned an invalid contract",
        error instanceof Error && ["AbortError", "TypeError"].includes(error.name))
    }
    const token = typeof body?.ephemeral_token === "string" ? body.ephemeral_token.trim() : ""
    if (!token) throw new TokenRefreshError("OpenAlma token refresh returned an invalid contract", false)
    if (!this.reconnectOwned(generation, sessionId)) {
      throw new TokenRefreshError("Gemini reconnect cancelled", false)
    }
    this.token = token
  }

  private reconnectDelay(deadlineAt: number): Promise<void> {
    return new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.max(0, Math.min(1_000, Math.floor(this.setupTimeoutMs / 10), deadlineAt - Date.now())),
      ),
    )
  }

  private async heartbeat(): Promise<void> {
    const generation = this.generation
    const sessionId = this.sessionId
    trace("provider.heartbeat", {audioFramesSent: this.audioFramesSent})
    try {
      const response = await this.request(`/integration/mentra/session/${sessionId}/heartbeat`, {
        user_id: this.config.userId,
        soul_id: this.config.soulId,
      })
      if (!this.reconnectOwned(generation, sessionId)) return
      if (response.status === 404) {
        this.reportError(new Error("OpenAlma heartbeat failed (404)"))
      } else if (!response.ok) {
        trace("provider.heartbeat.missed", {status: response.status})
        this.expireMissedHeartbeat()
      } else {
        const body = await response.json()
        if (!this.reconnectOwned(generation, sessionId)) return
        this.lastHeartbeatSuccessAt = Date.now()
        const previousPause = this.activityPauseReason
        this.activityPauseReason = typeof body?.pause_reason === "string" && body.pause_reason
          ? `${this.config.soulId} is paused. Retry in OpenAlma launcher.` : null
        if (this.activityPauseReason) {
          this.callbacks.onPersistenceError(this.activityPauseReason)
        } else if (typeof body?.background_error === "string" && body.background_error) {
          this.backgroundImageErrorVisible = true
          this.callbacks.onPersistenceError(body.background_error)
        } else if (this.backgroundImageErrorVisible || previousPause) {
          this.backgroundImageErrorVisible = false
          this.clearPersistenceErrorIfSynced()
        }
      }
    } catch (error) {
      if (!this.reconnectOwned(generation, sessionId)) return
      trace("provider.heartbeat.missed", {
        error: error instanceof Error ? error.message : String(error),
      })
      this.expireMissedHeartbeat()
    }
  }

  private expireMissedHeartbeat(): void {
    if (
      this.leaseDurationMs > 0 &&
      this.lastHeartbeatSuccessAt > 0 &&
      Date.now() - this.lastHeartbeatSuccessAt >= this.leaseDurationMs
    ) {
      this.reportError(new Error("OpenAlma heartbeat lease expired"))
    }
  }

  private async endLease(): Promise<void> {
    if (this.ended || !this.sessionId) return
    this.ended = true
    try {
      await this.request(`/integration/mentra/session/${this.sessionId}/end`, {
        user_id: this.config.userId,
        soul_id: this.config.soulId,
      })
    } catch {
      // End is idempotent and best-effort after local teardown.
    }
  }

  private request(path: string, body: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
    return this.fetchFn(`${this.config.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: timeoutSignal(timeoutMs),
    })
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
  }

  private clearDurationWarning(): void {
    if (this.durationWarningTimer) clearTimeout(this.durationWarningTimer)
    this.durationWarningTimer = null
  }

  private clearGoAway(): void {
    if (this.goAwayTimer) clearTimeout(this.goAwayTimer)
    this.goAwayTimer = null
    this.goAwayPending = false
    this.goAwayDeadlineAt = 0
  }

  private reportError(error: Error): void {
    if (this.stopping || this.errorReported) return
    this.errorReported = true
    if ([...this.pendingToolCalls.values()].some(call => (!call.response ||
      (typeof call.response === "object" && call.response.status === "uncertain")) &&
      (call.name === "save_working_thought" || call.name === "annul_intention"))) {
      error = new Error(`${error.message}. ${WRITE_UNCERTAINTY_MESSAGE}`)
    }
    this.pendingToolCalls.clear()
    this.deliveredToolResultIds.clear()
    this.clearHeartbeat()
    this.clearDurationWarning()
    this.clearGoAway()
    this.callbacks.onError(error)
  }
}
