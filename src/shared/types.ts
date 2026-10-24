export type SessionMode = "continuous" | "manual"
export type CallMode = "audio" | "video"
export type VisionStart = {callMode: CallMode; maxMemorizedPhotos: number}
export const VISION_SETTINGS = {
  capturePeriodMs: 2_000, maxFrames: 12, maxEncodedBytes: 8 * 1024 * 1024,
  maxOffer: 6, maxWidth: 768, jpegQuality: 0.8,
  comparisonWidth: 96, comparisonHeight: 64,
  collageWidth: 768, collageHeight: 768, collageColumns: 2, collageGap: 8,
} as const
export type CatchUpRender = {renderId: string; imageIds: string[]}
export type CatchUpResult = {startGeneration: number; renderId: string} &
  ({data: string; error?: never} | {error: string; data?: never})
export const LIVE_MODELS = ["gemini-3.8-live", "gemini-3.8-live-extended-thinking"] as const
export type LiveModel = typeof LIVE_MODELS[number]
export const MIC_SOURCES = ["glasses", "phone", "bluetooth", "bluetoothClassic"] as const
export type MicSource = typeof MIC_SOURCES[number]
export type ConnectionState = "idle" | "starting" | "reconnecting" | "listening" | "speaking" | "stopping" | "error"
export type EarconName = "listen-start" | "listen-stop" | "disconnected"
export type ManualPhase = "idle" | "recording" | "review" | "submitted"
export type ManualAction = "talk" | "done" | "redo" | "send"
export const PHOTO_RETRY_MESSAGE = "Photo processing is unfinished. Retry or discard the pending work."
export const STOP_FOREGROUND_MS = 30_000
export const STOP_BACKGROUND_MS = 5 * 60_000

export type OpenAlmaProfile = {
  baseUrl: string
  userId: string
  deviceSessionId: string
  installationTicket?: string
  installationConfirmed?: boolean
}

export type PhotoCaption = {imageId: string; caption: string; durable: boolean}

export interface ImageTime {
  timestamp: string
  source: "DateTimeOriginal" | "CreateDate" | "receipt"
  receivedAt: number
  originalTime?: string
  offset?: string
}

export type FrameRetention = {maxFrames: number; maxEncodedBytes: number}

export type PassiveFrame = {
  reservationSequence: number
  imageId: string
  mimeType: "image/jpeg"
  data: string
  modelData: string
  time: Pick<ImageTime, "timestamp" | "receivedAt"> & {source: "receipt"}
}

export type FrameIntakeResult =
  | {retained: true; delivery: "sent" | "not-sent"}
  | {retained: false; delivery: "sent"}
  | {retained: false; delivery: "not-sent"; reason: "unavailable" | "full" | "stale"}

export interface SessionSnapshot {
  callMode: CallMode
  maxMemorizedPhotos: number
  catchUpRender: CatchUpRender | null
  closingThoughts: boolean
  frameDeliveryOpen: boolean
  stopDeadlineAt: number | null
  startGeneration: number
  configured: boolean
  connectionProfile: OpenAlmaProfile | null
  mode: SessionMode
  model: string | null
  configuredModel: string | null
  modelSaving: boolean
  connection: ConnectionState
  soulId: string
  souls: string[]
  soulLoading: boolean
  soulConfirmed: boolean
  soulLocked: boolean
  connectionLocked: boolean
  memuAvailable: boolean | null
  manualPhase: ManualPhase
  microphoneEnabled: boolean
  cameraEnabled: boolean
  photoRetryPending: boolean
  pendingPhotoIds: string[]
  photoCaptions: Array<PhotoCaption & {receivedAt: number}>
  failedPhotos?: string[]
  lastError: string | null
  usageTotalTokens: number | null
  durationWarning: boolean
}
