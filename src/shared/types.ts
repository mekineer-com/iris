export type SessionMode = "continuous" | "manual"
export type ConnectionState = "idle" | "starting" | "reconnecting" | "listening" | "speaking" | "stopping" | "error"
export type EarconName = "listen-start" | "listen-stop" | "disconnected"
export type ManualPhase = "idle" | "recording" | "review" | "submitted"
export type ManualAction = "talk" | "done" | "redo" | "send"

export interface SessionSnapshot {
  mode: SessionMode
  connection: ConnectionState
  manualPhase: ManualPhase
  lastError: string | null
  usageTotalTokens: number | null
  durationWarning: boolean
}
