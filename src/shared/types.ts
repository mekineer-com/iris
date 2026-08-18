export type SessionMode = "continuous" | "manual"
export type ConnectionState = "idle" | "starting" | "listening" | "speaking" | "stopping" | "error"
export type EarconName = "listen-start" | "listen-stop" | "disconnected"

export interface SessionSnapshot {
  mode: SessionMode
  connection: ConnectionState
  lastError: string | null
}
