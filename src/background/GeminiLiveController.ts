import {approxBase64ByteLength} from "./audioHelpers"
import {timeoutSignal} from "./timeoutSignal"
import type {OpenAlmaConfig} from "./openAlmaConfig"
import type {ImageRequest} from "../shared/channels"
import {formatImageTimestamp} from "../shared/imageReference"
import type {CatchUpRender, CatchUpResult, FrameIntakeResult, FrameRetention, PassiveFrame, VisionStart} from "../shared/types"
import {MIC_SOURCES, PHOTO_RETRY_MESSAGE, STOP_FOREGROUND_MS, VISION_SETTINGS, type ImageTime, type LiveModel, type MicSource, type PhotoCaption, type SessionMode} from "../shared/types"

type StartResponse = {
  model: string
  recovery?: {sitting_id: string; ack_sequence: number} | null
  photo_work_protocol: typeof PHOTO_WORK_PROTOCOL
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

export class PhotoUploadConflict extends Error {}

export type GeminiCallbacks = {
  onFrameDeliveryChange?: (open: boolean) => void
  getStopDeadline?: () => number | null
  canInvite?: () => boolean
  onAudio: (base64Pcm: string) => void
  onTurnComplete: (finalResponse: boolean) => void
  onInterrupted: () => void
  onReconnecting: (reconnecting: boolean) => void
  onUsage: (totalTokens: number) => void
  onDurationWarning: () => void
  onPhotoRetryChange: (pending: boolean) => void
  onPhotoCaption?: (caption: PhotoCaption, acknowledgmentOnly: boolean) => void
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

type TranscriptDraft = Omit<TranscriptEvent, "sequence" | "event_id"> & {
  speech?: {waiting: boolean; late: boolean; uncertain: boolean; ended: boolean; admitted: boolean}
}

type PendingImage = {
  selected?: {cacheKey: string; mimeType: "image/jpeg"; rowEnqueued: boolean; uploadIssued: boolean}
  time?: ImageTime
  imageId: string
  mediaRef: string
  providerSent: boolean
  captionRequested?: boolean
  generation: number
  sessionId: string
  imageSequence?: number
  caption?: string
  assistantSequence?: number
  imageRecorded?: boolean
  captionEventId?: string
  speakDescription?: boolean
  retryRequested?: boolean
  retryUsed?: boolean
}

type StorageLike = {
  get(key: string): Promise<string | null>
  keys(): Promise<string[]>
  set(key: string, value: string): Promise<void>
  delete?(key: string): Promise<void>
}

type SessionJournal = {
  model?: string
  callMode?: VisionStart["callMode"]
  sessionId?: string
  version: 1 | 2 | 3
  scope: {userId: string; soulId: string; deviceSessionId: string}
  resumption: {handle: string; updatedAt: number} | null
  pendingTranscripts: TranscriptEvent[]
  draftTranscripts?: TranscriptDraft[]
  nextTranscriptSequence?: number
  pendingImage?: PendingImage | null
  pendingImages?: PendingImage[]
}

type TranscriptRecovery = {sitting_id: string; events: TranscriptEvent[]}

type SpokenRequest = {
  settled: boolean
  audible: boolean
  retired: boolean
  continuing: boolean
}

type ToolBatch = {
  // Outstanding native photo continuation, independent of caption/readiness sibling ownership.
  photo?: boolean
  invitation?: boolean
  request: SpokenRequest | null
  completed: boolean
  continuationSent: boolean
  background: boolean
  started: boolean
  photoSettling?: Set<string>
  photoContinuation?: boolean
  photoCaption?: boolean
}

type PendingToolCall = {
  invites?: boolean
  name: string
  generation: number
  sessionId: string
  batch: ToolBatch
  dispatched: boolean
  response?: string | Record<string, unknown>
  scheduling?: "WHEN_IDLE" | "SILENT"
  parts?: Array<{inlineData: {mimeType: string; data: string}}>
  quietChoice?: boolean
}

type DeliberatePhotoJob = {
  image: PendingImage
  batch: ToolBatch
  callId: string
  phase: "loading" | "settling" | "dispatched" | "filing"
  retryPending: boolean
  retryReserved?: boolean
}

type SelectionPhotoJob = Omit<DeliberatePhotoJob, "image"> & {
  image?: undefined
  selection: {frames: PassiveFrame[]; maximum: number; choices: Map<string, {caption: string; promise: Promise<boolean>}>;
    completion?: ToolBatch; excludedReadiness?: Set<string>; readiness?: PendingToolCall; finishing?: boolean; failed: boolean}
}
type PhotoJob = DeliberatePhotoJob | SelectionPhotoJob

function isUncertainWrite(call: PendingToolCall): boolean {
  return (call.name === "save_working_thought" || call.name === "annul_intention") &&
    ((call.dispatched && call.response === undefined) ||
      (typeof call.response === "object" && call.response.status === "uncertain"))
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
  journalOwner?: SessionJournalOwner
  frameRetention?: FrameRetention
  fetchFn?: typeof fetch
  openSocket?: (url: string) => SocketLike
  setupTimeoutMs?: number
  heartbeatMs?: number
  photoDrainTimeoutMs?: number
  storage?: StorageLike
}

const WS_OPEN = 1
const PHOTO_WORK_PROTOCOL = "iris-photo-work-v2"
const REQUEST_TIMEOUT_MS = 10_000
const TRANSCRIPT_CONTENT_LIMIT = 16_000
const SNAPSHOT_TIMEOUT_MS = 120_000
const PHOTO_UPLOAD_UNCONFIRMED_MESSAGE = "Photo may have been saved. Retry checks the original."
const TOOL_TIMEOUT_MS = 30_000
const WRITE_UNCERTAINTY_MESSAGE =
  "Write outcome is uncertain; it may have saved. Read current working state before deciding whether to try again."
const REFLECTION_TIMEOUT_MS = 8_000
const RECONNECT_SETUP_ATTEMPTS = 6
const GO_AWAY_MARGIN_MS = 2_000
export const JOURNAL_KEY = "openalma:gemini-session-v1"
export const RECOVERED_CHATS_KEY = "openalma:recovered-chats"
const RESUMPTION_MAX_AGE_MS = 30 * 60 * 1000
export const SITTING_REFLECTION_PROMPT =
  "Reflect briefly in first person on the emotional tone, subtext, or meaningful shift in this sitting that the literal transcript may not preserve. Do not recap the conversation. Respond with one or two natural sentences, or exactly NO_SUMMARY if nothing worthwhile would be added."
const PHOTO_CAPTION_REPEAT_REQUEST = "Your memory store didn't receive the photo caption. Please send it!"
const PHOTO_SETTLING_REPLY = {next: "A photo task is ready. Call nothing_to_add to receive it."}
const UNCERTAIN_SPEECH_PREFIX = "[Turn timing uncertain; combined speech, text retained in received order.]\n"

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

export async function readStoredValue(storage: Pick<StorageLike, "get" | "keys">, key: string, keys?: string[]): Promise<string | null> {
  const raw = await storage.get(key)
  if (raw === null && (keys ?? await storage.keys()).includes(key)) throw new Error("Local stored data could not be read")
  return raw
}

export async function readSessionJournal(storage: Pick<StorageLike, "get" | "keys">): Promise<{
  key: string | null; raw: string | null; unreadable: boolean
}> {
  let keys: string[]
  try { keys = await storage.keys() } catch { return {key: null, raw: null, unreadable: true} }
  const key = selectJournalKey(keys)
  try {
    const raw = await readStoredValue(storage, key, keys)
    return {key, raw: raw || null, unreadable: false}
  } catch {
    return {key: selectJournalKey(keys, true), raw: null, unreadable: true}
  }
}

// One writer outlives individual sockets/controllers. An uncertain native write
// can finish late, so the next write must use a newer key rather than overwrite it.
export class SessionJournalOwner {
  private tail: Promise<unknown> = Promise.resolve()
  private snapshot: Awaited<ReturnType<typeof readSessionJournal>> | null = null
  private producer = 0
  private uncertain = false
  private rotate = false
  private issuedKeys: string[] = []
  private archiveUncertain = false
  private detachedTail: Promise<unknown> | null = null

  constructor(private readonly storage: StorageLike) {}

  acquire(): number { return ++this.producer }
  active(producer: number): boolean { return producer === this.producer }
  retire(producer: number): void {
    if (!this.active(producer)) return
    this.producer += 1
    const tail = this.tail
    this.detachedTail = tail
    void tail.then(() => { if (this.detachedTail === tail) this.detachedTail = null })
  }
  fresh(): void { this.rotate = true }
  get hasDetachedWrites(): boolean { return this.detachedTail !== null }

  async waitForBackup(write: Promise<unknown>): Promise<void> {
    // Only an inherited, retired producer's durability tail may be abandoned.
    // The write itself remains ordered; callers needing an ACK still await write().
    if (!this.hasDetachedWrites) await write
  }

  async read(): Promise<Awaited<ReturnType<typeof readSessionJournal>>> {
    if (!this.snapshot) {
      const saved = await readSessionJournal(this.storage)
      if (!saved.unreadable) this.snapshot ??= saved
      if (saved.key && !saved.unreadable) this.issuedKeys.push(saved.key)
      this.uncertain ||= saved.unreadable
      return {...(this.snapshot ?? saved)}
    }
    return {...this.snapshot}
  }

  write(raw: string, producer: number): Promise<boolean> {
    if (!this.active(producer)) return Promise.resolve(false)
    const rotate = this.rotate
    this.rotate = false
    // Publish logical state now; never hydrate stale disk behind a detached write.
    this.snapshot = {key: this.snapshot?.key ?? null, raw: raw || null, unreadable: false}
    const write = this.tail.then(async () => {
      if (!this.snapshot?.key || this.uncertain || rotate) {
        const keys = [...await this.storage.keys(), ...this.issuedKeys]
        const key = selectJournalKey(keys, this.uncertain || rotate)
        this.issuedKeys.push(key)
        this.snapshot!.key = key
      }
      try {
        await this.storage.set(this.snapshot!.key!, raw)
        this.uncertain = false
        return true
      } catch {
        this.uncertain = true
        return false
      }
    }).catch(() => { this.uncertain = true; return false })
    this.tail = write
    return write
  }

  archive(raw: string, producer: number): Promise<void> {
    if (!this.active(producer)) return Promise.reject(new Error("Journal producer retired"))
    const write = this.tail.then(async () => {
      if (this.archiveUncertain) throw new Error("Recovered Chats write outcome uncertain")
      const previous = await readStoredValue(this.storage, RECOVERED_CHATS_KEY)
      let recovered: unknown
      try { recovered = JSON.parse(previous ?? "[]") } catch { recovered = null }
      const valid = Array.isArray(recovered) && recovered.every(value => typeof value === "string")
      const entries: string[] = valid ? recovered as string[] : previous === null ? [] : [previous]
      const exists = entries.includes(raw)
      if (!exists) entries.push(raw)
      if (!valid || !exists) {
        try { await this.storage.set(RECOVERED_CHATS_KEY, JSON.stringify(entries)) }
        catch (error) { this.archiveUncertain = true; throw error }
      }
    })
    this.tail = write.catch(() => {})
    return write
  }
}

export function journalSoulId(raw: string | null, config: Pick<OpenAlmaConfig, "userId" | "deviceSessionId">): string | null {
  try {
    const journal = JSON.parse(raw ?? "") as Partial<SessionJournal>
    const scope = journal.scope
    if (
      (journal.version !== 1 && journal.version !== 2 && journal.version !== 3) ||
      scope?.userId !== config.userId ||
      scope.deviceSessionId !== config.deviceSessionId ||
      typeof scope.soulId !== "string" ||
      !scope.soulId.trim()
    ) return null
    if (
      !journal.pendingTranscripts?.length && !journal.draftTranscripts?.length &&
      !(journal.version === 3 ? journal.pendingImages?.length : journal.pendingImage) &&
      !(journal.resumption?.handle?.trim() && Number.isFinite(journal.resumption.updatedAt) &&
        Date.now() - journal.resumption.updatedAt <= RESUMPTION_MAX_AGE_MS)
    ) return null
    return scope.soulId
  } catch {
    return null
  }
}

export function journalImageIds(raw: string | null, scope: Pick<OpenAlmaConfig, "userId" | "soulId">): string[] {
  try {
    const journal = JSON.parse(raw ?? "") as Partial<SessionJournal>
    if ((journal.version !== 1 && journal.version !== 2 && journal.version !== 3) || journal.scope?.userId !== scope.userId ||
        journal.scope.soulId !== scope.soulId) return []
    const images = journal.version === 3 ? journal.pendingImages : journal.pendingImage ? [journal.pendingImage] : []
    return Array.isArray(images) ? images.flatMap(image => typeof image?.imageId === "string" ? [image.imageId] : []) : []
  } catch {return []}
}

class TokenRefreshError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message)
  }
}

export class GeminiLiveController {
  model = ""
  private get thinking(): boolean { return this.model === "gemini-3.8-live-extended-thinking" }
  private readonly frameRetention: FrameRetention | undefined
  private candidateFrames: PassiveFrame[] = []
  private vision: VisionStart = {callMode: "audio", maxMemorizedPhotos: 1}
  private visionAvailable = false
  private sittingStartedAt = 0
  private visionStoppedAt: number | null = null
  private chosenIds = new Set<string>()
  private selectedMediaCommitted = new WeakSet<PendingImage>()
  private offeredIds = new Set<string>()
  private selectionNeedsCurrentView = false
  private retentionPressure = false
  private passiveSequence = 0
  private lastVisualAt = -Infinity
  private renderSequence = 0
  private catchUpIds = new Set<string>()
  private catchUpAttempt: (CatchUpRender & {createdAt: number; socket: SocketLike}) | null = null
  private readonly fetchFn: typeof fetch
  private readonly openSocket: (url: string) => SocketLike
  private readonly setupTimeoutMs: number
  private readonly heartbeatMs?: number
  private readonly photoDrainTimeoutMs: number
  private readonly storage?: StorageLike
  private readonly journalOwner?: SessionJournalOwner
  private readonly journalProducer: number
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
  private outputTranscript = ""
  private turnMicSource: MicSource | undefined
  private interruptionFinalized = false
  private turnActive = false
  private turnHasToolCall = false
  private spokenRequest: SpokenRequest | null = null
  private toolBatch: ToolBatch = {request: null, completed: false, continuationSent: false, background: true, started: false}
  private handlingMessage = false
  private turnAudioDelivered = false
  private voiceActive = false
  private invitationPending = false
  private hasCompletedProviderTurn = false
  private receivedSpeech = false
  private completeUserTurns = 0
  private pendingEvents: TranscriptEvent[] = []
  private draftEvents: TranscriptDraft[] = []
  private missingSpeech = false
  private pendingImages: PendingImage[] = []
  private get pendingImage(): PendingImage | null {
    // Keep a settling attempt's owner; parked originals do not block later work.
    const active = this.photoJob?.image
    if (active && this.pendingImages.includes(active)) return active
    return this.pendingImages.find(image => !image.retryRequested && image.mediaRef) ?? this.pendingImages[0] ?? null
  }

