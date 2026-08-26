import {useState} from "react"
import {useRpc} from "@mentra/miniapp/ui"

import type {Channels} from "../../shared/channels"
import type {ConnectionState, ManualAction, ManualPhase, SessionMode} from "../../shared/types"
import {useChannel} from "../hooks/useChannel"

function statusText(connection: ConnectionState, mode: SessionMode, manualPhase: ManualPhase): string {
  if (connection === "starting") return "Starting..."
  if (connection === "stopping") return "Stopping..."
  if (connection === "error") return "Error"
  if (connection === "speaking") return "Speaking"
  if (connection === "idle") return "Idle"
  if (mode === "continuous") return "Listening"
  if (manualPhase === "recording") return "Recording..."
  if (manualPhase === "review") return "Review recording"
  if (manualPhase === "submitted") return "Waiting for Siri..."
  return "Ready"
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

  const connection = snapshot?.connection ?? "idle"
  const mode = snapshot?.mode ?? "continuous"
  const manualPhase = snapshot?.manualPhase ?? "idle"
  const controllerActive = connection === "starting" || connection === "listening" || connection === "speaking"
  const visibleConnection = stopPending && controllerActive
    ? "stopping"
    : startPending && (connection === "idle" || connection === "error")
      ? "starting"
      : connection
  const starting = visibleConnection === "starting"
  const stopping = visibleConnection === "stopping"
  const active = starting || visibleConnection === "listening" || visibleConnection === "speaking"
  const modeDisabled = active || stopping || startPending || stopPending || modePending

  const onStart = async () => {
    setRpcError(null)
    setStartPending(true)
    try {
      await startRpc({mode})
    } catch (error) {
      setRpcError(error instanceof Error ? error.message : String(error))
    } finally {
      setStartPending(false)
    }
  }

  const onStop = async () => {
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
        : visibleConnection === "error"
          ? "Retry"
          : "Start"
  const sittingDisabled = stopping || stopPending || (!active && startPending)
  const showSpinner = starting || stopping
  const manualDisabled = manualPending || visibleConnection === "speaking"
  const voiceReady = visibleConnection === "listening" || visibleConnection === "speaking"

  return (
    <main>
      <header>
        <p className="eyebrow">OpenAlma voice</p>
        <h1>Iris</h1>
      </header>
      <p className="status" role="status" aria-live="polite">
        {showSpinner ? <span className="spinner" aria-hidden="true" /> : null}
        {statusText(visibleConnection, mode, manualPhase)}
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
                disabled={manualPending}
                onClick={() => void onManual("done")}
              >
                Done
              </button>
            ) : null}
            {manualPhase === "review" ? (
              <>
                <button type="button" disabled={manualPending} onClick={() => void onManual("send")}>
                  Send
                </button>
                <button type="button" disabled={manualPending} onClick={() => void onManual("redo")}>
                  Redo
                </button>
              </>
            ) : null}
          </div>
        ) : null}
      </section>
      {snapshot?.lastError ? <p role="alert">{snapshot.lastError}</p> : null}
      {rpcError ? <p role="alert">{rpcError}</p> : null}
    </main>
  )
}
