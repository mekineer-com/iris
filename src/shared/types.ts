export type SessionMode = "continuous" | "manual"
export type ConnectionState = "idle" | "starting" | "reconnecting" | "listening" | "speaking" | "stopping" | "error"
export type EarconName = "listen-start" | "listen-stop" | "disconnected"
export type ManualPhase = "idle" | "recording" | "review" | "submitted"
export type ManualAction = "talk" | "done" | "redo" | "send"
export const PHOTO_RETRY_MESSAGE = "Photo processing is unfinished. Retry or discard the pending work."

export type OpenAlmaProfile = {
  baseUrl: string
  userId: string
  deviceSessionId: string
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
  lastError: string | null
  usageTotalTokens: number | null
  durationWarning: boolean
}