  get pendingPhotoIds(): string[] {
    return this.pendingImages.filter(image => image.retryRequested).map(image => image.imageId)
  }

  get pendingImageIds(): string[] {
    return [...this.pendingImages.map(image => image.imageId), ...this.candidateFrames.map(frame => frame.imageId)]
  }

  admitFrame(frame: PassiveFrame, allowNew = true): FrameIntakeResult {
    this.refreshStopDeadline()
    const limits = this.frameRetention
    if (!limits) throw new Error("Passive frame intake is not configured")
    if (!frame || !Number.isSafeInteger(frame.reservationSequence) || frame.reservationSequence < 1 ||
        typeof frame.imageId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(frame.imageId) ||
        frame.mimeType !== "image/jpeg" || ![frame.data, frame.modelData].every(data =>
          typeof data === "string" && data.length > 0 && data.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(data)) ||
        !frame.time || frame.time.source !== "receipt" || !Number.isFinite(frame.time.receivedAt) ||
        typeof frame.time.timestamp !== "string" || frame.time.timestamp !== formatImageTimestamp(frame.time.timestamp)) {
      throw new Error("Invalid passive frame")
    }
    const previous = this.candidateFrames.find(candidate => candidate.imageId === frame.imageId)
    if (previous) {
      if (previous.mimeType !== frame.mimeType || previous.data !== frame.data || previous.modelData !== frame.modelData ||
          previous.reservationSequence !== frame.reservationSequence ||
          previous.time.timestamp !== frame.time.timestamp || previous.time.receivedAt !== frame.time.receivedAt) {
        throw new Error("Frame reference is already in use")
      }
      return {retained: true, delivery: "not-sent"}
    }
    if (this.pendingImages.some(image => image.imageId === frame.imageId)) throw new Error("Frame reference is already in use")
    if (!allowNew || !this.ready || this.reconnecting || this.goAwayPending || this.stopping || this.stopPromise ||
        this.reflecting || this.outputMuted || this.errorReported || this.activityPauseReason || this.socket?.readyState !== WS_OPEN) {
      return {retained: false, delivery: "not-sent", reason: "unavailable"}
    }
    if (frame.reservationSequence <= this.passiveSequence) return {retained: false, delivery: "not-sent", reason: "stale"}
    this.passiveSequence = frame.reservationSequence
    const size = frame.data.length + frame.modelData.length
    let retainedSize = this.candidateFrames.reduce((total, candidate) => total + candidate.data.length + candidate.modelData.length, 0)
    if (retainedSize + size > limits.maxEncodedBytes) this.retentionPressure = true
    // Keep one recent window; a pending render must never refer to an evicted original.
    while (this.vision.callMode === "video" && this.candidateFrames.length &&
        (this.candidateFrames.length >= limits.maxFrames || retainedSize + size > limits.maxEncodedBytes)) {
      const index = this.candidateFrames.findIndex(candidate => !this.selectionFrames().some(frame => frame.imageId === candidate.imageId) &&
        !this.pendingImages.some(image => image.imageId === candidate.imageId))
      if (index < 0) break
      const [oldest] = this.candidateFrames.splice(index, 1)
      if (this.catchUpAttempt?.imageIds.includes(oldest.imageId)) this.retireCatchUp()
      this.catchUpIds.delete(oldest.imageId)
      retainedSize -= oldest.data.length + oldest.modelData.length
    }
    const retained = this.candidateFrames.length < limits.maxFrames && retainedSize + size <= limits.maxEncodedBytes
    if (retained) this.candidateFrames.push({imageId: frame.imageId, mimeType: frame.mimeType,
      data: frame.data, modelData: frame.modelData, reservationSequence: frame.reservationSequence,
      time: {timestamp: frame.time.timestamp, receivedAt: frame.time.receivedAt, source: "receipt"}})
    if (retained && !this.frameDeliveryOpen) this.catchUpIds.add(frame.imageId)
    if (this.catchUpAttempt && Date.now() - this.catchUpAttempt.createdAt >= VISION_SETTINGS.capturePeriodMs) {
      console.error("[OpenAlma] Catch-up rendering missed its capture period; resuming current view")
      this.retireCatchUp()
    }
    this.publishFrameDelivery()
    const sent = !this.catchUpAttempt && this.sendVisual(frame.modelData)
    if (sent) this.selectionNeedsCurrentView = false
    this.resumeBackgroundWork()
    return retained ? {retained: true, delivery: sent ? "sent" : "not-sent"}
      : sent ? {retained: false, delivery: "sent"} : {retained: false, delivery: "not-sent", reason: "full"}
  }

  get catchUpRender(): CatchUpRender | null {
    return this.catchUpAttempt ? {renderId: this.catchUpAttempt.renderId, imageIds: [...this.catchUpAttempt.imageIds]} : null
  }

  setVisionAvailability(available: boolean): void {
    this.visionAvailable = available
    if (!available) this.retireCatchUp()
    this.publishFrameDelivery()
  }

  submitCatchUp(result: CatchUpResult): void {
    const attempt = this.catchUpAttempt
    if (!attempt || result.renderId !== attempt.renderId) return
    const eligible = !result.error && typeof result.data === "string" && result.data.length > 0 &&
      result.data.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(result.data) &&
      result.data.length <= VISION_SETTINGS.maxEncodedBytes &&
      this.socket === attempt.socket && Date.now() - attempt.createdAt < VISION_SETTINGS.capturePeriodMs &&
      attempt.imageIds.every(id => this.candidateFrames.some(frame => frame.imageId === id))
    if (eligible) this.sendVisual(result.data!, "These are frames you missed while you were working on captioning memories. Reading order is like prose in a book.")
    this.retireCatchUp()
    this.publishFrameDelivery()
  }

  private retireCatchUp(): void {
    this.catchUpIds.clear()
    this.catchUpAttempt = null
  }

  private sendVisual(data: string, text?: string): boolean {
    if (this.vision.callMode !== "video" || !this.visionAvailable || !this.frameDeliveryOpen ||
        !this.socket || this.socket.readyState !== WS_OPEN ||
        // Capture already paces frames; tolerate reservation/rendering jitter.
        Date.now() - this.lastVisualAt < VISION_SETTINGS.capturePeriodMs / 2) return false
    this.socket.send(JSON.stringify({realtimeInput: {video: {data, mimeType: "image/jpeg"}, ...(text ? {text} : {})}}))
    this.lastVisualAt = Date.now()
    this.previewRevision += 1
    return true
  }

  readFrames(imageIds: readonly string[]): PassiveFrame[] {
    this.refreshStopDeadline()
    if (!Array.isArray(imageIds) || imageIds.length > (this.frameRetention?.maxFrames ?? 0) ||
        imageIds.some(id => typeof id !== "string" || !id) || new Set(imageIds).size !== imageIds.length) {
      throw new Error("Invalid frame references")
    }
    return imageIds.map(id => {
      const frame = this.candidateFrames.find(candidate => candidate.imageId === id)
      if (!frame) throw new Error("Unknown retained frame")
      return {...frame, time: {...frame.time}}
    })
  }

  // Opportunity only: vision activation, cadence and catch-up ownership remain separate.
  get frameDeliveryOpen(): boolean {
    return this.ready && !this.stopping && !this.stopPromise && !this.outputMuted && !this.errorReported &&
      !this.reconnecting && !this.goAwayPending && !this.reflecting && !this.activityPauseReason &&
      !this.photoJob && !this.imageUpload && !this.imageFinalization && !this.imageRetrying &&
      !this.pendingImages.some(image => !image.retryRequested) &&
      ![...this.pendingToolCalls.values()].some(call => call.name === "save_photo_caption") &&
      this.toolBatch.photo !== true
  }

  private lastPublishedFrameDelivery = false
  private lastPublishedRender: string | undefined

  private publishFrameDelivery(): void {
    if (this.journalOwner && !this.journalOwner.active(this.journalProducer)) return
    const open = this.frameDeliveryOpen
    if (!open && this.catchUpAttempt) this.retireCatchUp()
    if (open && this.visionAvailable && this.vision.callMode === "video" && !this.catchUpAttempt && this.catchUpIds.size && this.socket &&
        Date.now() - this.lastVisualAt >= VISION_SETTINGS.capturePeriodMs / 2) {
      const frames = this.candidateFrames.filter(frame => this.catchUpIds.has(frame.imageId))
      const imageIds = frames.length <= VISION_SETTINGS.maxOffer ? frames.map(frame => frame.imageId) :
        Array.from({length: VISION_SETTINGS.maxOffer}, (_, i) => frames[Math.round(i * (frames.length - 1) / (VISION_SETTINGS.maxOffer - 1))].imageId)
      if (imageIds.length) this.catchUpAttempt = {renderId: `${this.sessionId}:render:${++this.renderSequence}`,
        imageIds, createdAt: Date.now(), socket: this.socket}
    }
    const render = this.catchUpAttempt?.renderId
    if (open === this.lastPublishedFrameDelivery && render === this.lastPublishedRender) return
    this.lastPublishedFrameDelivery = open
    this.lastPublishedRender = render
    this.callbacks.onFrameDeliveryChange?.(open)
  }

  private removePendingImage(image: PendingImage): void {
    this.pendingImages = this.pendingImages.filter(pending => pending !== image)
  }

