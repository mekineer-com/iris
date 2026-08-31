import {approxBase64ByteLength} from "./audioHelpers"
import type {OpenAlmaConfig} from "./openAlmaConfig"
import type {ImageRequest} from "../shared/channels"
import {PHOTO_RETRY_MESSAGE, type SessionMode} from "../shared/types"

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
  event_kind: "transcript" | "sitting_summary" | "image"
  role: "user" | "assistant"
  content: string
  status?: "complete" | "interrupted"
  media_ref?: string
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
}

type StorageLike = {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

type SessionJournal = {
  version: 1
  scope: {userId: string; soulId: string; deviceSessionId: string}
  resumption: {handle: string; updatedAt: number} | null
  pendingTranscripts: TranscriptEvent[]
  pendingImage?: PendingImage | null
}

type PendingToolCall = {
  generation: number
  sessionId: string
  response?: string
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
  storage?: StorageLike
}

const WS_OPEN = 1
const REQUEST_TIMEOUT_MS = 10_000
const RECALL_TIMEOUT_MS = 30_000
const REFLECTION_TIMEOUT_MS = 8_000
const RECONNECT_SETUP_ATTEMPTS = 6
const GO_AWAY_MARGIN_MS = 2_000
const JOURNAL_KEY = "openalma:gemini-session-v1"
const RESUMPTION_MAX_AGE_MS = 30 * 60 * 1000
export const SITTING_REFLECTION_PROMPT =
  "Reflect briefly in first person on the emotional tone, subtext, or meaningful shift in this sitting that the literal transcript may not preserve. Do not recap the conversation. Respond with one or two natural sentences, or exactly NO_SUMMARY if nothing worthwhile would be added."

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
  private reconnecting = false
  private errorReported = false
  private inputTranscript = ""
  private outputTranscript = ""
  private interruptionFinalized = false
  private turnActive = false
  private completeUserTurns = 0
  private pendingEvents: TranscriptEvent[] = []
  private pendingImage: PendingImage | null = null
  private imageRetrying = false
  private appendTail: Promise<void> = Promise.resolve()
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
    this.storage = options.storage
  }

  async start(mode: SessionMode = "continuous"): Promise<void> {
    trace("provider.start.begin")
    const generation = ++this.generation
    this.stopping = false
    this.ready = false
    this.ended = true
    this.resumptionHandle = ""
    this.resumptionUpdatedAt = 0
    this.reconnectAttempted = false
    this.reconnecting = false
    this.errorReported = false
    this.inputTranscript = ""
    this.outputTranscript = ""
    this.interruptionFinalized = false
    this.turnActive = false
    this.completeUserTurns = 0
    this.pendingEvents = []
    this.pendingImage = null
    this.imageRetrying = false
    this.appendTail = Promise.resolve()
    this.persistenceFatal = false
    this.journalUnavailable = false
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
      await this.hydrateJournal()
      const response = await this.requestStart(mode)
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

  sendAudio(base64Pcm: string): void {
    if (!this.ready && !this.stopping) {
      // ponytail: drop audio during the single reconnect; add a bounded queue only if field tests show speech loss.
      return
    }
    if (!this.socket || this.socket.readyState !== WS_OPEN) throw new Error("Gemini socket is not ready")
    this.sendAudioToSocket(this.socket, base64Pcm)
  }

  sendActivity(audioChunks: readonly string[]): void {
    const socket = this.socket
    if (this.mode !== "manual") throw new Error("Manual activity requires Manual mode")
    if (audioChunks.length === 0) throw new Error("Manual recording is empty")
    if (!this.ready || this.stopping || !socket || socket.readyState !== WS_OPEN) {
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

  async sendImage(image: ImageRequest): Promise<void> {
    if (!this.storage) throw new Error("Local image journal unavailable")
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(image.imageId)) throw new Error("Invalid image id")
    if (image.mimeType !== "image/jpeg" && image.mimeType !== "image/png") {
      throw new Error("Only JPEG and PNG images are supported")
    }
    if (
      !image.data || image.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data) ||
      approxBase64ByteLength(image.data) > 1024 * 1024
    ) {
      throw new Error("Photo must be between 1 byte and 1 MB")
    }
    const socket = this.socket
    if (!this.ready || this.stopping || !socket || socket.readyState !== WS_OPEN) {
      throw new Error("Gemini socket is not ready")
    }
    if (this.pendingImage?.providerSent && this.pendingImage.imageId !== image.imageId) {
      throw new Error("Another photo is still pending")
    }
    if (this.pendingImage && this.pendingImage.imageId !== image.imageId) {
      this.pendingImage = null
      await this.persistJournal()
      if (this.journalUnavailable) throw new Error("Local image journal unavailable")
    }
    if (this.pendingImage?.providerSent) return

    const generation = this.generation
    const sessionId = this.sessionId
    const response = await this.request(`/integration/mentra/session/${this.sessionId}/snapshot`, {
      user_id: this.config.userId,
      soul_id: this.config.soulId,
      image_id: image.imageId,
      mime_type: image.mimeType,
      data: image.data,
    })
    if (!response.ok) throw new Error(`OpenAlma snapshot failed (${response.status})`)
    if (
      this.stopping || generation !== this.generation || sessionId !== this.sessionId ||
      this.socket !== socket || socket.readyState !== WS_OPEN
    ) {
      throw new Error("Photo send cancelled")
    }
    const result = (await response.json()) as {media_ref?: unknown}
    const mediaRef = typeof result.media_ref === "string" ? result.media_ref.trim() : ""
    if (!mediaRef.startsWith("mentra_media/") || mediaRef.includes("..")) {
      throw new Error("OpenAlma snapshot returned an invalid media reference")
    }

    const pending: PendingImage = this.pendingImage ?? {
      imageId: image.imageId,
      mediaRef,
      providerSent: false,
      captureAfterCurrent: false,
      generation: this.generation,
      sessionId: this.sessionId,
    }
    if (pending.mediaRef !== mediaRef) throw new Error("OpenAlma snapshot media reference changed")
    pending.captureAfterCurrent = this.turnActive || Boolean(
      this.inputTranscript || this.outputTranscript || this.pendingToolCalls.size || this.deliveredToolResultIds.size,
    )
    pending.generation = this.generation
    pending.sessionId = this.sessionId
    this.pendingImage = pending
    await this.persistJournal()
    if (this.journalUnavailable) throw new Error("Local image journal unavailable")

    try {
      this.sendImageTurn(socket, image.mimeType, image.data)
    } catch {
      throw new Error("Gemini image send failed")
    }
    pending.providerSent = true
    if (pending.imageSequence === undefined) {
      const event = this.enqueueEvent("image", "user", "Shared a photo.", undefined, mediaRef)
      pending.imageSequence = event.sequence
    }
    this.turnActive = true
    await this.persistJournal()
    this.scheduleAppend()
  }

  async retryImage(): Promise<void> {
    if (!this.pendingImage || this.pendingImage.caption || this.pendingImage.providerSent) {
      throw new Error("No photo is waiting to retry")
    }
    await this.retryPendingImage()
  }

  async discardImage(): Promise<void> {
    if (!this.pendingImage) return
    this.pendingImage = null
    await this.persistJournal()
    this.callbacks.onPhotoRetryChange(false)
    this.callbacks.onPersistenceError(null)
  }

  private sendImageTurn(socket: SocketLike, mimeType: "image/jpeg" | "image/png", data: string): void {
    socket.send(JSON.stringify({
      clientContent: {
        turns: [{
          role: "user",
          parts: [{inlineData: {data, mimeType}}, {text: "Describe this image."}],
        }],
        turnComplete: true,
      },
    }))
  }

  private async retryPendingImage(): Promise<void> {
    const pending = this.pendingImage
    const socket = this.socket
    if (
      !pending || pending.caption || pending.providerSent || this.imageRetrying || this.stopping ||
      !this.ready || !socket || socket.readyState !== WS_OPEN
    ) return
    this.imageRetrying = true
    let retryOnReplacement = false
    try {
      const response = await this.request(`/integration/mentra/session/${this.sessionId}/snapshot/replay`, {
        user_id: this.config.userId,
        soul_id: this.config.soulId,
        image_id: pending.imageId,
      }).catch(() => null)
      if (!response || response.status >= 500) {
        this.callbacks.onPhotoRetryChange(true)
        this.callbacks.onPersistenceError(PHOTO_RETRY_MESSAGE)
        return
      }
      if (!response.ok) {
        await this.discardImage()
        this.reportError(new Error(`OpenAlma snapshot replay failed (${response.status})`))
        return
      }
      const replay = await response.json().catch(() => null) as {mime_type?: unknown; data?: unknown} | null
      const mimeType = replay?.mime_type
      const data = replay?.data
      if (
        (mimeType !== "image/jpeg" && mimeType !== "image/png") || typeof data !== "string" ||
        !data
      ) {
        await this.discardImage()
        this.reportError(new Error("OpenAlma snapshot replay returned invalid image data"))
        return
      }
      if (this.pendingImage !== pending || this.stopping) return
      if (this.socket !== socket || socket.readyState !== WS_OPEN) {
        retryOnReplacement = true
        return
      }
      try {
        this.sendImageTurn(socket, mimeType, data)
      } catch {
        this.reportError(new Error("Gemini image replay send failed"))
        return
      }
      pending.providerSent = true
      pending.captureAfterCurrent = this.turnActive || Boolean(
        this.inputTranscript || this.outputTranscript || this.pendingToolCalls.size || this.deliveredToolResultIds.size,
      )
      pending.generation = this.generation
      pending.sessionId = this.sessionId
      if (pending.imageSequence === undefined) {
        pending.imageSequence = this.enqueueEvent("image", "user", "Shared a photo.", undefined, pending.mediaRef).sequence
      }
      this.turnActive = true
      await this.persistJournal()
      this.scheduleAppend()
      this.callbacks.onPhotoRetryChange(false)
      this.callbacks.onPersistenceError(null)
    } finally {
      this.imageRetrying = false
      if (retryOnReplacement) void this.retryPendingImage()
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

  private async performStop(graceful: boolean): Promise<void> {
    trace("provider.stop.begin", {graceful, turnActive: this.turnActive})
    try {
      const stoppedMidTurn = this.turnActive
      if (stoppedMidTurn || this.inputTranscript.trim() || this.outputTranscript.trim()) {
        this.finalizeInterruptedTurn()
        if (this.pendingImage && !this.pendingImage.providerSent && !this.pendingImage.caption) {
          this.callbacks.onPersistenceError("Photo description was interrupted; the photo remains pending")
        }
        this.interruptionFinalized = false
      }
      if (graceful && !stoppedMidTurn && this.ready && this.completeUserTurns >= 2) {
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
      if (this.pendingEvents.length) {
        this.callbacks.onPersistenceError("Transcript sync failed; pending turns remain saved on this device")
      }
    } catch (error) {
      this.persistenceFatal = true
      this.callbacks.onPersistenceError("Transcript sync failed; pending turns remain saved on this device")
      this.reportError(error instanceof Error ? error : new Error(String(error)))
    } finally {
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
      ws.api_version !== "v1alpha" ||
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
      "google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained" +
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
        if (ready) socket.close()
        else finish(error)
      })
      socket.addEventListener("close", () => {
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
      this.queueJournalWrite()
    } else if (update?.resumable === true && typeof update.newHandle === "string" && update.newHandle.trim()) {
      this.resumptionHandle = update.newHandle
      this.resumptionUpdatedAt = Date.now()
      this.queueJournalWrite()
    }

    if (message.goAway !== undefined) this.handleGoAway(message.goAway)

    const hasToolCall = message.toolCall !== undefined
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
    this.goAwayPending = false
    this.clearGoAway()
    if (!this.resumptionHandle) {
      this.reportError(new Error("Gemini requested rollover without a resumable handle"))
      return
    }
    this.reconnecting = true
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
      this.callbacks.onAudio(inline.data)
      this.providerAudioChunks += 1
    }

    const input = this.transcriptText(content.inputTranscription, "input")
    const output = this.transcriptText(content.outputTranscription, "output")
    if (input) trace("provider.input_transcription", {text: input})
    if (output) trace("provider.output_transcription", {text: output})
    if (this.reflecting) {
      if (input) throw new Error("Gemini returned input transcription during reflection")
      this.outputTranscript += output
      if (interrupted) {
        trace("provider.reflection.interrupted")
        this.callbacks.onInterrupted()
        this.finishReflection(null)
      } else if (content.turnComplete === true) {
        this.callbacks.onTurnComplete(true)
        this.finishReflection(this.outputTranscript.trim() || null)
      }
      return
    }

    this.inputTranscript += input
    this.outputTranscript += output
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
      if (this.interruptionFinalized) {
        this.interruptionFinalized = false
      } else {
        this.finalizeCompleteTurn(hasToolCall)
      }
      this.turnActive = false
      this.reconnectAttempted = false
      if (this.latestUsageTotal !== null) this.callbacks.onUsage(this.latestUsageTotal)
      this.callbacks.onTurnComplete(!hasToolCall)
      // Barge-in marks the photo unsent; this boundary is the first safe same-socket retry point.
      void this.retryPendingImage()
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
    const output = this.outputTranscript.trim()
    const pendingImage = this.pendingImage
    const capturesImage = Boolean(
      pendingImage?.providerSent && !pendingImage.caption && !pendingImage.captureAfterCurrent &&
      pendingImage.generation === this.generation && pendingImage.sessionId === this.sessionId,
    )
    this.clearTurn()
    if (capturesImage) {
      if (toolCallBoundary) {
        if (input) {
          this.enqueueEvent("transcript", "user", input, "complete")
          this.completeUserTurns += 1
        }
        if (output) this.enqueueEvent("transcript", "assistant", output, "complete")
        if (input || output) this.scheduleAppend()
        return
      }
      if (!output) throw new Error("Gemini image turn completed without a usable caption")
      if (input) {
        this.enqueueEvent("transcript", "user", input, "complete")
        this.completeUserTurns += 1
      }
      const event = this.enqueueEvent("transcript", "assistant", output, "complete")
      pendingImage!.caption = output
      pendingImage!.assistantSequence = event.sequence
      this.deliveredToolResultIds.clear()
      this.scheduleAppend()
      return
    }
    if (!input && !output) throw new Error("Gemini completed a turn without transcription")
    const followsToolResult = !input && output && this.deliveredToolResultIds.size > 0
    if ((!input || !output) && !(input && toolCallBoundary) && !followsToolResult) {
      throw new Error("Gemini completed a turn without both transcriptions")
    }
    if (input) {
      this.enqueueEvent("transcript", "user", input, "complete")
      this.completeUserTurns += 1
    }
    if (output) this.enqueueEvent("transcript", "assistant", output, "complete")
    if (pendingImage?.providerSent && pendingImage.captureAfterCurrent) {
      pendingImage.captureAfterCurrent = false
      this.queueJournalWrite()
    }
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
    const parsed: Array<{id: string; query: string}> = []
    const ids = new Set<string>()
    for (const call of calls) {
      const id = typeof call?.id === "string" ? call.id.trim() : ""
      const name = typeof call?.name === "string" ? call.name : ""
      const args = call?.args
      const query = args && typeof args === "object" && !Array.isArray(args)
        ? (args as {query?: unknown}).query
        : undefined
      if (
        !id ||
        name !== "recall_memory" ||
        typeof query !== "string" ||
        !query.trim() ||
        Object.keys(args as object).some((key) => key !== "query") ||
        ids.has(id) ||
        this.pendingToolCalls.has(id)
      ) {
        throw new Error("Gemini returned malformed recall_memory call")
      }
      ids.add(id)
      parsed.push({id, query: query.trim()})
    }
    for (const {id, query} of parsed) {
      const pending: PendingToolCall = {
        generation: this.generation,
        sessionId: this.sessionId,
      }
      this.pendingToolCalls.set(id, pending)
      void this.runRecall(id, query, pending)
    }
  }

  private handleToolCancellation(value: unknown): void {
    if (!value || typeof value !== "object") throw new Error("Gemini returned malformed tool cancellation")
    const ids = (value as {ids?: unknown}).ids
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !id.trim())) {
      throw new Error("Gemini returned malformed tool cancellation")
    }
    for (const id of ids) this.pendingToolCalls.delete(id)
  }

  private async runRecall(id: string, query: string, pending: PendingToolCall): Promise<void> {
    const startedAt = Date.now()
    trace("recall.begin", {id, query})
    let response: Response
    try {
      response = await this.request(
        `/integration/mentra/session/${this.sessionId}/recall`,
        {user_id: this.config.userId, soul_id: this.config.soulId, query},
        RECALL_TIMEOUT_MS,
      )
    } catch {
      trace("recall.network_failure", {id, elapsedMs: Date.now() - startedAt})
      this.completeRecall(id, pending, "Memory recall is temporarily unavailable.", true)
      return
    }
    if ([400, 401, 403, 404, 409, 422, 503].includes(response.status)) {
      trace("recall.fatal", {id, status: response.status, elapsedMs: Date.now() - startedAt})
      this.failRecall(id, pending, `OpenAlma memory recall failed (${response.status})`)
      return
    }
    if (!response.ok) {
      trace("recall.temporary_failure", {id, status: response.status, elapsedMs: Date.now() - startedAt})
      this.completeRecall(id, pending, "Memory recall is temporarily unavailable.", true)
      return
    }
    const body = await response.json().catch(() => null) as {context?: unknown; retrieve_ms?: unknown} | null
    if (
      !body ||
      typeof body.context !== "string" ||
      !body.context.trim() ||
      (body.retrieve_ms !== null && body.retrieve_ms !== undefined &&
        (typeof body.retrieve_ms !== "number" || !Number.isFinite(body.retrieve_ms)))
    ) {
      this.failRecall(id, pending, "OpenAlma memory recall returned an invalid response")
      return
    }
    this.completeRecall(id, pending, body.context.trim(), false)
    trace("recall.end", {id, elapsedMs: Date.now() - startedAt, context: body.context.trim()})
  }

  private completeRecall(id: string, pending: PendingToolCall, result: string, failed: boolean): void {
    if (this.pendingToolCalls.get(id) !== pending) return
    pending.response = result
    if (failed) this.callbacks.onPersistenceError("Memory recall unavailable; voice is continuing")
    this.flushToolResponses()
  }

  private failRecall(id: string, pending: PendingToolCall, message: string): void {
    if (this.pendingToolCalls.get(id) !== pending) return
    this.pendingToolCalls.delete(id)
    this.reportError(new Error(message))
  }

  private flushToolResponses(): void {
    for (const [id, pending] of this.pendingToolCalls) {
      if (!pending.response) continue
      if (
        pending.generation !== this.generation ||
        pending.sessionId !== this.sessionId ||
        this.stopping ||
        this.reflecting
      ) {
        this.pendingToolCalls.delete(id)
        continue
      }
      if (!this.ready || !this.socket || this.socket.readyState !== WS_OPEN) continue
      this.socket.send(JSON.stringify({
        toolResponse: {
          functionResponses: [{
            id,
            name: "recall_memory",
            response: {result: pending.response},
            scheduling: "SILENT",
          }],
        },
      }))
      this.deliveredToolResultIds.add(id)
      this.pendingToolCalls.delete(id)
    }
  }

  private finalizeInterruptedTurn(userComplete = false): void {
    const input = this.inputTranscript.trim()
    const output = this.outputTranscript.trim()
    this.clearTurn()
    if (input) this.enqueueEvent("transcript", "user", input, userComplete ? "complete" : "interrupted")
    if (output) this.enqueueEvent("transcript", "assistant", output, "interrupted")
    if (input && userComplete) this.completeUserTurns += 1
    this.interruptionFinalized = true
    if (input || output) this.scheduleAppend()
    if (this.pendingImage?.providerSent && !this.pendingImage.caption && !this.pendingImage.captureAfterCurrent) {
      this.pendingImage.providerSent = false
      this.queueJournalWrite()
      this.callbacks.onPersistenceError("Photo description was interrupted; retrying")
    }
    if (this.pendingImage?.providerSent && this.pendingImage.captureAfterCurrent) {
      this.pendingImage.captureAfterCurrent = false
      this.queueJournalWrite()
    }
  }

  private clearTurn(): void {
    this.inputTranscript = ""
    this.outputTranscript = ""
  }

  private enqueueEvent(
    eventKind: TranscriptEvent["event_kind"],
    role: TranscriptEvent["role"],
    content: string,
    status?: TranscriptEvent["status"],
    mediaRef?: string,
  ): TranscriptEvent {
    const sequence = this.nextTranscriptSequence++
    const event: TranscriptEvent = {
      event_id: `${this.sessionId}:${sequence}`,
      sequence,
      event_kind: eventKind,
      role,
      content,
      ...(status ? {status} : {}),
      ...(mediaRef ? {media_ref: mediaRef} : {}),
    }
    this.pendingEvents.push(event)
    return event
  }

  private scheduleAppend(): void {
    this.appendTail = this.appendTail.then(() => this.flushPendingEvents()).catch((error) => {
      this.persistenceFatal = true
      this.reportError(error instanceof Error ? error : new Error(String(error)))
    })
  }

  private async flushPendingEvents(): Promise<void> {
    while (this.pendingEvents.length && !this.persistenceFatal) {
      await this.persistJournal()
      const batch = this.pendingEvents.slice(0, 16)
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
      const result = (await response.json()) as {ack_sequence?: unknown}
      const ack = result.ack_sequence
      if (!Number.isSafeInteger(ack) || Number(ack) !== batch[batch.length - 1].sequence) {
        throw new Error("OpenAlma transcript append returned an invalid acknowledgement")
      }
      this.pendingEvents = this.pendingEvents.filter((event) => event.sequence > Number(ack))
      await this.persistJournal()
      await this.finalizePendingImage()
    }
    await this.finalizePendingImage()
    if (!this.pendingEvents.length && !this.pendingImage && !this.journalUnavailable) {
      this.callbacks.onPersistenceError(null)
    }
  }

  private async finalizePendingImage(): Promise<void> {
    const pending = this.pendingImage
    if (!pending?.caption || !pending.assistantSequence) return
    if (this.pendingEvents.some((event) => event.sequence <= pending.assistantSequence!)) return
    let response: Response
    try {
      response = await this.request(`/integration/mentra/session/${this.sessionId}/snapshot/finalize`, {
        user_id: this.config.userId,
        soul_id: this.config.soulId,
        image_id: pending.imageId,
        caption: pending.caption,
      })
    } catch {
      this.callbacks.onPersistenceError("Photo finalization failed; retrying")
      return
    }
    if (response.status >= 500) {
      this.callbacks.onPersistenceError("Photo finalization failed; retrying")
      return
    }
    if (!response.ok) throw new Error(`OpenAlma snapshot finalization failed (${response.status})`)
    this.pendingImage = null
    await this.persistJournal()
  }

  private queueJournalWrite(): void {
    this.appendTail = this.appendTail.then(() => this.persistJournal())
  }

  private async hydrateJournal(): Promise<void> {
    if (!this.storage) return
    let raw: string | null
    try {
      raw = await this.storage.get(JOURNAL_KEY)
    } catch {
      this.journalUnavailable = true
      this.callbacks.onPersistenceError("Local transcript backup unavailable")
      return
    }
    if (!raw) return
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      await this.deleteJournal()
      return
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      await this.deleteJournal()
      return
    }
    const journal = value as Partial<SessionJournal>
    const scope = journal.scope
    if (
      journal.version !== 1 ||
      scope?.userId !== this.config.userId ||
      scope.soulId !== this.config.soulId ||
      scope.deviceSessionId !== this.config.deviceSessionId ||
      !this.validPendingEvents(journal.pendingTranscripts) ||
      !this.validPendingImage(journal.pendingImage)
    ) {
      await this.deleteJournal()
      return
    }
    this.pendingEvents = journal.pendingTranscripts.map((event) => ({...event}))
    this.pendingImage = journal.pendingImage ? {...journal.pendingImage} : null
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
      value.length <= 512 &&
      value.every((event) => {
        if (!event || typeof event !== "object") return false
        const keys = Object.keys(event)
        if (keys.some((key) => !["event_id", "sequence", "event_kind", "role", "content", "status", "media_ref"].includes(key))) {
          return false
        }
        if (
          typeof event.event_id !== "string" ||
          event.event_id !== event.event_id.trim() ||
          event.event_id.length < 1 ||
          event.event_id.length > 256 ||
          !Number.isSafeInteger(event.sequence) ||
          event.sequence < 1 ||
          typeof event.content !== "string" ||
          event.content !== event.content.trim() ||
          event.content.length < 1 ||
          event.content.length > 16_000
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
        if (event.event_kind === "image") {
          const parts = typeof event.media_ref === "string" ? event.media_ref.split("/") : []
          return event.role === "user" && event.status === undefined && event.content === "Shared a photo." &&
            parts.length === 3 && parts[0] === "mentra_media" && !parts.includes("..")
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
      parts.length === 3 && parts[0] === "mentra_media" && !parts.includes("..") &&
      typeof image.providerSent === "boolean" && typeof image.captureAfterCurrent === "boolean" &&
      Number.isSafeInteger(image.generation) && typeof image.sessionId === "string" &&
      (image.imageSequence === undefined || Number.isSafeInteger(image.imageSequence)) &&
      (image.caption === undefined || (typeof image.caption === "string" && image.caption.length > 0)) &&
      (image.assistantSequence === undefined || Number.isSafeInteger(image.assistantSequence))
  }

  private async reconcileJournal(): Promise<void> {
    this.pendingEvents = this.pendingEvents.filter((event) => event.sequence >= this.nextTranscriptSequence)
    for (let index = 0; index < this.pendingEvents.length; index += 1) {
      if (this.pendingEvents[index].sequence !== this.nextTranscriptSequence + index) {
        this.pendingEvents = []
        await this.persistJournal()
        throw new Error("Local transcript backup has a sequence gap")
      }
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
    }
    await this.persistJournal()
  }

  private async persistJournal(): Promise<void> {
    if (!this.storage) return
    try {
      if (!this.resumptionHandle && !this.pendingEvents.length && !this.pendingImage) {
        await this.storage.delete(JOURNAL_KEY)
        this.journalUnavailable = false
        return
      }
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
      await this.storage.set(JOURNAL_KEY, JSON.stringify(journal))
      this.journalUnavailable = false
    } catch {
      this.journalUnavailable = true
      this.callbacks.onPersistenceError("Local transcript backup unavailable")
    }
  }

  private async deleteJournal(): Promise<void> {
    try {
      await this.storage?.delete(JOURNAL_KEY)
      this.journalUnavailable = false
    } catch {
      this.journalUnavailable = true
      this.callbacks.onPersistenceError("Local transcript backup unavailable")
    }
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
    trace("provider.socket.closed", {resumable: Boolean(this.resumptionHandle)})
    this.socket = null
    this.ready = false
    if (this.reflecting) {
      this.finishReflection(null)
      this.reconnecting = false
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
      this.reconnecting = false
      this.reportError(error instanceof Error ? error : new Error(String(error)))
      return
    }
    this.interruptionFinalized = false
    this.turnActive = false
    if (interrupted) this.callbacks.onInterrupted()
    if (this.resumptionHandle && !this.reconnectAttempted) {
      this.reconnectAttempted = true
      this.callbacks.onReconnecting(true)
      const generation = this.generation
      const sessionId = this.sessionId
      try {
        const replacement = await this.connectReplacement(generation, sessionId)
        if (replacement.readyState !== WS_OPEN) {
          throw new Error("Gemini replacement socket closed after setup")
        }
        this.callbacks.onReconnecting(false)
        this.reconnecting = false
        return
      } catch (error) {
        this.callbacks.onReconnecting(false)
        this.reconnecting = false
        if (!this.stopPromise && generation === this.generation && sessionId === this.sessionId) {
          this.reportError(error instanceof Error ? error : new Error(String(error)))
        }
        return
      }
    }
    this.reconnecting = false
    this.reportError(new Error("Gemini connection closed"))
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
      !this.stopPromise &&
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
    const body = await response.json().catch(() => null)
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
    trace("provider.heartbeat", {audioFramesSent: this.audioFramesSent})
    try {
      const response = await this.request(`/integration/mentra/session/${this.sessionId}/heartbeat`, {
        user_id: this.config.userId,
        soul_id: this.config.soulId,
      })
      if (response.status === 404) {
        this.reportError(new Error("OpenAlma heartbeat failed (404)"))
      } else if (!response.ok) {
        trace("provider.heartbeat.missed", {status: response.status})
        this.expireMissedHeartbeat()
      } else {
        this.lastHeartbeatSuccessAt = Date.now()
      }
    } catch (error) {
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
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    return this.fetchFn(`${this.config.baseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.bearer}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout))
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
    this.pendingToolCalls.clear()
    this.deliveredToolResultIds.clear()
    this.clearHeartbeat()
    this.clearDurationWarning()
    this.clearGoAway()
    this.callbacks.onError(error)
  }
}
