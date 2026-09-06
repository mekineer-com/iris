export type SessionMode = "continuous" | "manual"
export type ConnectionState = "idle" | "starting" | "reconnecting" | "listening" | "speaking" | "stopping" | "error"
export type EarconName = "listen-start" | "listen-stop" | "disconnected"
export type ManualPhase = "idle" | "recording" | "review" | "submitted"
export type ManualAction = "talk" | "done" | "redo" | "send"
export const PHOTO_RETRY_MESSAGE = "Photo processing is unfinished. Retry or discard the pending work."

export interface SessionSnapshot {
  mode: SessionMode
  connection: ConnectionState
  soulId: string
  souls: string[]
  soulLoading: boolean
  soulConfirmed: boolean
  soulLocked: boolean
  manualPhase: ManualPhase
  microphoneEnabled: boolean
  cameraEnabled: boolean
  photoRetryPending: boolean
  lastError: string | null
  usageTotalTokens: number | null
  durationWarning: boolean
}