  private publishPhotoRetry(): void {
    if (this.journalOwner && !this.journalOwner.active(this.journalProducer)) return
    this.callbacks.onPhotoRetryChange(this.pendingImages.some(image => image.retryRequested))
  }
  private previewRevision = 0
  private settledPreviewRevision = -1
  private acceptedCaptions = new Map<string, string>()
  private spokenPhotos: string[] = []
  private imageUpload: Promise<void> | null = null
  private draining = false
  private drainInputFlushed = false
  private outputMuted = false
  private quietOutput: {keepTranscript: boolean} | null = null
  private drainDeadlineAt = 0
  private stopDeadlineTimer: ReturnType<typeof setTimeout> | null = null
  private drainResolve: (() => void) | null = null
  private imageRetrying = false
  private appendTail: Promise<void> = Promise.resolve()
  private imageFinalization: {image: PendingImage; promise: Promise<void>} | null = null
  private imageFinalizationExplicit = false
  private journalLoaded = false
  private loadedJournal: string | null = null
  private persistenceFatal = false
  private journalUnavailable = false
  private reflecting = false
  private reflectionResolve: ((value: string | null) => void) | null = null
  private stopPromise: Promise<void> | null = null
  private stopWaiters = new Set<() => void>()
  private generation = 0
  private ready = false
  private pendingToolCalls = new Map<string, PendingToolCall>()
  private deliveredToolResultIds = new Set<string>()
  private audioFramesSent = 0
  private providerAudioChunks = 0
  private mode: SessionMode = "continuous"
  private latestUsageTotal: number | null = null
  private photoJob: PhotoJob | null = null
  private photoTimer: ReturnType<typeof setTimeout> | null = null
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
    this.photoDrainTimeoutMs = options.photoDrainTimeoutMs ?? STOP_FOREGROUND_MS
    this.storage = options.storage
    this.journalOwner = options.journalOwner ?? (this.storage ? new SessionJournalOwner(this.storage) : undefined)
    this.journalProducer = this.journalOwner?.acquire() ?? 0
    if (options.frameRetention && (!Number.isSafeInteger(options.frameRetention.maxFrames) || options.frameRetention.maxFrames < 1 ||
        !Number.isSafeInteger(options.frameRetention.maxEncodedBytes) || options.frameRetention.maxEncodedBytes < 1)) {
      throw new Error("Invalid frame retention limits")
    }
    this.frameRetention = options.frameRetention ? {...options.frameRetention} : undefined
  }

  async start(mode: SessionMode = "continuous", model?: LiveModel, vision?: VisionStart): Promise<void> {
    if (this.generation !== 0 || this.stopPromise) throw new Error("Gemini controller is single-use")
    trace("provider.start.begin")
    const generation = ++this.generation
    if (vision) {
      if (!["audio", "video"].includes(vision.callMode) || !Number.isInteger(vision.maxMemorizedPhotos) ||
          vision.maxMemorizedPhotos < 1 || vision.maxMemorizedPhotos > 5) throw new Error("Invalid vision settings")
      this.vision = {...vision}
    }
    this.mode = mode
    try {
      await this.hydrateJournal(generation)
      if (this.stopping || generation !== this.generation) throw new Error("Gemini start cancelled")
      const recovery = await this.prepareRecovery(generation)
      if (this.stopping || generation !== this.generation) throw new Error("Gemini start cancelled")
      const response = await this.requestStart(mode, recovery, generation, model)
      if (this.stopping || generation !== this.generation) {
        await this.endLease()
        throw new Error("Gemini start cancelled")
      }
      this.model = response.model
      await this.reconcileJournal(Boolean(response.recovery))
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
          await this.persistBackup()
        } catch (coldError) {
          if (!this.stopping && generation === this.generation) {
            this.resumptionHandle = hydratedHandle
            await this.persistBackup()
          }
          throw coldError
        }
      }
      trace("provider.socket.ready")
      this.sittingStartedAt = Date.now()
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

  resumeBackgroundWork(): void {
    this.flushToolResponses()
  }

  refreshStopDeadline(): void {
    for (const refresh of this.stopWaiters) refresh()
    const supplied = this.callbacks.getStopDeadline?.()
    if (!this.draining && !this.reflecting) {
      // Speaker retirement can consume the Stop allowance before provider draining starts.
      if (supplied !== null && supplied !== undefined && supplied <= Date.now()) this.candidateFrames = []
      return
    }
    if (supplied !== null && supplied !== undefined) this.drainDeadlineAt = supplied
    else if (!this.draining) return
    this.clearStopDeadlineTimer()
    const finish = () => {
      this.candidateFrames = []
      if (this.draining) this.drainResolve?.()
      if (this.reflecting) this.finishReflection()
    }
    const remaining = this.drainDeadlineAt - Date.now()
    if (remaining <= 0) finish()
    else this.stopDeadlineTimer = setTimeout(finish, remaining)
  }

  private clearStopDeadlineTimer(): void {
    if (this.stopDeadlineTimer) clearTimeout(this.stopDeadlineTimer)
    this.stopDeadlineTimer = null
  }

  private sendInvitation(): void {
    this.requestSpokenPhotoDescription()
    if (this.selectionDemand(true)) this.invitationPending = true
    if (this.draining && Date.now() >= this.drainDeadlineAt) { this.refreshStopDeadline(); return }
    if (!this.invitationPending || this.handlingMessage || !this.ready || this.stopping || (this.stopPromise && !this.draining) || (this.outputMuted && !this.draining) ||
        this.reconnecting || this.goAwayPending || this.reflecting || this.activityPauseReason ||
        this.voiceActive || this.turnActive || this.toolBatch.started || this.spokenRequest || this.photoJob ||
        this.imageUpload || this.imageFinalization || (this.draining && !this.drainInputFlushed) ||
        (!this.draining && this.callbacks.canInvite?.() === false) ||
        !this.socket || this.socket.readyState !== WS_OPEN) return
    this.invitationPending = false
    this.socket.send(JSON.stringify(this.mode === "continuous"
      ? {realtimeInput: {text: "nokoru"}}
      : {clientContent: {turns: [{role: "user", parts: [{text: "nokoru"}]}], turnComplete: true}}))
    this.toolBatch.started = true
    this.toolBatch.invitation = true
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
      this.reserveSpeech(micSource)
      this.admitSpokenRequest()
      this.turnActive = true
      for (const chunk of audioChunks) {
        if (socket.readyState !== WS_OPEN) throw new Error("socket closed during Manual activity")
        this.sendAudioToSocket(socket, chunk)
        this.turnMicSource = micSource
      }
      if (socket.readyState !== WS_OPEN) throw new Error("socket closed during Manual activity")
      socket.send(JSON.stringify({realtimeInput: {activityEnd: {}}}))
      ended = true
      const speech = this.pendingSpeechDraft()
      if (speech) speech.speech!.ended = true
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
    if (this.stopPromise || this.outputMuted) return Promise.reject(new Error("Photo send cancelled"))
    if (this.imageUpload) return Promise.reject(new Error("Wait for the current photo upload to finish"))
    const upload = this.performSendImage(image).finally(() => {
      if (this.imageUpload === upload) {
        this.imageUpload = null
        this.resumeBackgroundWork()
      }
    })
    this.imageUpload = upload
    this.publishFrameDelivery()
    return upload
  }

  private async performSendImage(image: ImageRequest): Promise<void> {
    if (this.activityPauseReason) throw new Error(this.activityPauseReason)
    if (!this.storage) throw new Error("Local image journal unavailable")
    const socket = this.socket
    if (!this.ready || this.stopping || !socket || socket.readyState !== WS_OPEN) {
      throw new Error("Gemini socket is not ready")
    }
    const generation = this.generation
    const sessionId = this.sessionId
    const pendingBeforeUpload = this.pendingImages.find(pending => pending.imageId === image.imageId)
    if (pendingBeforeUpload?.providerSent) return
    const pending: PendingImage = pendingBeforeUpload ?? {
      imageId: image.imageId, mediaRef: "", providerSent: false, captionRequested: false,
      generation, sessionId, ...(image.time ? {time: image.time} : {}),
    }
    pending.speakDescription = image.speakDescription === true
    pending.retryRequested = true
    if (!pendingBeforeUpload) this.pendingImages.push(pending)
    await this.persistJournal()
    if (this.journalUnavailable) throw new Error("Local image journal unavailable")
    if (this.stopping || this.reflecting || generation !== this.generation || !this.pendingImages.includes(pending)) {
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
      const conflict = response.status === 409 && (await response.clone().json().catch(() => null))?.detail === "Snapshot image id conflicts"
      if (!this.stopping && !this.reflecting && generation === this.generation &&
          this.pendingImages.includes(pending) && !pending.mediaRef && (!pendingBeforeUpload || conflict) &&
          response.status >= 400 && response.status < 500) {
        this.removePendingImage(pending)
        await this.persistJournal()
      }
      if (conflict) throw new PhotoUploadConflict("Photo reference is already in use")
      throw new Error(`OpenAlma snapshot failed (${response.status})`)
    }
    const result = (await response.json()) as {media_ref?: unknown}
    if (
      this.stopping || this.reflecting || generation !== this.generation || sessionId !== this.sessionId
    ) {
      throw new Error("Photo send cancelled")
    }
    if (!this.pendingImages.includes(pending)) throw new Error("Photo send cancelled")
    const mediaRef = typeof result.media_ref === "string" ? result.media_ref.trim() : ""
    if (!mediaRef.startsWith("mentra_media/") || mediaRef.includes("..")) {
      throw new Error("OpenAlma snapshot returned an invalid media reference")
    }

    if (pending.mediaRef && pending.mediaRef !== mediaRef) throw new Error("OpenAlma snapshot media reference changed")
    pending.mediaRef = mediaRef
    pending.speakDescription = image.speakDescription === true
    pending.generation = this.generation
    pending.sessionId = this.sessionId
    await this.persistJournal()
    if (this.journalUnavailable) throw new Error("Local image journal unavailable")
    if (!this.pendingImages.includes(pending) || generation !== this.generation) throw new Error("Photo send cancelled")
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
    let sent: boolean
    try {
      sent = await this.sendImagePreview(activeSocket, image.mimeType, image.data, pending)
    } catch {
      await this.requestPhotoRetry(pending)
      throw new Error(this.activityPauseReason || "Gemini image send failed")
    }
    if (!sent) {
      await this.requestPhotoRetry(pending)
      throw new Error(this.activityPauseReason || "Photo send cancelled")
    }
    pending.providerSent = true
    pending.retryRequested = false
    this.publishPhotoRetry()
    this.enqueueImageMarker(pending)
    await this.persistJournal()
    this.scheduleAppend()
  }

  async retryImage(imageId: string): Promise<void> {
    const image = this.pendingImages.find(image => image.imageId === imageId)
    if (!image) throw new Error("No photo is waiting to retry")
    if (this.photoJob && this.photoJob.image !== image) throw new Error("Wait for the current photo to finish before retrying")
    if (this.stopping || this.imageRetrying || !this.ready || this.socket?.readyState !== WS_OPEN) {
      throw new Error("Wait for Gemini to reconnect before retrying the photo")
    }
    if (this.turnActive && !image.caption) throw new Error("Wait for the current reply to finish before retrying the photo")
    if (image.caption) {
      if (image.selected) {
        if (this.imageUpload) throw new Error("Wait for the current photo upload to finish")
        await this.startSelectedPromotion(image)
        return
      }
      await this.scheduleImageFinalize(true, image)
      return
    }
    if (image.providerSent && !image.retryRequested) {
      throw new Error("No photo is waiting to retry")
    }
    image.providerSent = false
    image.retryUsed = false
    if (this.photoJob?.image === image) this.clearPhotoJob()
    await this.retryPendingImage(true, image)
  }

  async discardImage(imageId: string): Promise<void> {
    if (this.stopPromise || !this.ownsJournal()) throw new Error("Wait for Stop to finish before discarding the photo")
    if (!this.journalLoaded) throw new Error("Wait for local recovery to finish before discarding the photo")
    const image = this.pendingImages.find(image => image.imageId === imageId)
    if (!image) throw new Error("Unknown pending photo")
    if (this.photoJob?.image === image) {
      const call = this.pendingToolCalls.get(this.photoJob.callId)
      if (call) {
        call.parts = undefined
        call.response = undefined
        call.scheduling = undefined
      }
      this.clearPhotoJob()
    }
    this.removePendingImage(image)
    const saved = await this.persistJournal()
    if (!this.ownsJournal()) return
    if (image.selected && !image.selected.uploadIssued) this.chosenIds.delete(image.imageId)
    if (saved && image.selected && this.ownsJournal()) await this.deleteCachedOriginal(image)
    else if (!saved && image.selected) this.callbacks.onPersistenceError("Discard not saved; the photo may return after reopening Iris")
    this.publishPhotoRetry()
    this.clearPersistenceErrorIfSynced()
    if (this.pendingImages.some(image => !image.retryRequested && !image.caption)) this.invitationPending = true
    void this.retryPendingImage()
    this.resumeBackgroundWork()
  }

  private async sendImagePreview(socket: SocketLike, mimeType: "image/jpeg" | "image/png", data: string, image: PendingImage): Promise<boolean> {
    if (this.activityPauseReason || this.stopping || this.reflecting || !this.ready || this.socket !== socket ||
        socket.readyState !== WS_OPEN || !this.pendingImages.includes(image) || (this.stopPromise && !this.draining)) return false
    socket.send(JSON.stringify({realtimeInput: {video: {data, mimeType}}}))
    this.previewRevision += 1
    this.invitationPending = true
    return true
  }

  private clearPhotoJob(): void {
    if (this.photoTimer) clearTimeout(this.photoTimer)
    this.photoTimer = null
    const job = this.photoJob
    this.photoJob = null
    if (job?.image && job.retryReserved && job.phase !== "dispatched" && job.phase !== "filing") {
      job.image.retryUsed = false
      void this.persistJournal()
    }
  }

  private settlePhotoReadiness(id: string, call: PendingToolCall, image: PendingImage, retryPending: boolean): void {
    this.clearPhotoJob()
    this.photoJob = {image, batch: call.batch, callId: id, phase: "settling", retryPending}
    this.settledPreviewRevision = this.previewRevision
    call.batch.photoSettling = new Set(this.pendingToolCalls.keys())
    call.parts = undefined
    call.response = PHOTO_SETTLING_REPLY
    call.scheduling = "WHEN_IDLE"
  }

  private selectionFrames(): PassiveFrame[] {
    return this.photoJob && "selection" in this.photoJob ? this.photoJob.selection.frames : []
  }

  private selectionAllowance(): number {
    const minutes = Math.max(0, (this.visionStoppedAt ?? Date.now()) - this.sittingStartedAt) / 60_000
    return Math.max(0, Math.round(this.vision.maxMemorizedPhotos *
      (1 + Math.log(Math.max(minutes, 5) / 5) / Math.log(3))) - this.chosenIds.size)
  }

  private selectionDemand(invitation = false): boolean {
    if (this.vision.callMode !== "video" || !this.storage || !this.selectionAllowance() ||
        (!this.draining && this.visionStoppedAt === null && this.selectionNeedsCurrentView)) return false
    const frames = this.candidateFrames.filter(frame => !this.offeredIds.has(frame.imageId) && !this.chosenIds.has(frame.imageId))
    return frames.length > 0 && (!invitation || this.draining || this.retentionPressure || frames.length >= VISION_SETTINGS.maxOffer)
  }

  private dispatchSelection(id: string, call: PendingToolCall, existing?: SelectionPhotoJob): void {
    const frames = this.candidateFrames.filter(frame => !this.offeredIds.has(frame.imageId) && !this.chosenIds.has(frame.imageId))
      .slice(0, VISION_SETTINGS.maxOffer)
    const job: SelectionPhotoJob = existing ?? {batch: call.batch, callId: id, phase: "loading", retryPending: false,
      selection: {frames, maximum: Math.min(frames.length, this.selectionAllowance()), choices: new Map(), failed: false}}
    this.photoJob = job
    job.callId = id
    job.batch = call.batch
    if (this.settledPreviewRevision !== this.previewRevision) {
      job.phase = "settling"
      this.settledPreviewRevision = this.previewRevision
      // Thinking can request the next task before this native turn completes.
      call.batch.photoSettling = new Set(this.pendingToolCalls.keys())
      call.response = PHOTO_SETTLING_REPLY
      call.scheduling = "WHEN_IDLE"
      return
    }
    if (call.batch.photoSettling?.has(id)) { call.response = {ok: true}; return }
    job.phase = "loading"
    this.retentionPressure = false
    call.parts = job.selection.frames.map(frame => ({inlineData: {mimeType: frame.mimeType, data: frame.modelData}}))
    call.response = {task: `Keep at most ${job.selection.maximum} photo${job.selection.maximum === 1 ? "" : "s"}.`}
    call.scheduling = "WHEN_IDLE"
  }

  private finishSelection(job: SelectionPhotoJob): void {
    if (this.photoJob !== job) return
    this.clearPhotoJob()
    this.selectionNeedsCurrentView = true
    for (const call of this.pendingToolCalls.values()) {
      if (call.name === "nothing_to_add" && call.response === undefined) {
        this.answerNoWork(call, job.selection.failed)
        call.scheduling = "SILENT"
      }
    }
    // Offered failures are not reoffers. Catch-up may still own the same frames.
    this.publishFrameDelivery()
  }

  private completeSelectionIfReady(job: SelectionPhotoJob): void {
    // Thinking segments complete before the native interaction reaches IDLE.
    if (this.thinking && this.toolBatch.started) return
    // Co-packet calls are registered before their native completion, then dispatched.
    if (!job.selection.choices.size && [...this.pendingToolCalls.values()].some(call =>
      call.name === "save_photo_caption" && call.response === undefined)) return
    if (!job.selection.completion?.completed || job.selection.finishing ||
        (job.selection.choices.size > 0 && !job.selection.readiness?.batch.completed)) return
    job.selection.finishing = true
    void Promise.all([...job.selection.choices.values()].map(choice => choice.promise)).then(() => {
      this.finishSelection(job)
      this.resumeBackgroundWork()
    })
  }

  private dispatchPhotoWork(): void {
    if (this.draining && Date.now() >= this.drainDeadlineAt) { this.refreshStopDeadline(); return }
    if (!this.ready || this.stopping || this.reflecting || this.activityPauseReason || this.imageRetrying || (this.outputMuted && !this.draining) ||
        (this.stopPromise && !this.draining) || (this.draining && !this.drainInputFlushed)) return
    while (true) {
      const ready = [...this.pendingToolCalls].find(([id, call]) => id !== this.photoJob?.callId && call.name === "nothing_to_add" &&
        call.dispatched && call.response === undefined)
      if (!ready) return
      const [id, call] = ready
      if (this.photoJob && "selection" in this.photoJob && this.photoJob.phase === "settling") {
        if (call.batch.photoSettling?.has(id)) { call.response = {ok: true}; continue }
        if (this.pendingImages.some(image => !image.caption && !image.retryRequested && image.mediaRef)) this.clearPhotoJob()
        else { this.dispatchSelection(id, call, this.photoJob); return }
      }
      if (this.photoJob && "selection" in this.photoJob) {
        if (this.photoJob.selection.excludedReadiness?.has(id)) { call.response = {ok: true}; continue }
        this.photoJob.selection.readiness ??= call
        // Thinking cannot reach IDLE while waiting for this tool result.
        if (this.thinking && !this.imageUpload) this.answerNoWork(call, this.photoJob.selection.failed)
        this.completeSelectionIfReady(this.photoJob)
        return
      }
      const image = this.photoJob?.image ?? this.pendingImages.find(image => !image.caption && !image.retryRequested && image.mediaRef)
      if ((this.photoJob?.phase !== "settling" && this.photoJob?.batch === call.batch) ||
          (call.batch.photoCaption && (!this.thinking || this.photoJob || !image))) {
        if (this.thinking && !this.photoJob) this.answerNoWork(call)
        else call.response = {ok: true}
        continue
      }
      if (this.photoJob?.phase === "loading" || this.photoJob?.phase === "filing" || this.imageFinalization ||
          [...this.pendingToolCalls.values()].some(call => call.name === "save_photo_caption" && call.response === undefined)) return
      if (!image) {
        if (this.selectionDemand() && !this.imageUpload && (this.draining ||
            (!this.voiceActive && !this.turnActive && !this.spokenRequest && this.callbacks.canInvite?.() !== false))) {
          this.dispatchSelection(id, call)
          return
        }
        this.answerNoWork(call)
        continue
      }
      if (!this.draining && (this.voiceActive || this.turnActive || (this.spokenRequest && !this.spokenRequest.retired) ||
          this.callbacks.canInvite?.() === false)) return
      const missingCaption = this.photoJob?.phase === "dispatched" || this.photoJob?.retryPending === true
      if (this.settledPreviewRevision !== this.previewRevision) {
        this.settlePhotoReadiness(id, call, image, missingCaption)
        continue
      }
      // Co-packet readiness calls are not a second, post-settling model decision.
      if (call.batch.photoSettling?.has(id)) { call.response = {ok: true}; continue }
      this.clearPhotoJob()
      const job: PhotoJob = {image, batch: call.batch, callId: id, phase: "loading", retryPending: missingCaption}
      this.photoJob = job
      void this.loadPhotoJob(id, call, job).catch(async error => {
        if (this.photoJob !== job) return
        this.clearPhotoJob()
        await this.requestPhotoRetry(image)
        this.flushToolResponses()
        trace("photo.job.failed", {imageId: image.imageId, error: String(error)})
      })
      return
    }
  }

  private async loadPhotoJob(id: string, call: PendingToolCall, job: DeliberatePhotoJob): Promise<void> {
    const image = job.image
    const response = await this.request(`/integration/mentra/session/${this.sessionId}/snapshot/replay`, {
      user_id: this.config.userId, soul_id: this.config.soulId, image_id: image.imageId,
    }, SNAPSHOT_TIMEOUT_MS)
    if (this.photoJob !== job || job.phase !== "loading" || image.caption || !this.isCurrentToolCall(id, call)) return
    if (!response.ok) throw new Error(`Photo original lookup failed (${response.status})`)
    const replay = await response.json()
    if (this.photoJob !== job || job.phase !== "loading" || image.caption || !this.isCurrentToolCall(id, call)) return
    if (this.activityPauseReason) throw new Error(this.activityPauseReason)
    const filed = this.filingCaption(replay.filing)
    if (filed !== null) {
      this.acceptedCaptions.set(image.imageId, filed)
      this.callbacks.onPhotoCaption?.({imageId: image.imageId, caption: filed, durable: true}, false)
      this.removePendingImage(image)
      await this.persistJournal()
      this.clearPhotoJob()
      this.publishPhotoRetry()
      this.flushToolResponses()
      return
    }
    if ((replay.mime_type !== "image/jpeg" && replay.mime_type !== "image/png") ||
        typeof replay.data !== "string" || !replay.data || !image.mediaRef ||
        replay.media_ref !== image.mediaRef) throw new Error("Invalid stored photo")
    if (this.settledPreviewRevision !== this.previewRevision) {
      this.settlePhotoReadiness(id, call, image, job.retryPending)
      this.flushToolResponses()
      return
    }
    if (job.retryPending && image.retryUsed) {
      this.clearPhotoJob()
      await this.requestPhotoRetry(image)
      this.flushToolResponses()
      return
    }
    job.retryReserved = job.retryPending
    if (job.retryPending) image.retryUsed = true
    image.providerSent = true
    this.enqueueImageMarker(image)
    await this.persistJournal()
    this.scheduleAppend()
    if (this.photoJob !== job || job.phase !== "loading" || image.caption || !this.isCurrentToolCall(id, call)) return
    if (this.activityPauseReason) throw new Error(this.activityPauseReason)
    call.parts = [{inlineData: {mimeType: replay.mime_type, data: replay.data}}]
    call.scheduling = "WHEN_IDLE"
    call.response = {task: `${image.retryUsed ? PHOTO_CAPTION_REPEAT_REQUEST + "\n" : ""}please-caption-${image.imageId}`}
    this.flushToolResponses()
  }

  private async retryPendingImage(userRequested = false, pending = this.pendingImage): Promise<void> {
    if (this.activityPauseReason || (this.draining && !this.drainInputFlushed) ||
        (this.stopPromise && !this.draining) || !pending || pending.caption || (pending.retryRequested && !userRequested) ||
        this.imageRetrying || this.stopping || !this.ready || this.socket?.readyState !== WS_OPEN) return
    const generation = this.generation
    // Recovered work is supplied inline in its own job, never replayed over a newer live preview.
    if (pending.mediaRef) {
      pending.retryRequested = false
      if (this.photoJob || this.invitationPending || this.toolBatch.started) {
        await this.persistJournal()
        this.publishPhotoRetry()
        return
      }
      this.invitationPending = true
      await this.persistJournal()
      if (generation !== this.generation || !this.pendingImages.includes(pending)) return
      this.publishPhotoRetry()
      this.resumeBackgroundWork()
      return
    }
    if (!userRequested) return
    this.imageRetrying = true
    this.publishFrameDelivery()
    try {
      const response = await this.request(`/integration/mentra/session/${this.sessionId}/snapshot/replay`, {
        user_id: this.config.userId, soul_id: this.config.soulId, image_id: pending.imageId,
      }, SNAPSHOT_TIMEOUT_MS).catch(() => null)
      if (generation !== this.generation || !this.pendingImages.includes(pending) || this.stopping) return
      if (!response?.ok) { await this.requestPhotoRetry(pending); return }
      const replay = await response.json().catch(() => null)
      if (generation !== this.generation || !this.pendingImages.includes(pending) || this.stopping) return
      const filing = this.filingCaption(replay?.filing)
      if (filing !== null) {
        this.acceptedCaptions.set(pending.imageId, filing)
        this.callbacks.onPhotoCaption?.({imageId: pending.imageId, caption: filing, durable: true}, false)
        this.removePendingImage(pending)
      } else {
        if (typeof replay?.media_ref !== "string" || !/^mentra_media\/[^/]+\/[^/]+$/.test(replay.media_ref) || replay.media_ref.includes("..")) {
          await this.requestPhotoRetry(pending)
          return
        }
        pending.mediaRef = replay.media_ref
        pending.retryRequested = false
        this.invitationPending = true
      }
      await this.persistJournal()
      this.publishPhotoRetry()
      this.clearPersistenceErrorIfSynced()
    } finally {
      this.imageRetrying = false
      this.resumeBackgroundWork()
    }
  }

  private enqueueImageMarker(pending: PendingImage): void {
    if (this.pendingImages.includes(pending) && pending.providerSent && !pending.imageRecorded) {
      pending.imageRecorded = true
      this.enqueueEvent("image", "user", "Shared a photo.", undefined, pending.mediaRef)
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
    this.visionStoppedAt ??= Date.now()
    this.outputMuted = true
    this.publishFrameDelivery()
    if (this.spokenRequest) this.spokenRequest.retired = true
  }

  private async performStop(graceful: boolean): Promise<void> {
    this.muteForStop()
    trace("provider.stop.begin", {graceful, turnActive: this.turnActive})
    try {
      this.flushToolResponses()
      const drainAttempted = graceful && Boolean(
        this.selectionDemand() || this.imageUpload || this.pendingImages.some(image => !image.retryRequested) ||
        this.photoJob || (this.toolBatch.started && (this.toolBatch.background || this.thinking)))
      const stoppedMidTurn = this.turnActive && (!this.toolBatch.invitation || this.turnAudioDelivered ||
        Boolean(this.spokenRequest && !this.spokenRequest.retired))
      if (drainAttempted) await this.drainPhoto()
      if (stoppedMidTurn || this.outputTranscript.trim()) {
        this.finalizeInterruptedTurn()
        this.interruptionFinalized = false
      }
      if (graceful && (!drainAttempted || !this.pendingImages.some(image => !image.retryRequested)) && !this.toolBatch.started &&
          !this.activityPauseReason && !stoppedMidTurn && this.ready && this.completeUserTurns >= 2) {
        trace("provider.reflection.begin")
        const reflection = await this.requestReflection()
        trace("provider.reflection.end", {persisted: Boolean(reflection && reflection !== "NO_SUMMARY")})
        if (reflection && reflection !== "NO_SUMMARY") {
          this.enqueueEvent("sitting_summary", "assistant", reflection)
        }
      }
      this.sealSpeechDrafts()
      this.stopping = true
      this.ready = false
      await this.awaitStopWork(this.appendTail)
      trace("provider.transcript_queue.drained")
      if (!this.persistenceFatal && !this.stopExpired()) await this.awaitStopWork(this.flushPendingEvents())
      // Explicit Retry may outlive Stop; its generation checks retain uncertain recovery.
      if (!this.imageFinalizationExplicit && !drainAttempted) {
        const admitted = (this.photoJob?.phase === "filing") ? this.photoJob.image : null
        if (admitted?.caption) await this.awaitStopWork(this.scheduleImageFinalize(false, admitted))
        else if (this.imageFinalization) await this.awaitStopWork(this.imageFinalization.promise)
      }
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
      // Candidates have not become memories. They cannot outlive their sitting's context.
      this.candidateFrames = []
      if (this.pendingImages.some(image => image.mediaRef === "")) {
        this.callbacks.onPhotoRetryChange(true)
        this.callbacks.onPersistenceError(PHOTO_UPLOAD_UNCONFIRMED_MESSAGE)
      }
      this.generation += 1
      this.stopping = true
      this.ready = false
      this.clearHeartbeat()
      this.clearDurationWarning()
      this.clearGoAway()
      this.clearStopDeadlineTimer()
      if (graceful) {
        this.resumptionHandle = ""
        this.resumptionUpdatedAt = 0
      }
      this.clearPhotoJob()
      const finalWrite = this.persistJournal()
      // Seal the immutable final snapshot and revoke this producer without an await gap.
      this.journalOwner?.retire(this.journalProducer)
      const socket = this.socket
      this.socket = null
      socket?.close()
      this.pendingToolCalls.clear()
      this.deliveredToolResultIds.clear()
      await this.awaitStopWork(finalWrite)
      await this.awaitStopWork(this.endLease())
      trace("provider.stop.end")
    }
  }

  private stopExpired(): boolean {
    return Date.now() >= (this.callbacks.getStopDeadline?.() ?? (this.visionStoppedAt! + this.photoDrainTimeoutMs))
  }

  private awaitStopWork<T>(work: Promise<T>): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>
      const finish = () => { clearTimeout(timer); this.stopWaiters.delete(refresh) }
      const refresh = () => {
        clearTimeout(timer)
        const deadline = this.callbacks.getStopDeadline?.() ?? (this.visionStoppedAt! + this.photoDrainTimeoutMs)
        if (Date.now() >= deadline) { finish(); resolve(undefined) }
        else timer = setTimeout(refresh, deadline - Date.now())
      }
      this.stopWaiters.add(refresh)
      refresh()
      work.then(value => { finish(); resolve(value) }, error => { finish(); reject(error) })
    })
  }

  private async drainPhoto(): Promise<void> {
    this.draining = true
    this.drainInputFlushed = false
    this.drainDeadlineAt = Date.now() + this.photoDrainTimeoutMs
    const completion = new Promise<void>(resolve => { this.drainResolve = resolve })
    this.refreshStopDeadline()
    const work = async () => {
      await this.imageUpload?.catch(() => {})
      if (!this.draining || this.stopping) return
      if (this.mode === "continuous" && this.audioFramesSent > 0) {
        const silence = btoa("\0".repeat(3200))
        for (let frame = 0; frame < 18;) {
          if (!this.draining) return
          if (this.ready && this.socket?.readyState === WS_OPEN) {
            this.sendAudioToSocket(this.socket, silence)
            frame += 1
          }
          await new Promise(resolve => setTimeout(resolve, 100))
        }
        while (this.draining && (!this.ready || this.socket?.readyState !== WS_OPEN)) {
          await new Promise(resolve => setTimeout(resolve, 100))
        }
        if (!this.draining || !this.socket) return
        this.socket.send(JSON.stringify({realtimeInput: {audioStreamEnd: true}}))
      }
      if (!this.draining) return
      this.drainInputFlushed = true
      await this.retryPendingImage()
      this.resumeBackgroundWork()
      if (this.pendingImage?.caption) {
        await this.scheduleImageFinalize()
      }
      this.finishPhotoDrainIfAcknowledged()
      await completion
    }
    try {
      await Promise.race([work(), completion])
    } catch (error) {
      this.reportError(error instanceof Error ? error : new Error(String(error)))
    } finally {
      this.clearStopDeadlineTimer()
      this.draining = false
      this.clearPhotoJob()
      this.drainResolve?.()
      this.drainResolve = null
      if (this.pendingImages.length) {
        console.error("[OpenAlma] Photo caption drain ended before durable handoff; retaining pending work")
        for (const image of this.pendingImages) await this.awaitStopWork(this.requestPhotoRetry(image))
      }
    }
  }

  private finishPhotoDrainIfAcknowledged(): void {
    if (!this.selectionDemand() && !this.pendingImages.some(image => !image.retryRequested) && !this.imageFinalization &&
        !this.toolBatch.started && !this.turnActive && !this.photoJob && !this.imageUpload &&
        ![...this.pendingToolCalls.values()].some(call => call.name === "save_photo_caption")) {
      this.drainResolve?.()
    }
  }

  private async requestStart(mode: SessionMode, recovery: TranscriptRecovery | null, generation: number, model?: LiveModel): Promise<StartResponse> {
    let response: Response
    let historyRetried = false
    for (;;) {
      if (this.stopping || generation !== this.generation) throw new Error("Gemini start cancelled")
      response = await this.request("/integration/mentra/session/start", {
        user_id: this.config.userId,
        soul_id: this.config.soulId,
        device_session_id: this.config.deviceSessionId,
        photo_work_protocol: PHOTO_WORK_PROTOCOL,
        mode,
        ...(model ? {model} : {}),
        ...(this.vision.callMode === "video" ? {vision: true} : {}),
        ...(recovery ? {recovery} : {}),
      })
      if (response.ok) break
      const errorBody = response.status === 409 ? await response.clone().json().catch(() => null) : null
      if (
        !historyRetried &&
        errorBody?.detail?.code === "mentra_history_changed"
      ) {
        historyRetried = true
        continue
      }
      if (recovery && (errorBody?.detail?.code === "mentra_recovery_conflict" || response.status === 422)) {
        await this.preserveRecovery(generation)
        recovery = null
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
    if (this.stopping || generation !== this.generation) {
      await this.endLease()
      throw new Error("Gemini start cancelled")
    }
    const ws = body.websocket
    if (
      body.photo_work_protocol !== PHOTO_WORK_PROTOCOL ||
      typeof body.model !== "string" || !body.model.trim() || (model !== undefined && body.model !== model) ||
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
    const expectedAck = recovery ? recovery.events[recovery.events.length - 1].sequence : 0
    if (recovery && (body.recovery?.sitting_id !== recovery.sitting_id ||
        body.recovery.ack_sequence !== expectedAck || Number(body.next_transcript_sequence) <= expectedAck)) {
      throw new Error("OpenAlma did not acknowledge recovered conversation; backup kept on this device")
    }
    if (!recovery) body.recovery = null
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
          if (this.reflecting) this.finishReflection()
          if (ready) this.reportError(normalized)
          else finish(normalized)
        }
      })
      socket.addEventListener("error", () => {
        if (this.stopping || this.socket !== socket) return
        const error = new Error(ready ? "Gemini socket failed" : "Gemini socket failed during setup")
        if (ready) {
          this.ready = false
          this.publishFrameDelivery()
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
      if (this.voiceActive) {
        this.quietOutput = null
        if (this.mode === "continuous") {
          const adoptingEarlyTranscript = this.pendingSpeechDraft()?.speech?.admitted === false && this.spokenRequest
          this.reserveSpeech()
          if (!adoptingEarlyTranscript) this.admitSpokenRequest()
        }
        this.turnActive = true
      } else {
        const speech = this.pendingSpeechDraft()
        if (speech) speech.speech!.ended = true
      }
    }
    const content = message.serverContent
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
    this.handlingMessage = true
    try {
      // Register the whole batch before a co-packet completion can settle it.
      const dispatch = hasToolCall ? this.handleToolCall(message.toolCall) : null
      if (message.toolCallCancellation !== undefined) this.handleToolCancellation(message.toolCallCancellation)
      if (message.serverContent !== undefined) this.handleServerContent(message.serverContent, hasToolCall)
      dispatch?.()
    } finally {
      this.handlingMessage = false
    }
    this.flushToolResponses()
    if (this.goAwayPending && !this.turnActive && !this.reflecting && !this.photoJob &&
        (!this.thinking || !this.toolBatch.started)) void this.rotateForGoAway()
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
    if (this.reflecting) return
    if (!this.resumptionHandle) {
      this.reportError(new Error("Gemini requested rollover without a resumable handle"))
      return
    }
    this.reconnecting = true
    this.voiceActive = false
    this.ready = false
    this.publishFrameDelivery()
    this.callbacks.onReconnecting(true)
    this.disconnectToolBatch()
    const generation = this.generation
    const sessionId = this.sessionId
    const oldSocket = this.socket
    try {
      if (this.turnActive || this.outputTranscript.trim()) {
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
      if (this.draining && !this.ready) this.drainResolve?.()
      this.resumeBackgroundWork()
    }
  }

  private handleServerContent(content: any, hasToolCall: boolean): void {
    if (!content || typeof content !== "object") throw new Error("Gemini returned malformed server content")
    const interrupted = content.interrupted === true
    const parts = content.modelTurn?.parts
    if (parts !== undefined && !Array.isArray(parts)) throw new Error("Gemini returned malformed model parts")
    const input = this.transcriptText(content.inputTranscription, "input")
    const output = this.transcriptText(content.outputTranscription, "output")
    if (input && !this.pendingSpeechDraft()) {
      const initialSpeech = !this.receivedSpeech
      this.reserveSpeech(this.turnMicSource, false)
      if (initialSpeech && !this.spokenRequest && !this.reflecting) this.admitSpokenRequest()
      const speech = this.pendingSpeechDraft()!
      if (!initialSpeech || this.reflecting) {
        speech.speech!.late = true
        speech.speech!.uncertain = true
      }
    }
    if (input) this.receivedSpeech = true
    if (content.modelTurn !== undefined || content.outputTranscription !== undefined ||
        (input && !this.pendingSpeechDraft()?.speech?.late)) this.turnActive = true
    if (!interrupted && (content.modelTurn !== undefined || content.outputTranscription !== undefined)) this.beginToolBatch()
    if (input) {
      const speech = this.pendingSpeechDraft()
      if (speech) {
        speech.content += input
        void this.persistJournal()
      }
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
      if ((!this.quietOutput || this.reflecting) && (!this.outputMuted || this.reflecting)) {
        this.callbacks.onAudio(inline.data)
        // Exact zero PCM is playback, but not spoken words requiring a transcript.
        if (!this.thinking || !/^A+={0,2}$/.test(inline.data)) {
          this.turnAudioDelivered = true
          if (this.toolBatch.request) this.toolBatch.request.audible = true
        }
      }
      this.providerAudioChunks += 1
    }

    if (this.reflecting) {
      this.outputTranscript += output
      if (interrupted) {
        trace("provider.reflection.interrupted")
        this.callbacks.onInterrupted()
        this.finishReflection()
      } else if (this.thinking ? content.interactionStatus === "IDLE"
        : content.generationComplete === true || content.turnComplete === true) {
        this.callbacks.onTurnComplete(true)
        this.finishReflection()
      }
      return
    }

    if ((!this.quietOutput || this.quietOutput.keepTranscript) && (!this.outputMuted || this.turnAudioDelivered)) this.outputTranscript += output
    if (interrupted) {
      if (!this.toolBatch.background && this.toolBatch.request) this.toolBatch.request.retired = true
      trace("provider.interrupted", {
        audioChunks: this.providerAudioChunks,
        inputChars: this.pendingSpeechDraft()?.content.length ?? 0,
        outputChars: this.outputTranscript.length,
      })
      this.finalizeInterruptedTurn(true)
      this.callbacks.onInterrupted()
      this.quietOutput = null
    }
    if (content.turnComplete === true || (this.thinking && content.interactionStatus === "IDLE")) {
      const interactionComplete = !this.thinking || content.interactionStatus === "IDLE"
      hasToolCall ||= this.turnHasToolCall
      this.hasCompletedProviderTurn = true
      trace("provider.turn_complete", {
        hasToolCall,
        interrupted: this.interruptionFinalized,
        ...(this.interruptionFinalized ? {} : {
          audioChunks: this.providerAudioChunks,
          inputChars: this.pendingSpeechDraft()?.content.length ?? 0,
          outputChars: this.outputTranscript.length,
        }),
      })
      this.providerAudioChunks = 0
      const interruptedTurn = this.interruptionFinalized
      if (interruptedTurn) {
        this.interruptionFinalized = false
      } else {
        this.finalizeCompleteTurn(interactionComplete)
      }
      this.turnActive = this.voiceActive
      this.turnHasToolCall = false
      const batch = this.toolBatch
      batch.completed = true
      const selectionJob = this.photoJob
      const request = batch.request
      if (!interruptedTurn && request && (this.mode === "manual" || !this.voiceActive)) {
        request.settled = true
        request.continuing = false
        if (interactionComplete && (request.audible || !this.hasUnconsumedTools(request))) request.retired = true
      }
      if (this.spokenRequest?.retired) this.spokenRequest = null
      this.toolBatch = {request: this.spokenRequest, completed: false, continuationSent: false,
        background: !this.spokenRequest,
        invitation: !interactionComplete && batch.invitation,
        started: !interactionComplete || (!this.thinking && !interruptedTurn && batch.photoContinuation === true),
        photo: !interruptedTurn && (interactionComplete
          ? !this.thinking && batch.photoContinuation === true && batch.photo === true
          : batch.photo === true || batch.photoContinuation === true)}
      if (selectionJob && "selection" in selectionJob && !selectionJob.selection.choices.size && !selectionJob.selection.readiness &&
          selectionJob.selection.completion === batch && batch === selectionJob.batch) {
        // A separately delivered completion of the readiness call precedes viewing.
        selectionJob.selection.completion = this.toolBatch
      }
      if (selectionJob && "selection" in selectionJob && interactionComplete) this.completeSelectionIfReady(selectionJob)
      this.reconnectAttempted = false
      if (this.latestUsageTotal !== null) this.callbacks.onUsage(this.latestUsageTotal)
      this.materializeDrafts()
      this.callbacks.onTurnComplete(interactionComplete && !this.spokenRequest)
      if (interactionComplete) this.requestSpokenPhotoDescription()
      if (this.quietOutput) {
        this.quietOutput.keepTranscript = false
        if (interactionComplete) this.quietOutput = null
      }
      // Barge-in completes the old response before the interrupting voice turn is finished.
      if (interactionComplete && (!interruptedTurn || (!this.voiceActive && (!this.spokenRequest || this.spokenRequest.retired) &&
          this.pendingImage && !this.pendingImage.providerSent && !this.pendingImage.retryRequested))) {
        void this.retryPendingImage()
      }
    }
  }

  private transcriptText(value: unknown, label: string): string {
    if (value === undefined) return ""
    if (!value || typeof value !== "object" || typeof (value as {text?: unknown}).text !== "string") {
      throw new Error(`Gemini returned malformed ${label} transcription`)
    }
    return (value as {text: string}).text
  }

  private finalizeCompleteTurn(settleInput = true): void {
    const output = this.turnAudioDelivered ? this.outputTranscript.trim() : ""
    const audible = this.turnAudioDelivered
    const closeUncertainGroup = this.spokenRequest !== null && !this.spokenRequest.retired &&
      this.toolBatch.request === this.spokenRequest && (!this.toolBatch.background || audible)
    this.clearTurn()
    try { this.recordAssistantOutput(output, audible, this.outputMuted) }
    finally { if (settleInput) this.settleSpeechDraft(true, closeUncertainGroup) }
    this.deliveredToolResultIds.clear()
    this.scheduleAppend()
  }

  private recordAssistantOutput(output: string, audible: boolean, interrupted: boolean): void {
    if (output) this.enqueueEvent("transcript", "assistant", output, interrupted ? "interrupted" : "complete")
    else if (audible && (!interrupted || this.outputMuted)) {
      this.enqueueEvent("transcript_gap", "assistant", "Transcript unavailable.")
      this.scheduleAppend()
      if (!this.outputMuted) throw new Error("Gemini completed audible speech without its transcription")
      console.error("[OpenAlma] Reply heard before Stop ended without its transcription")
      this.missingSpeech = true
      this.callbacks.onPersistenceError("Some spoken words could not be transcribed")
    }
  }

  private handleToolCall(value: unknown): () => void {
    if (this.stopping) throw new Error("Gemini requested memory during teardown")
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
        case "nothing_to_add":
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
    if (this.reflecting) return () => {
      this.socket!.send(JSON.stringify({toolResponse: {functionResponses: parsed.map(({id, name}) => {
        this.deliveredToolResultIds.add(id)
        return {id, name, ...(!this.thinking ? {scheduling: "SILENT"} : {}),
          response: {ok: false, status: "unavailable", message: "Tools are unavailable during Closing Thoughts."}}
      })}}))
    }
    this.beginToolBatch()
    const dispatch: Array<() => void> = []
    for (const {id, name, args} of parsed) {
      const pending: PendingToolCall = {
        name,
        generation: this.generation,
        sessionId: this.sessionId,
        batch: this.toolBatch,
        dispatched: false,
      }
      this.pendingToolCalls.set(id, pending)
      dispatch.push(() => {
        if (!this.isCurrentToolCall(id, pending)) return
        pending.dispatched = !invalid
        if (invalid) this.completeToolCall(id, pending, {
          ok: false, status: "invalid", message: "Invalid tool arguments; no calls in this batch were run.",
        }, false)
        else if (name === "recall_memory") void this.runRecall(id, args.query as string, pending)
        else if (name === "nothing_to_add") {
          if (!pending.batch.invitation) this.invitationPending = false
        }
        else if (name === "save_photo_caption") void this.runPhotoCaption(id, args, pending).catch(error => {
          if (this.isCurrentToolCall(id, pending)) this.reportError(error instanceof Error ? error : new Error(String(error)))
        })
        else void this.runWorkingTool(id, args, pending)
      })
    }
    return () => { for (const run of dispatch) run() }
  }

  private handleToolCancellation(value: unknown): void {
    if (!value || typeof value !== "object") throw new Error("Gemini returned malformed tool cancellation")
    const ids = (value as {ids?: unknown}).ids
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !id.trim())) {
      throw new Error("Gemini returned malformed tool cancellation")
    }
    for (const id of ids) {
      const pending = this.pendingToolCalls.get(id)
      if (pending && isUncertainWrite(pending)) {
        this.callbacks.onPersistenceError(WRITE_UNCERTAINTY_MESSAGE)
      }
      this.pendingToolCalls.delete(id)
      if (this.photoJob?.callId === id) this.resetImageDelivery()
    }
    const request = this.spokenRequest
    if (request?.settled && !request.continuing && !this.hasUnconsumedTools(request) &&
        (!this.thinking || !this.toolBatch.started)) {
      request.retired = true
      this.spokenRequest = null
      this.callbacks.onTurnComplete(true)
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
    pending.invites = true
    this.completeToolCall(id, pending, body.context.trim(), false)
    trace("recall.end", {id, elapsedMs: Date.now() - startedAt, contextLength: body.context.trim().length})
  }

  private async runPhotoCaption(id: string, args: Record<string, unknown>, call: PendingToolCall): Promise<void> {
    const imageId = args.image_id as string
    const caption = args.caption as string
    const job = this.photoJob
    if (job && "selection" in job && job.selection.frames.some(frame => frame.imageId === imageId)) {
      if (job.phase !== "dispatched") {
        this.completeToolCall(id, call, {ok: false, status: "invalid"}, false)
        return
      }
      const previous = job.selection.choices.get(imageId)
      if ((previous && previous.caption !== caption) || (!previous && job.selection.choices.size >= job.selection.maximum)) {
        this.completeToolCall(id, call, {ok: false, status: "conflict"}, false)
        return
      }
      call.batch.photoCaption = true
      let choice = previous
      if (!choice) {
        const frame = job.selection.frames.find(frame => frame.imageId === imageId)!
        this.chosenIds.add(imageId)
        const cacheKey = this.selectedCacheKey(imageId)
        const image: PendingImage = {imageId, mediaRef: "", caption, time: {...frame.time},
          captionEventId: `${this.sessionId}:photo:${imageId}`, providerSent: false, generation: this.generation,
          sessionId: this.sessionId, selected: {cacheKey, mimeType: frame.mimeType, rowEnqueued: false, uploadIssued: false}}
        // Reserve synchronously; use the existing upload lane, not a selection queue.
        const preceding = this.imageUpload
        const promotion = (async () => {
          if (!this.ownsJournal()) return
          await this.storage!.set(cacheKey, frame.data)
          if (!this.ownsJournal()) return
          this.pendingImages.push(image)
          if (!await this.persistJournal()) throw new Error("Selected photo metadata not saved")
          // All chosen originals become recoverable before waiting for the upload lane.
          await preceding?.catch(() => {})
          if (!this.ownsImage(image)) return
          this.callbacks.onPhotoCaption?.({imageId, caption, durable: false}, false)
          await this.promoteSelected(image)
        })().catch(async error => {
          job.selection.failed = true
          if (this.ownsJournal()) {
            if (this.pendingImages.includes(image)) await this.requestPhotoRetry(image)
            else {
              this.chosenIds.delete(imageId)
              this.callbacks.onPersistenceError(`Photo selection failed: ${String(error)}`)
            }
          }
        }).finally(async () => {
          // A failed later preparation must not release an earlier upload's lane.
          await preceding?.catch(() => {})
          if (this.imageUpload === promotion) this.imageUpload = null
          this.resumeBackgroundWork()
        })
        this.imageUpload = promotion
        choice = {caption, promise: promotion.then(() => this.acceptedCaptions.get(imageId) === caption)}
        job.selection.choices.set(imageId, choice)
      }
      const durable = await choice.promise
      if (!durable) job.selection.failed = true
      call.scheduling = durable ? "WHEN_IDLE" : "SILENT"
      this.completeToolCall(id, call, {ok: durable, durable}, false)
      return
    }
    let accepted = this.acceptedCaptions.get(imageId)
    if (accepted === undefined && this.offeredIds.has(imageId) && !this.pendingImages.some(image => image.imageId === imageId)) {
      this.completeToolCall(id, call, {ok: false, status: "invalid"}, false)
      return
    }
    if (accepted === undefined && !this.pendingImages.some(image => image.imageId === imageId)) {
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
      call.scheduling = accepted === caption ? "WHEN_IDLE" : "SILENT"
      this.completeToolCall(id, call, {ok: accepted === caption, durable: accepted === caption,
        ...(accepted === caption ? {} : {status: "conflict"})}, false)
      return
    }
    const image = this.pendingImages.find(image => image.imageId === imageId)
    if (!image?.mediaRef || image.imageId !== imageId || (!image.captionRequested && !image.caption) ||
        (image.caption !== undefined && image.caption !== caption)) {
      this.completeToolCall(id, call, {ok: false, status: "invalid", message: "Photo does not match the pending original."}, false)
      return
    }
    if (image.retryRequested && image.caption) {
      this.completeToolCall(id, call, {ok: false, status: "failed", message: PHOTO_RETRY_MESSAGE}, false)
      return
    }
    call.batch.photoCaption = true
    if (!image.caption) {
      image.caption = caption
      image.captionEventId ??= `${image.sessionId}:photo:${image.imageId}`
      image.retryRequested = false
      if (this.photoJob?.image === image) {
        const job = this.photoJob
        const readiness = this.pendingToolCalls.get(job.callId)
        if (readiness) {
          readiness.parts = undefined
          readiness.response = {ok: true}
          readiness.scheduling = "SILENT"
        }
        if (job.retryReserved && job.phase !== "dispatched") image.retryUsed = false
        this.photoJob.phase = "filing"
        if (this.photoTimer) clearTimeout(this.photoTimer)
        this.photoTimer = null
      }
      this.callbacks.onPhotoCaption?.({imageId, caption, durable: false}, false)
      this.enqueueEvent("photo_caption", "assistant", caption, undefined, image.mediaRef)
      await this.persistJournal()
      this.publishPhotoRetry()
    }
    this.scheduleAppend()
    await this.scheduleImageFinalize(false, image)
    const durable = this.acceptedCaptions.get(imageId) === caption
    if (this.photoJob?.image === image) this.clearPhotoJob()
    call.scheduling = durable ? "WHEN_IDLE" : "SILENT"
    if (!this.isCurrentToolCall(id, call) || (!durable && this.pendingImages.some(image => !image.retryRequested && !image.caption))) this.invitationPending = true
    this.completeToolCall(id, call, {ok: durable, durable}, false)
    this.flushToolResponses()
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
      this.ownsJournal() &&
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

  private answerNoWork(call: PendingToolCall, failed = false): void {
    call.quietChoice = this.thinking && !failed && call.quietChoice !== false
    call.response = failed ? {ok: false, status: "failed"} : call.quietChoice
      ? "No photo task is ready. Say 'Done' once to finish this private exchange."
      : {ok: true}
  }

  private flushToolResponses(): void {
    if (this.handlingMessage) return
    this.dispatchPhotoWork()
    for (const [id, pending] of this.pendingToolCalls) {
      if (!pending.response) continue
      if (!this.isCurrentToolCall(id, pending)) {
        this.pendingToolCalls.delete(id)
        continue
      }
      if (!this.ready || !this.socket || this.socket.readyState !== WS_OPEN) continue
      if (pending.scheduling === "WHEN_IDLE" && this.draining && Date.now() >= this.drainDeadlineAt) {
        this.refreshStopDeadline()
        continue
      }
      if (pending.scheduling === "WHEN_IDLE" && this.outputMuted && (!this.draining || !this.drainInputFlushed)) continue
      if (pending.parts && this.photoJob?.image && this.photoJob.callId === id && this.settledPreviewRevision !== this.previewRevision) {
        const job = this.photoJob
        this.settlePhotoReadiness(id, pending, job.image, job.retryPending)
      }
      const request = pending.batch.request
      const needsAnswer = pending.name !== "nothing_to_add" && request && !request.retired && !request.audible && !this.outputMuted
      if (pending.scheduling === "WHEN_IDLE" && !this.draining && !needsAnswer &&
          (!this.thinking || pending.parts) && this.callbacks.canInvite?.() === false) continue
      if (pending.parts && !this.draining && (this.voiceActive || this.turnActive || (this.spokenRequest && !this.spokenRequest.retired))) continue
      if (needsAnswer && !this.thinking && (!request.settled || [...this.pendingToolCalls.values()].some(call =>
        call.name !== "nothing_to_add" && call.batch.request === request && !call.batch.continuationSent &&
        (call.response === undefined || !call.batch.completed)))) continue
      const resume = needsAnswer && !pending.batch.continuationSent && !request.continuing &&
        ![...this.pendingToolCalls.values()].some(call => call !== pending &&
          call.name !== "nothing_to_add" && call.batch.request === request && !call.batch.continuationSent)
      if (this.thinking && pending.invites) {
        this.quietOutput = null
        // A memory supersedes quiet choices already waiting to be answered.
        for (const call of this.pendingToolCalls.values()) {
          if (call.name !== "nothing_to_add") continue
          if (call.quietChoice) call.response = {ok: true}
          call.quietChoice = false
        }
      }
      if (this.thinking && pending.quietChoice) {
        this.quietOutput ??= {keepTranscript: this.turnAudioDelivered}
      }
      this.socket.send(JSON.stringify({
        toolResponse: {
          functionResponses: [{
            id,
            name: pending.name,
            response: typeof pending.response === "string" ? {result: pending.response} : pending.response,
            ...(!this.thinking ? {scheduling: pending.scheduling ?? (resume ? "WHEN_IDLE" : "SILENT")} : {}),
            ...(pending.parts ? {parts: pending.parts} : {}),
          }],
        },
      }))
      if (pending.scheduling === "WHEN_IDLE" && this.photoJob?.callId === id) {
        const job = this.photoJob
        if (pending.parts) {
          job.phase = "dispatched"
          if (job.image) job.image.captionRequested = true
          else {
            for (const frame of job.selection.frames) this.offeredIds.add(frame.imageId)
            job.selection.completion = pending.batch.completed ? this.toolBatch : pending.batch
            job.selection.excludedReadiness = new Set(this.pendingToolCalls.keys())
          }
          void this.persistJournal()
        }
        if (this.photoTimer) clearTimeout(this.photoTimer)
        const expire = () => {
          if (this.photoJob !== job || job.phase === "filing") return
          // Filing latency is not a model timeout; Stop retains its own deadline.
          if ("selection" in job && this.imageUpload) {
            this.photoTimer = setTimeout(expire, TOOL_TIMEOUT_MS)
            return
          }
          // Iris holds readiness during human speech/playback; that is not a model timeout.
          const heldReadiness = [...this.pendingToolCalls.values()].some(call => call.name === "nothing_to_add")
          if (!this.draining && (this.voiceActive || (heldReadiness && this.callbacks.canInvite?.() === false) ||
              (this.spokenRequest && !this.spokenRequest.retired))) {
            this.photoTimer = setTimeout(expire, TOOL_TIMEOUT_MS)
            return
          }
          const stalledBatch = this.toolBatch
          if ("selection" in job) { job.selection.failed = true; this.finishSelection(job) }
          else this.clearPhotoJob()
          void (job.image ? this.requestPhotoRetry(job.image) : Promise.resolve()).then(() => {
            if (this.pendingImages.some(image => !image.retryRequested && !image.caption)) this.invitationPending = true
            // A missing native completion cannot be invented; recover through the existing socket lifecycle.
            if (!this.draining && this.toolBatch === stalledBatch && !this.photoJob &&
                (this.toolBatch.started || this.turnActive) && !this.voiceActive &&
                (!this.spokenRequest || this.spokenRequest.retired)) {
              this.ready = false
              stalledBatch.photo = false
              this.socket?.close()
            }
            this.resumeBackgroundWork()
          })
        }
        this.photoTimer = setTimeout(expire, TOOL_TIMEOUT_MS)
      }
      if (pending.scheduling === "WHEN_IDLE") {
        const photo = pending.name === "save_photo_caption" || this.photoJob?.callId === id
        if (photo) pending.batch.photo = true
        if (pending.batch.completed) {
          this.toolBatch.started = true
          if (photo) this.toolBatch.photo = true
        }
        else pending.batch.photoContinuation = true
      }
      if (resume) {
        request.continuing = true
        pending.batch.continuationSent = true
      }
      if (pending.invites && !resume) this.invitationPending = true
      this.deliveredToolResultIds.add(id)
      this.pendingToolCalls.delete(id)
    }
    this.finishPhotoDrainIfAcknowledged()
    this.sendInvitation()
    this.publishFrameDelivery()
  }

  private hasUnconsumedTools(request: SpokenRequest): boolean {
    return [...this.pendingToolCalls.values()].some(call =>
      call.name !== "nothing_to_add" && call.batch.request === request && !call.batch.continuationSent)
  }

  private beginToolBatch(): void {
    if (!this.toolBatch.started && this.spokenRequest && !this.spokenRequest.retired &&
        this.toolBatch.request?.retired) {
      this.toolBatch.request = this.spokenRequest
      this.toolBatch.background = false
    }
    this.toolBatch.started = true
  }

  private admitSpokenRequest(): void {
    this.quietOutput = null
    const job = this.photoJob
    if (job && "selection" in job && job.phase !== "dispatched") {
      const call = this.pendingToolCalls.get(job.callId)
      if (call) { call.parts = undefined; call.response = {ok: true}; call.scheduling = "SILENT" }
      job.batch.photo = false
      this.toolBatch.photo = false
      this.clearPhotoJob()
      this.publishFrameDelivery()
    }
    if (this.spokenRequest) this.spokenRequest.retired = true
    const request: SpokenRequest = {settled: false, audible: false, retired: false, continuing: false}
    this.spokenRequest = request
    // An unresolved background batch may overlap new speech. Completed old work
    // cannot acquire ownership of a later request.
    if (!this.toolBatch.started && (!this.toolBatch.request ||
        (this.toolBatch.request.settled && !this.toolBatch.request.continuing))) {
      this.toolBatch = {request, completed: false, continuationSent: false, background: false,
        started: false, photo: this.toolBatch.photo}
    } else if (!this.toolBatch.request && !this.toolBatch.completed) {
      this.toolBatch.request = request
    }
  }

  private disconnectToolBatch(): void {
    this.quietOutput = null
    for (const [id, call] of this.pendingToolCalls) {
      if (call.name === "nothing_to_add") this.pendingToolCalls.delete(id)
    }
    // A dropped socket is not proof of native completion. Preserve settled
    // obligations, but do not manufacture a wake for unfinished provider work.
    if (this.spokenRequest && (!this.spokenRequest.settled || this.spokenRequest.continuing ||
        (this.thinking && this.toolBatch.started))) {
      this.spokenRequest.retired = true
      this.spokenRequest = null
      if (this.mode === "manual") this.callbacks.onTurnComplete(true)
    }
    this.toolBatch = {request: this.spokenRequest, completed: false, continuationSent: false,
      background: !this.spokenRequest, started: false, photo: this.toolBatch.photo}
  }

  private finalizeInterruptedTurn(userComplete = false): void {
    if (this.photoJob && "selection" in this.photoJob) {
      this.photoJob.selection.failed = true
      this.finishSelection(this.photoJob)
    }
    const image = this.photoJob?.image
    const output = this.turnAudioDelivered ? this.outputTranscript.trim() : ""
    const audible = this.turnAudioDelivered
    this.clearTurn()
    try { this.recordAssistantOutput(output, audible, true) }
    finally { this.settleSpeechDraft(userComplete) }
    this.interruptionFinalized = true
    if ((!this.stopPromise || (this.draining && userComplete)) && image && !image.caption) {
      this.resetImageDelivery()
    }
    this.scheduleAppend()
  }

  private clearTurn(): void {
    this.outputTranscript = ""
    this.turnMicSource = undefined
    this.turnAudioDelivered = false
  }

  private pendingSpeechDraft(): TranscriptDraft | undefined {
    return this.draftEvents.find(event => event.speech?.waiting)
  }

  private reserveSpeech(micSource = this.turnMicSource, admitted = true): void {
    if (admitted) this.receivedSpeech = true
    const existing = this.pendingSpeechDraft()
    if (existing) {
      if (existing.speech!.admitted) existing.speech!.uncertain = true
      existing.speech!.admitted ||= admitted
      existing.speech!.ended = false
      if (existing.mic_source !== micSource) delete existing.mic_source
    } else {
      this.draftEvents.push({event_kind: "transcript", role: "user", content: "", status: "complete",
        ...(micSource ? {mic_source: micSource} : {}),
        speech: {waiting: true, late: false, uncertain: false, ended: false, admitted}})
    }
    void this.persistJournal()
  }

  private settleSpeechDraft(userComplete = true, closeUncertainGroup = false): void {
    const speech = this.pendingSpeechDraft()
    if (!speech) return
    // A current response bounds the group, without claiming an ASR final marker.
    const capturing = this.mode === "continuous" && this.voiceActive
    speech.speech!.late ||= !speech.content.trim() || capturing
    if (speech.content.trim() && !capturing &&
        (closeUncertainGroup || (!speech.speech!.late && !speech.speech!.uncertain))) {
      speech.content = speech.content.trim()
      speech.status = userComplete ? "complete" : "interrupted"
      speech.speech!.waiting = false
      this.materializeDrafts()
      if (userComplete) this.completeUserTurns += 1
    }
    void this.persistJournal()
  }

  private sealSpeechDrafts(): void {
    const speech = this.pendingSpeechDraft()
    if (speech) {
      speech.content = speech.content.trim()
      speech.speech!.waiting = false
      if (speech.speech!.admitted && !speech.speech!.ended) speech.status = "interrupted"
      if (!speech.content) {
        if (!speech.speech!.admitted) this.draftEvents.splice(this.draftEvents.indexOf(speech), 1)
        else {
          speech.event_kind = "transcript_gap"
          speech.content = "Transcript unavailable."
          delete speech.status
          delete speech.mic_source
          this.missingSpeech = true
          console.error("[OpenAlma] Sitting ended before admitted speech was transcribed")
          this.callbacks.onPersistenceError("Some spoken words could not be transcribed")
        }
      }
    }
    this.materializeDrafts()
  }

  private materializeDrafts(): void {
    while (this.draftEvents.length && !this.draftEvents[0].speech?.waiting) {
      // Keep a whole foreground exchange before photos shared during it, without delaying provider delivery or filing.
      if (!this.stopPromise && (this.voiceActive || (this.spokenRequest && !this.spokenRequest.retired)) &&
          ["image", "photo_caption"].includes(this.draftEvents[0].event_kind)) break
      const draft = this.draftEvents.shift()!
      const content = (draft.speech?.uncertain && draft.event_kind === "transcript" && draft.content ? UNCERTAIN_SPEECH_PREFIX : "") + draft.content
      const characters = Array.from(content)
      for (let offset = 0; offset < characters.length; offset += TRANSCRIPT_CONTENT_LIMIT) {
        const sequence = this.nextTranscriptSequence++
        this.pendingEvents.push({
          event_id: `${this.sessionId}:${sequence}`, sequence,
          event_kind: draft.event_kind, role: draft.role,
          content: characters.slice(offset, offset + TRANSCRIPT_CONTENT_LIMIT).join(""),
          ...(draft.status ? {status: draft.status} : {}),
          ...(draft.media_ref ? {media_ref: draft.media_ref} : {}),
          ...(draft.mic_source ? {mic_source: draft.mic_source} : {}),
        })
      }
    }
  }

  private enqueueEvent(
    eventKind: TranscriptEvent["event_kind"],
    role: TranscriptEvent["role"],
    content: string,
    status?: TranscriptEvent["status"],
    mediaRef?: string,
    micSource?: MicSource,
  ): void {
    const draft: TranscriptDraft = {event_kind: eventKind, role, content,
      ...(status ? {status} : {}), ...(mediaRef ? {media_ref: mediaRef} : {}),
      ...(micSource ? {mic_source: micSource} : {})}
    const photo = eventKind === "transcript" || eventKind === "transcript_gap"
      ? this.draftEvents.findIndex(event => event.event_kind === "image" || event.event_kind === "photo_caption") : -1
    this.draftEvents.splice(photo < 0 ? this.draftEvents.length : photo, 0, draft)
    this.materializeDrafts()
    void this.persistJournal()
  }

  private scheduleAppend(): void {
    this.appendTail = this.appendTail.then(() => this.flushPendingEvents()).catch((error) => {
      if (!this.ownsJournal()) return
      this.persistenceFatal = true
      this.reportError(error instanceof Error ? error : new Error(String(error)))
    })
  }

  private async flushPendingEvents(): Promise<void> {
    if (!this.journalLoaded || this.ended || !this.ownsJournal()) return
    while (this.pendingEvents.length && !this.persistenceFatal) {
      const batch = this.pendingEvents.slice(0, 16)
      await this.persistJournal()
      if (!this.ownsJournal()) return
      let response: Response
      try {
        response = await this.request(`/integration/mentra/session/${this.sessionId}/transcripts/append`, {
          user_id: this.config.userId,
          soul_id: this.config.soulId,
          events: batch,
        })
      } catch {
        if (!this.ownsJournal()) return
        this.callbacks.onPersistenceError("Transcript sync failed; retrying")
        return
      }
      if (!this.ownsJournal()) return
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
      if (!this.ownsJournal()) return
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
    if (!this.ownsJournal()) return
    if (!this.pendingEvents.length && !this.missingSpeech && !this.journalUnavailable &&
        !this.pendingImages.some(image => image.retryRequested)) this.callbacks.onPersistenceError(null)
  }

  private async requestPhotoRetry(pending: PendingImage): Promise<void> {
    if (!this.ownsImage(pending)) return
    pending.retryRequested = true
    this.callbacks.onPhotoRetryChange(true)
    this.callbacks.onPersistenceError(pending.mediaRef ? PHOTO_RETRY_MESSAGE : PHOTO_UPLOAD_UNCONFIRMED_MESSAGE)
    await this.persistJournal()
    if (this.pendingImage !== pending) void this.retryPendingImage()
  }

  private ownsJournal(): boolean { return this.journalOwner?.active(this.journalProducer) ?? !this.ended }

  private ownsImage(image: PendingImage): boolean {
    return this.ownsJournal() && this.pendingImages.includes(image)
  }

  private selectedCacheKey(imageId: string): string {
    return `openalma:chosen-original:${[this.config.userId, this.config.soulId, this.config.deviceSessionId, imageId]
      .map(encodeURIComponent).join(":")}`
  }

  private async deleteCachedOriginal(image: PendingImage): Promise<void> {
    try {
      if (!this.storage?.delete) throw new Error("Local cache deletion unavailable")
      await this.storage.delete(image.selected!.cacheKey)
    }
    catch { if (this.ownsJournal()) this.callbacks.onPersistenceError("Photo saved; temporary original cleanup failed") }
  }

  private async promoteSelected(image: PendingImage): Promise<void> {
    if (!image.selected || !this.ownsImage(image)) return
    image.retryRequested = false
    if (!await this.persistJournal()) { if (this.ownsImage(image)) await this.requestPhotoRetry(image); return }
    if (!this.ownsImage(image)) return
    // Recommit the latest logical transition even when a previous mediaRef write failed.
    if (!image.mediaRef) {
      let data: string | null = null
      try { data = await readStoredValue(this.storage!, image.selected.cacheKey) } catch { /* Replay can recover a lost upload reply. */ }
      if (!this.ownsImage(image)) return
      image.selected.uploadIssued = true
      let response: Response
      try {
        response = await this.request(`/integration/mentra/session/${this.sessionId}/snapshot${data ? "" : "/replay"}`, {
          user_id: this.config.userId, soul_id: this.config.soulId, image_id: image.imageId,
          ...(data ? {mime_type: image.selected.mimeType, data} : {}),
        }, SNAPSHOT_TIMEOUT_MS)
        if (!this.ownsImage(image)) return
        if (!response.ok) throw new Error(`Selected original upload failed (${response.status})`)
        const result = await response.json()
        if (!this.ownsImage(image)) return
        if (typeof result.media_ref !== "string" || !/^mentra_media\/[^/]+\/[^/]+$/.test(result.media_ref) ||
            result.media_ref.includes("..")) throw new Error("Invalid selected original media reference")
        image.mediaRef = result.media_ref
      } catch {
        if (this.ownsImage(image)) await this.requestPhotoRetry(image)
        return
      }
    }
    if (!this.ownsImage(image)) return
    const mediaRef = image.mediaRef
    if (!image.selected.rowEnqueued && image.captionEventId === `${this.sessionId}:photo:${image.imageId}`) {
      image.selected.rowEnqueued = true
      // enqueueEvent persists; set all logical fields before publishing that snapshot.
      this.enqueueEvent("photo_caption", "assistant", image.caption!, undefined, mediaRef)
    }
    const saved = await this.persistJournal()
    if (!this.ownsImage(image) || image.mediaRef !== mediaRef) return
    if (!saved) { await this.requestPhotoRetry(image); return }
    this.selectedMediaCommitted.add(image)
    await this.deleteCachedOriginal(image)
    if (!this.ownsImage(image)) return
    this.scheduleAppend()
    await this.scheduleImageFinalize(true, image)
  }

  private startSelectedPromotion(image: PendingImage): Promise<void> {
    const promotion = this.promoteSelected(image).finally(() => {
      if (this.imageUpload === promotion) {
        this.imageUpload = null
        void this.scheduleImageFinalize()
        this.resumeBackgroundWork()
      }
    })
    this.imageUpload = promotion
    this.publishFrameDelivery()
    return promotion
  }

  private scheduleImageFinalize(userRequested = false, pending = this.pendingImages.find(image => image.caption && image.mediaRef && !image.retryRequested)): Promise<void> {
    const admitted = pending && this.photoJob?.image === pending && (this.photoJob.phase === "filing")
    // Outside graceful drain, Stop can finish its verified caption but not start the next image.
    if ((this.stopping || (this.stopPromise && !this.draining)) && !admitted) return Promise.resolve()
    if (!pending?.caption || !pending.mediaRef || !this.pendingImages.includes(pending) || (pending.retryRequested && !userRequested) || !pending.captionEventId) return Promise.resolve()
    if (pending.selected && !this.selectedMediaCommitted.has(pending)) {
      return this.imageUpload ? Promise.resolve() : this.startSelectedPromotion(pending)
    }
    if (this.imageFinalization) return this.imageFinalization.image === pending
      ? this.imageFinalization.promise
      : this.imageFinalization.promise.then(() => this.scheduleImageFinalize(userRequested, pending))
    this.imageFinalizationExplicit = userRequested
    const finalization = this.finalizePendingImage(pending).finally(() => {
      if (this.imageFinalization?.promise === finalization) {
        this.imageFinalization = null
        this.imageFinalizationExplicit = false
        void this.scheduleImageFinalize()
        void this.retryPendingImage()
        this.finishPhotoDrainIfAcknowledged()
        this.resumeBackgroundWork()
      }
    })
    this.imageFinalization = {image: pending, promise: finalization}
    this.publishFrameDelivery()
    return finalization
  }

  private async finalizePendingImage(pending: PendingImage): Promise<void> {
    const generation = this.generation
    if (this.photoJob?.image !== pending) {
      this.callbacks.onPhotoCaption?.({imageId: pending.imageId, caption: pending.caption!, durable: false}, false)
    }
    await this.persistJournal()
    if ((this.stopping && !(this.photoJob?.image === pending && (this.photoJob.phase === "filing"))) ||
        generation !== this.generation || !this.pendingImages.includes(pending)) return
    let response: Response
    try {
      response = await this.request(`/integration/mentra/session/${this.sessionId}/snapshot/finalize`, {
        user_id: this.config.userId,
        soul_id: this.config.soulId,
        image_id: pending.imageId,
        caption: pending.caption,
        caption_event_id: pending.captionEventId,
        ...(pending.time ? {time: pending.time} : {}),
      })
    } catch {
      if (generation !== this.generation || !this.pendingImages.includes(pending)) return
      await this.requestPhotoRetry(pending)
      return
    }
    if (generation !== this.generation || !this.pendingImages.includes(pending)) return
    if (!response.ok) {
      await this.requestPhotoRetry(pending)
      return
    }
    const result = await response.json().catch(() => null) as {ok?: boolean; durable?: boolean} | null
    if (generation !== this.generation || !this.pendingImages.includes(pending)) return
    if (result?.ok !== true) {
      await this.requestPhotoRetry(pending)
      return
    }
    if (result.durable !== true) {
      await this.requestPhotoRetry(pending)
      return
    }
    this.acceptedCaptions.set(pending.imageId, pending.caption!)
    this.callbacks.onPhotoCaption?.({imageId: pending.imageId, caption: pending.caption!, durable: true}, true)
    if (pending.speakDescription) this.spokenPhotos.push(pending.imageId)
    this.removePendingImage(pending)
    await this.persistJournal()
    this.publishPhotoRetry()
    this.clearPersistenceErrorIfSynced()
    if (![...this.pendingToolCalls.values()].some(call => call.name === "save_photo_caption")) this.requestSpokenPhotoDescription()
    this.finishPhotoDrainIfAcknowledged()
  }

  private requestSpokenPhotoDescription(): void {
    if (!this.spokenPhotos.length || this.turnActive || this.toolBatch.started || this.stopPromise || this.stopping || this.reflecting ||
        this.callbacks.canInvite?.() === false || this.voiceActive ||
        this.photoJob || this.imageUpload || this.imageFinalization || this.pendingImages.some(image => !image.retryRequested) ||
        (this.spokenRequest && !this.spokenRequest.retired) ||
        !this.ready || this.socket?.readyState !== WS_OPEN) return
    const imageId = this.spokenPhotos.shift()!
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
    const selected = await this.journalOwner!.read()
    if (this.stopping || generation !== this.generation) throw new Error("Gemini start cancelled")
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
    // Photos are independently recoverable even when numbered dialogue is rejected.
    if (journal && [1, 2, 3].includes(journal.version!) && scope?.userId === this.config.userId &&
        scope.soulId === this.config.soulId && scope.deviceSessionId === this.config.deviceSessionId) {
      const photos = journal.version === 3 ? journal.pendingImages : journal.pendingImage ? [journal.pendingImage] : []
      if (Array.isArray(photos)) {
        this.pendingImages = photos.filter((image): image is PendingImage => !!image && this.validPendingImage(image) &&
          photos.filter(other => other?.imageId === image.imageId).length === 1).map(image => ({...image}))
        for (const image of this.pendingImages) image.retryRequested = true
      }
    }
    if (
      !journal ||
      (journal.version !== 1 && journal.version !== 2 && journal.version !== 3) ||
      scope?.userId !== this.config.userId ||
      scope.soulId !== this.config.soulId ||
      scope.deviceSessionId !== this.config.deviceSessionId ||
      !this.validPendingEvents(journal.pendingTranscripts) ||
      !this.validDraftEvents(journal.draftTranscripts) ||
      (Boolean(journal.draftTranscripts?.length) &&
        (!Number.isSafeInteger(journal.nextTranscriptSequence) || Number(journal.nextTranscriptSequence) < 1)) ||
      !(journal.version === 3
        ? Array.isArray(journal.pendingImages) && journal.pendingImages.every(image => image && this.validPendingImage(image)) &&
          new Set(journal.pendingImages.map(image => image.imageId)).size === journal.pendingImages.length
        : this.validPendingImage(journal.pendingImage))
    ) {
      await this.preserveJournal(raw, generation)
      this.journalLoaded = true
      await this.persistBackup()
      this.publishPhotoRetry()
      this.callbacks.onPersistenceError("Original conversation backup kept on this device")
      return
    }
    this.pendingEvents = journal.pendingTranscripts.map((event) => ({...event}))
    this.draftEvents = journal.draftTranscripts ?? []
    this.pendingImages = (journal.version === 3 ? journal.pendingImages! : journal.pendingImage ? [journal.pendingImage] : [])
      .map(image => {
        const normalized = {...image, captionRequested: image.captionRequested ?? Boolean(image.providerSent || image.imageRecorded)} as
          PendingImage & {imageBaseline?: unknown; captureAfterCurrent?: unknown}
        delete normalized.imageBaseline
        delete normalized.captureAfterCurrent
        return normalized
      })
    for (const image of this.pendingImages) {
      if (image.selected && !image.mediaRef) image.retryRequested = true
      if (image.imageRecorded === undefined && image.imageSequence !== undefined) image.imageRecorded = true
      if (!image.captionEventId && image.assistantSequence !== undefined) image.captionEventId = `${image.sessionId}:${image.assistantSequence}`
    }
    const parked = this.pendingImages.find(image => image.retryRequested && !image.mediaRef) ??
      this.pendingImages.find(image => image.retryRequested)
    if (parked) {
      this.callbacks.onPhotoRetryChange(true)
      this.callbacks.onPersistenceError(parked.mediaRef ? PHOTO_RETRY_MESSAGE : PHOTO_UPLOAD_UNCONFIRMED_MESSAGE)
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

  private validDraftEvents(value: unknown): value is TranscriptDraft[] | undefined {
    if (value === undefined) return true
    if (!Array.isArray(value) || value.filter(draft => draft?.speech?.waiting).length > 1) return false
    return value.every(draft => {
      if (!draft || typeof draft !== "object" || typeof draft.content !== "string") return false
      if (Object.keys(draft).some(key => !["event_kind", "role", "content", "status", "media_ref", "mic_source", "speech"].includes(key))) return false
      const speech = draft.speech
      if (speech !== undefined && (!speech || typeof speech !== "object" || draft.role !== "user" || draft.event_kind !== "transcript" ||
          Object.keys(speech).length !== 5 || ["waiting", "late", "uncertain", "ended", "admitted"].some(key => typeof speech[key] !== "boolean"))) return false
      if (!draft.content && !speech?.waiting) return false
      const {speech: _speech, ...event} = draft
      return this.validPendingEvents([{...event, event_id: "draft", sequence: 1,
        content: Array.from(draft.content || " ").slice(0, TRANSCRIPT_CONTENT_LIMIT).join("")}])
    })
  }

  private validPendingImage(value: unknown): value is PendingImage | null | undefined {
    if (value === undefined || value === null) return true
    if (!value || typeof value !== "object") return false
    const image = value as Partial<PendingImage>
    const selected = image.selected
    if (selected !== undefined && (!selected || typeof selected !== "object" ||
        selected.cacheKey !== this.selectedCacheKey(String(image.imageId)) || selected.mimeType !== "image/jpeg" ||
        typeof selected.rowEnqueued !== "boolean" || typeof selected.uploadIssued !== "boolean" ||
        typeof image.caption !== "string" || !image.caption.trim() || Array.from(image.caption).length > TRANSCRIPT_CONTENT_LIMIT ||
        image.captionEventId !== `${image.sessionId}:photo:${image.imageId}` ||
        !image.time || image.time.source !== "receipt" || !Number.isFinite(image.time.receivedAt) ||
        typeof image.time.timestamp !== "string" || image.time.timestamp !== formatImageTimestamp(image.time.timestamp))) return false
    const parts = typeof image.mediaRef === "string" ? image.mediaRef.split("/") : []
    return typeof image.imageId === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(image.imageId) &&
      ((image.mediaRef === "" && image.providerSent === false && image.imageSequence === undefined &&
        (image.caption === undefined || (selected !== undefined && selected.rowEnqueued === false)) && image.assistantSequence === undefined) ||
        (parts.length === 3 && parts[0] === "mentra_media" && !parts.includes(".."))) &&
      typeof image.providerSent === "boolean" &&
      Number.isSafeInteger(image.generation) && typeof image.sessionId === "string" &&
      (image.imageSequence === undefined || (Number.isSafeInteger(image.imageSequence) && image.imageSequence > 0)) &&
      (image.caption === undefined || (typeof image.caption === "string" && image.caption.length > 0)) &&
      (image.assistantSequence === undefined || (Number.isSafeInteger(image.assistantSequence) && image.assistantSequence > 0)) &&
      (image.imageRecorded === undefined || typeof image.imageRecorded === "boolean") &&
      (image.captionEventId === undefined || (typeof image.captionEventId === "string" &&
        !!image.captionEventId.trim() && image.captionEventId.length <= 256)) &&
      (image.retryRequested === undefined || typeof image.retryRequested === "boolean") &&
      (image.retryUsed === undefined || typeof image.retryUsed === "boolean") &&
      (image.captionRequested === undefined || typeof image.captionRequested === "boolean") &&
      (image.speakDescription === undefined || typeof image.speakDescription === "boolean")
  }

  private async preserveRecovery(generation: number): Promise<void> {
    await this.preserveJournal(this.loadedJournal ?? this.journalSnapshot(), generation)
    this.pendingEvents = []
    this.draftEvents = []
    this.resumptionHandle = ""
    this.resumptionUpdatedAt = 0
    this.callbacks.onPersistenceError("Original conversation backup kept on this device")
  }

  private async prepareRecovery(generation: number): Promise<TranscriptRecovery | null> {
    if (!this.pendingEvents.length && !this.draftEvents.length) return null
    const saved = this.loadedJournal ? JSON.parse(this.loadedJournal) as SessionJournal : null
    const first = this.pendingEvents[0]
    const suffix = first ? `:${first.sequence}` : ""
    const original = saved?.sessionId ?? (first?.event_id.endsWith(suffix) ? first.event_id.slice(0, -suffix.length) : "")
    const lastSequence = this.pendingEvents[this.pendingEvents.length - 1]?.sequence
    const next = saved?.nextTranscriptSequence ?? (lastSequence === undefined ? 1 : lastSequence + 1)
    if (typeof original !== "string" || !original.trim() || original !== original.trim() || original.length > 256 ||
        !Number.isSafeInteger(next) || next < 1 ||
        (lastSequence !== undefined && next !== lastSequence + 1) ||
        this.pendingEvents.some((event, index) => event.event_id !== `${original}:${event.sequence}` ||
          (index > 0 && event.sequence !== this.pendingEvents[index - 1].sequence + 1))) {
      await this.preserveRecovery(generation)
      return null
    }
    this.sessionId = original
    this.nextTranscriptSequence = next
    this.journalLoaded = true
    this.sealSpeechDrafts()
    if (!this.pendingEvents.length) return null
    // Recovery is already in the newly minted entry context; do not resume its old copy too.
    this.resumptionHandle = ""
    this.resumptionUpdatedAt = 0
    await this.persistBackup()
    this.journalLoaded = false
    if (this.stopping || generation !== this.generation) throw new Error("Gemini start cancelled")
    return {sitting_id: original, events: this.pendingEvents.map(event => ({...event}))}
  }

  private async reconcileJournal(recovered: boolean): Promise<void> {
    const saved = this.loadedJournal ? JSON.parse(this.loadedJournal) as SessionJournal : null
    const savedMode = saved && saved.callMode !== undefined ? saved.callMode : "audio"
    if (saved?.model !== this.model || savedMode !== this.vision.callMode) {
      this.resumptionHandle = ""
      this.resumptionUpdatedAt = 0
    }
    const generation = this.generation
    if (recovered) this.pendingEvents = []
    const photoOutsideHistory = this.pendingImages.flatMap(image => [image.imageSequence, image.assistantSequence])
      .some(sequence => sequence !== undefined && sequence >= this.nextTranscriptSequence)
    if (this.loadedJournal !== null && photoOutsideHistory) {
      await this.preserveJournal(this.loadedJournal, generation)
    }
    if (photoOutsideHistory) {
      this.resumptionHandle = ""
      this.resumptionUpdatedAt = 0
      this.draftEvents = []
      this.publishPhotoRetry()
    }
    this.journalLoaded = true
    for (const image of this.pendingImages) {
      if (!image.caption) {
        image.providerSent = false
        image.generation = this.generation
        image.sessionId = this.sessionId
      }
    }
    this.publishPhotoRetry()
    await this.persistBackup()
  }

  private async persistBackup(): Promise<void> {
    const write = this.persistJournal()
    if (this.journalOwner) await this.journalOwner.waitForBackup(write)
    else await write
  }

  private persistJournal(): Promise<boolean> {
    if (!this.journalOwner || !this.journalLoaded || !this.journalOwner.active(this.journalProducer)) return Promise.resolve(false)
    const empty = !this.resumptionHandle && !this.pendingEvents.length && !this.draftEvents.length && !this.pendingImages.length
    const write = this.journalOwner.write(empty ? "" : this.journalSnapshot(), this.journalProducer).then(saved => {
      if (!this.journalOwner!.active(this.journalProducer)) return false
      this.journalUnavailable = !saved
      if (!saved) this.callbacks.onPersistenceError("Local transcript backup unavailable")
      return saved
    })
    return write
  }

  private journalSnapshot(): string {
    const journal: SessionJournal = {
      version: 3,
      callMode: this.vision.callMode,
      ...(this.model ? {model: this.model} : {}),
      ...(this.sessionId ? {sessionId: this.sessionId} : {}),
      scope: {
        userId: this.config.userId,
        soulId: this.config.soulId,
        deviceSessionId: this.config.deviceSessionId,
      },
      resumption: this.resumptionHandle
        ? {handle: this.resumptionHandle, updatedAt: this.resumptionUpdatedAt}
        : null,
      pendingTranscripts: this.pendingEvents,
      draftTranscripts: this.draftEvents,
      nextTranscriptSequence: this.nextTranscriptSequence,
      pendingImages: this.pendingImages,
    }
    return JSON.stringify(journal)
  }

  private archiveJournal(raw: string): Promise<void> {
    return this.journalOwner!.archive(raw, this.journalProducer)
  }

  private async preserveJournal(raw: string, generation: number): Promise<void> {
    try {
      if (this.journalOwner?.hasDetachedWrites) this.journalOwner.fresh()
      else await this.archiveJournal(raw)
    } catch {
      this.journalOwner?.fresh()
    }
    if (this.stopping || generation !== this.generation) throw new Error("Gemini start cancelled")
    this.loadedJournal = null
  }

  private requestReflection(): Promise<string | null> {
    const deadline = this.callbacks.getStopDeadline?.()
    if (deadline !== null && deadline !== undefined && deadline <= Date.now()) return Promise.resolve(null)
    this.reflecting = true
    this.clearTurn()
    return new Promise((resolve) => {
      const timeout = setTimeout(() => this.finishReflection(), REFLECTION_TIMEOUT_MS)
      this.reflectionResolve = (value) => {
        clearTimeout(timeout)
        this.clearStopDeadlineTimer()
        resolve(value)
      }
      this.refreshStopDeadline()
      if (!this.reflecting) return
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
        this.finishReflection()
      }
    })
  }

  private finishReflection(): void {
    if (!this.reflecting) return
    const value = this.outputTranscript.trim() || null
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
    this.publishFrameDelivery()
    try {
      trace("provider.socket.closed", {resumable: Boolean(this.resumptionHandle)})
      this.socket = null
      this.ready = false
      this.disconnectToolBatch()
      if (this.reflecting) {
        this.finishReflection()
        return
      }
      const interrupted = this.turnActive || Boolean(this.outputTranscript.trim())
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
          if (this.ownsJournal()) this.callbacks.onReconnecting(false)
          return
        } catch (error) {
          if (this.ownsJournal()) this.callbacks.onReconnecting(false)
          if (!this.stopPromise && generation === this.generation && sessionId === this.sessionId) {
            this.reportError(error instanceof Error ? error : new Error(String(error)))
          }
          return
        }
      }
      this.reportError(new Error("Gemini connection closed"))
    } finally {
      this.reconnecting = false
      if (this.draining && !this.ready) this.drainResolve?.()
      this.resumeBackgroundWork()
    }
  }

  private resetImageDelivery(): void {
    const attempt = this.photoJob
    if (attempt && "selection" in attempt) {
      attempt.selection.failed = true
      this.finishSelection(attempt)
      return
    }
    if (attempt?.phase === "filing") return
    this.clearPhotoJob()
    const call = attempt && this.pendingToolCalls.get(attempt.callId)
    if (call && call.name === "nothing_to_add") {
      call.parts = undefined
      call.response = {ok: true}
      call.scheduling = "SILENT"
    }
    const image = attempt?.image
    if (image && this.pendingImages.includes(image) && !image.caption) {
      image.providerSent = false
      this.invitationPending = true
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
      this.ownsJournal() &&
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
        this.resumeBackgroundWork()
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
    this.publishFrameDelivery()
    if ([...this.pendingToolCalls.values()].some(isUncertainWrite)) {
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
