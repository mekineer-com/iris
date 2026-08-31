export type SessionMode = "continuous" | "manual"
export type ConnectionState = "idle" | "starting" | "reconnecting" | "listening" | "speaking" | "stopping" | "error"
export type EarconName = "listen-start" | "listen-stop" | "disconnected"
export type ManualPhase = "idle" | "recording" | "review" | "submitted"
export type ManualAction = "talk" | "done" | "redo" | "send"
export const PHOTO_RETRY_MESSAGE = "This photo didn't make it through. Retry or discard it."

export interface SessionSnapshot {
  mode: SessionMode
  connection: ConnectionState
  manualPhase: ManualPhase
  photoRetryPending: boolean
  lastError: string | null
  usageTotalTokens: number | null
  durationWarning: boolean
}
