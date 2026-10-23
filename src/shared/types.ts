export type SessionMode = "continuous" | "manual"
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
  imageId: string
  mimeType: "image/jpeg"
  data: string
  modelData: string
  time: Pick<ImageTime, "timestamp" | "receivedAt"> & {source: "receipt"}
}

export type FrameIntakeResult =
  | {retained: true; delivery: "not-sent"}
  | {retained: false; delivery: "not-sent"; reason: "unavailable" | "full"}

export interface SessionSnapshot {
  closingThoughts: boolean
  frameDeliveryOpen: boolean
  stopDeadlineAt: number | null
  startGeneration: number
  configured: boolean
  connectionProfile: OpenAlmaProfile | null
  mode: SessionMode
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
