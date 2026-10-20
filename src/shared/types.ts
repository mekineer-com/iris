export type SessionMode = "continuous" | "manual"
export const MIC_SOURCES = ["glasses", "phone", "bluetooth", "bluetoothClassic"] as const
export type MicSource = typeof MIC_SOURCES[number]
export type ConnectionState = "idle" | "starting" | "reconnecting" | "listening" | "speaking" | "stopping" | "error"
export type EarconName = "listen-start" | "listen-stop" | "disconnected"
export type ManualPhase = "idle" | "recording" | "review" | "submitted"
export type ManualAction = "talk" | "done" | "redo" | "send"
export const PHOTO_RETRY_MESSAGE = "Photo processing is unfinished. Retry or discard the pending work."

export type OpenAlmaProfile = {
  baseUrl: string
  userId: string
  deviceSessionId: string
  installationTicket?: string
  installationConfirmed?: boolean
}

export interface SessionSnapshot {
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
  failedPhotos?: string[]
  lastError: string | null
  usageTotalTokens: number | null
  durationWarning: boolean
}
