import {useEffect, useRef, useState} from "react"
import {useRpc} from "@mentra/miniapp/ui"

import type {Channels} from "../../shared/channels"
import type {ImageRequest} from "../../shared/channels"
import {PHOTO_RETRY_MESSAGE, type ConnectionState, type ManualAction, type ManualPhase, type SessionMode} from "../../shared/types"
import {useChannel} from "../hooks/useChannel"

function unreachable(value: never): never {
  throw new Error(`Unhandled session state: ${value}`)
}

export function statusText(connection: ConnectionState, mode: SessionMode, manualPhase: ManualPhase): string {
  switch (connection) {
    case "starting": return "Starting..."
    case "reconnecting": return "Reconnecting..."
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

const MAX_IMAGE_BYTES = 1024 * 1024

export function validateImageFile(file: Pick<File, "size" | "type">): "image/jpeg" | "image/png" {
  if (file.type !== "image/jpeg" && file.type !== "image/png") throw new Error("Choose a JPEG or PNG image")
  if (file.size <= 0 || file.size > MAX_IMAGE_BYTES) throw new Error("Photo must be between 1 byte and 1 MB")
  return file.type
}

export async function imageRequest(file: File, imageId: string): Promise<ImageRequest> {
  const mimeType = validateImageFile(file)
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ""
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return {imageId, mimeType, data: btoa(binary)}
}

export const newImageId = (now = Date.now(), random = Math.random()) =>
  `image-${now.toString(36)}-${random.toString(36).slice(2)}`

type PendingPhoto = {file: File; imageId: string; previewUrl: string | null}

export default function SessionPage() {
  const snapshot = useChannel("openalma:update")
  const startRpc = useRpc<Channels, "openalma:start">("openalma:start")
  const stopRpc = useRpc<Channels, "openalma:stop">("openalma:stop")
  const modeRpc = useRpc<Channels, "openalma:set-mode">("openalma:set-mode")
  const manualRpc = useRpc<Channels, "openalma:manual-action">("openalma:manual-action")
  const imageRpc = useRpc<Channels, "openalma:image">("openalma:image")
  const pendingImageRpc = useRpc<Channels, "openalma:pending-image">("openalma:pending-image")
  const [startPending, setStartPending] = useState(false)
  const [stopPending, setStopPending] = useState(false)
  const [modePending, setModePending] = useState(false)
  const [manualPending, setManualPending] = useState(false)
  const [previewImages, setPreviewImages] = useState(false)
  const [pendingPhoto, setPendingPhoto] = useState<PendingPhoto | null>(null)
  const [imagePending, setImagePending] = useState(false)
  const [imageStatus, setImageStatus] = useState<string | null>(null)
  const [rpcError, setRpcError] = useState<string | null>(null)
  const startOwner = useRef(0)
  const imageOwner = useRef(0)

  useEffect(() => () => {
    if (pendingPhoto?.previewUrl) URL.revokeObjectURL(pendingPhoto.previewUrl)
  }, [pendingPhoto])

  const discardPhoto = () => {
    setPendingPhoto(null)
  }

  const connection = snapshot?.connection ?? "idle"
  const mode = snapshot?.mode ?? "continuous"
  const manualPhase = snapshot?.manualPhase ?? "idle"
  const photoRetryPending = snapshot?.photoRetryPending ?? false
  const visible = visibleConnection(connection, startPending, stopPending)
  const starting = visible === "starting"
  const stopping = visible === "stopping"
  const reconnecting = visible === "reconnecting"
  const active = starting || reconnecting || visible === "listening" || visible === "speaking"
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
    imageOwner.current += 1
    setImagePending(false)
    discardPhoto()
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
    imageOwner.current += 1
    setImagePending(false)
    discardPhoto()
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

  const submitPhoto = async (photo: PendingPhoto) => {
    const owner = ++imageOwner.current
    setRpcError(null)
    setImageStatus(null)
    setImagePending(true)
    try {
      await imageRpc(await imageRequest(photo.file, photo.imageId))
      if (owner !== imageOwner.current) return
      discardPhoto()
      setImageStatus("Photo sent")
    } catch (error) {
      if (owner !== imageOwner.current) return
      setPendingPhoto(photo)
      setRpcError(error instanceof Error ? error.message : String(error))
      setImageStatus("Photo ready to retry")
    } finally {
      if (owner === imageOwner.current) setImagePending(false)
    }
  }

  const onImagePicked = (input: HTMLInputElement) => {
    const file = input.files?.[0]
    input.value = ""
    if (!file) return
    setRpcError(null)
    setImageStatus(null)
    try {
      validateImageFile(file)
    } catch (error) {
      setRpcError(error instanceof Error ? error.message : String(error))
      return
    }
    discardPhoto()
    const photo = {
      file,
      imageId: newImageId(),
      previewUrl: previewImages ? URL.createObjectURL(file) : null,
    }
    setPendingPhoto(photo)
    if (!previewImages) void submitPhoto(photo)
  }

  const handleStoredPhoto = async (action: "retry" | "discard") => {
    setImagePending(true)
    setRpcError(null)
    try {
      await pendingImageRpc({action})
      if (action === "discard") setImageStatus(null)
    } catch (error) {
      setRpcError(error instanceof Error ? error.message : String(error))
    } finally {
      setImagePending(false)
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
  const showSpinner = starting || reconnecting || stopping
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
      <label className="preview-control">
        <input type="checkbox" checked={previewImages} onChange={(event) => setPreviewImages(event.target.checked)} />
        Preview before send
      </label>
      <div className="image-actions">
        <label className="image-picker">
          <span>Take photo</span>
          <input
            type="file"
            accept="image/*"
            capture="environment"
            disabled={!voiceReady || imagePending || stopping || photoRetryPending}
            onChange={(event) => onImagePicked(event.currentTarget)}
          />
        </label>
        <label className="image-picker">
          <span>Choose image</span>
          <input
            type="file"
            accept="image/*"
            disabled={!voiceReady || imagePending || stopping || photoRetryPending}
            onChange={(event) => onImagePicked(event.currentTarget)}
          />
        </label>
      </div>
      {pendingPhoto?.previewUrl ? <img className="image-preview" src={pendingPhoto.previewUrl} alt="Selected photo preview" /> : null}
      {pendingPhoto && !photoRetryPending ? (
        <div className="image-review">
          <button type="button" disabled={imagePending || !voiceReady} onClick={() => void submitPhoto(pendingPhoto)}>
            {imagePending ? "Sending..." : imageStatus ? "Retry" : "Send"}
          </button>
          <button type="button" disabled={imagePending} onClick={() => discardPhoto()}>Retake</button>
        </div>
      ) : null}
      {imageStatus ? <p role="status">{imageStatus}</p> : null}
      {photoRetryPending && voiceReady ? (
        <div>
          <p role="status">{PHOTO_RETRY_MESSAGE}</p>
          <div className="image-review">
            <button type="button" disabled={imagePending} onClick={() => void handleStoredPhoto("retry")}>Retry</button>
            <button type="button" disabled={imagePending} onClick={() => void handleStoredPhoto("discard")}>Discard</button>
          </div>
        </div>
      ) : null}
      {snapshot?.lastError && snapshot.lastError !== PHOTO_RETRY_MESSAGE ? <p role="alert">{snapshot.lastError}</p> : null}
      {snapshot?.durationWarning ? <p role="status">Session duration warning</p> : null}
      {snapshot?.usageTotalTokens !== null && snapshot?.usageTotalTokens !== undefined ? (
        <p>Provider tokens: {snapshot.usageTotalTokens.toLocaleString()}</p>
      ) : null}
      {rpcError ? <p role="alert">{rpcError}</p> : null}
    </main>
  )
}
