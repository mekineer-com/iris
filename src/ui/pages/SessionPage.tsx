import {useRef, useState} from "react"
import {useRpc} from "@mentra/miniapp/ui"

import type {Channels} from "../../shared/channels"
import type {ConnectionState, ManualAction, ManualPhase, SessionMode} from "../../shared/types"
import {useChannel} from "../hooks/useChannel"

function unreachable(value: never): never {
  throw new Error(`Unhandled session state: ${value}`)
}

export function statusText(connection: ConnectionState, mode: SessionMode, manualPhase: ManualPhase): string {
  switch (connection) {
    case "starting": return "Starting..."
    case "stopping": return "Stopping..."
    case "error": return "Error"
    case "speaking": return "Speaking"
    case "idle": return "Idle"
    case "listening": break
    default: return unreachable(connection)
  }
  if (mode === "continuous") return "Listening"
  if (mode !== "manual") return unreachable(mode)
  switch (manualPhase) {
    case "idle": return "Ready"
    case "recording": return "Recording..."
    case "review": return "Review recording"
    case "submitted": return "Waiting for Siri..."
    default: return unreachable(manualPhase)
  }
}

export function visibleConnection(
  connection: ConnectionState,
  startPending: boolean,
  stopPending: boolean,
): ConnectionState {
  if (stopPending) return "stopping"
  if (startPending && (connection === "idle" || connection === "error")) return "starting"
  return connection
}

export default function SessionPage() {
  const snapshot = useChannel("openalma:update")
  const startRpc = useRpc<Channels, "openalma:start">("openalma:start")
  const stopRpc = useRpc<Channels, "openalma:stop">("openalma:stop")
  const modeRpc = useRpc<Channels, "openalma:set-mode">("openalma:set-mode")
  const manualRpc = useRpc<Channels, "openalma:manual-action">("openalma:manual-action")
  const [startPending, setStartPending] = useState(false)
  const [stopPending, setStopPending] = useState(false)
  const [modePending, setModePending] = useState(false)
  const [manualPending, setManualPending] = useState(false)
  const [rpcError, setRpcError] = useState<string | null>(null)
  const startOwner = useRef(0)

  const connection = snapshot?.connection ?? "idle"
  const mode = snapshot?.mode ?? "continuous"
  const manualPhase = snapshot?.manualPhase ?? "idle"
  const visible = visibleConnection(connection, startPending, stopPending)
  const starting = visible === "starting"
  const stopping = visible === "stopping"
  const active = starting || visible === "listening" || visible === "speaking"
  const modeDisabled = active || stopping || startPending || stopPending || modePending

  const onStart = async () => {
    const owner = ++startOwner.current
    setRpcError(null)
    setStartPending(true)
    try {
      await startRpc({mode})
    } catch (error) {
      if (owner === startOwner.current) {
        setRpcError(error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (owner === startOwner.current) setStartPending(false)
    }
  }

  const onStop = async () => {
    startOwner.current += 1
    setStartPending(false)
    setRpcError(null)
    setStopPending(true)
    try {
      await stopRpc({})
    } catch (error) {
      setRpcError(error instanceof Error ? error.message : String(error))
    } finally {
      setStopPending(false)
    }
  }

  const onMode = async (next: SessionMode) => {
    setRpcError(null)
    setModePending(true)
    try {
      await modeRpc({mode: next})
    } catch (error) {
      setRpcError(error instanceof Error ? error.message : String(error))
    } finally {
      setModePending(false)
    }
  }

  const onManual = async (action: ManualAction) => {
    setRpcError(null)
    setManualPending(true)
    try {
      await manualRpc({action})
    } catch (error) {
      setRpcError(error instanceof Error ? error.message : String(error))
    } finally {
      setManualPending(false)
    }
  }

  const sittingLabel = stopping
    ? "Stopping..."
    : starting
      ? "Cancel"
      : active
        ? "Stop"
        : visible === "error"
          ? "Retry"
          : "Start"
  const sittingDisabled = stopping || stopPending || modePending || (!active && startPending)
  const showSpinner = starting || stopping
  const manualDisabled = manualPending || visible === "speaking"
  const voiceReady = visible === "listening" || visible === "speaking"

  return (
    <main>
      <header>
        <p className="eyebrow">OpenAlma voice</p>
        <h1>Iris</h1>
      </header>
      <p className="status" role="status" aria-live="polite">
        {showSpinner ? <span className="spinner" aria-hidden="true" /> : null}
        {statusText(visible, mode, manualPhase)}
      </p>
      <label className="mode-control">
        <span>Speech mode</span>
        <select
          value={mode}
          disabled={modeDisabled}
          onChange={(event) => void onMode(event.target.value as SessionMode)}
        >
          <option value="continuous">Continuous</option>
          <option value="manual">Manual</option>
        </select>
      </label>
      <section className="controls" aria-label="Voice controls">
        <button
          type="button"
          className="sitting-button"
          disabled={sittingDisabled}
          onClick={() => void (active ? onStop() : onStart())}
        >
          {sittingLabel}
        </button>
        {mode === "manual" && voiceReady ? (
          <div className="manual-controls">
            {manualPhase === "idle" ? (
              <button type="button" disabled={manualDisabled} onClick={() => void onManual("talk")}>
                Talk
              </button>
            ) : null}
            {manualPhase === "recording" ? (
              <button
                type="button"
                className="recording-button"
                disabled={manualDisabled}
                onClick={() => void onManual("done")}
              >
                Done
              </button>
            ) : null}
            {manualPhase === "review" ? (
              <>
                <button type="button" disabled={manualDisabled} onClick={() => void onManual("send")}>
                  Send
                </button>
                <button type="button" disabled={manualDisabled} onClick={() => void onManual("redo")}>
                  Redo
                </button>
              </>
            ) : null}
            {manualPhase === "submitted" ? <button type="button" disabled>Send</button> : null}
          </div>
        ) : null}
      </section>
      {snapshot?.lastError ? <p role="alert">{snapshot.lastError}</p> : null}
      {rpcError ? <p role="alert">{rpcError}</p> : null}
    </main>
  )
}
