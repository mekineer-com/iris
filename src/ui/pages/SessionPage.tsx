import {useEffect, useRef, useState} from "react"
import {useRpc} from "@mentra/miniapp/ui"

import type {Channels, ImageRequest, SelectSoulResult} from "../../shared/channels"
import {
  PHOTO_RETRY_MESSAGE,
  type ConnectionState,
  type ManualAction,
  type ManualPhase,
  type OpenAlmaProfile,
  type SessionMode,
} from "../../shared/types"
import {useChannel} from "../hooks/useChannel"
import memuIcon from "../memu-icon.png"

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

const LARGE_IMAGE_BYTES = 1024 * 1024
const LARGE_IMAGE_WARNING_KEY = "openalma.dismiss-large-image-warning"

export function validateImageFile(file: Pick<File, "size" | "type">): "image/jpeg" | "image/png" {
  if (file.type !== "image/jpeg" && file.type !== "image/png") throw new Error("Choose a JPEG or PNG image")
  if (file.size <= 0) throw new Error("Photo is empty")
  return file.type
}

export const shouldWarnLargeImage = (size: number, warningDismissed: boolean) =>
  size > LARGE_IMAGE_BYTES && !warningDismissed

export async function imageRequest(
  file: File,
  imageId: string,
  speakDescription: boolean,
): Promise<ImageRequest> {
  const mimeType = validateImageFile(file)
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ""
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return {imageId, mimeType, data: btoa(binary), speakDescription}
}

export const newImageId = (now = Date.now(), random = Math.random()) =>
  `image-${now.toString(36)}-${random.toString(36).slice(2)}`

type PendingPhoto = {file: File; imageId: string; previewUrl: string | null}

export default function SessionPage() {
  const snapshot = useChannel("openalma:update")
  const profileRpc = useRpc<Channels, "openalma:set-profile">("openalma:set-profile")
  const clearProfileRpc = useRpc<Channels, "openalma:clear-profile">("openalma:clear-profile")
  const startRpc = useRpc<Channels, "openalma:start">("openalma:start")
  const stopRpc = useRpc<Channels, "openalma:stop">("openalma:stop")
  const soulRpc = useRpc<Channels, "openalma:set-soul">("openalma:set-soul")
  const modeRpc = useRpc<Channels, "openalma:set-mode">("openalma:set-mode")
  const capabilitiesRpc = useRpc<Channels, "openalma:set-capabilities">("openalma:set-capabilities")
  const manualRpc = useRpc<Channels, "openalma:manual-action">("openalma:manual-action")
  const imageRpc = useRpc<Channels, "openalma:image">("openalma:image")
  const pendingImageRpc = useRpc<Channels, "openalma:pending-image">("openalma:pending-image")
  const [startPending, setStartPending] = useState(false)
  const [stopPending, setStopPending] = useState(false)
  const [soulName, setSoulName] = useState("")
  const [soulDirty, setSoulDirty] = useState(true)
  const [soulPending, setSoulPending] = useState(false)
  const [soulMenuOpen, setSoulMenuOpen] = useState(false)
  const [pendingNewSoul, setPendingNewSoul] = useState<string | null>(null)
  const [showNewSoulInfo, setShowNewSoulInfo] = useState(false)
  const [confirmationSoul, setConfirmationSoul] = useState<string | null>(null)
  const [modePending, setModePending] = useState(false)
  const [capabilitiesPending, setCapabilitiesPending] = useState(false)
  const [manualPending, setManualPending] = useState(false)
  const [previewImages, setPreviewImages] = useState(false)
  const [speakPhotoDescriptions, setSpeakPhotoDescriptions] = useState(false)
  const [largeImageWarningDismissed, setLargeImageWarningDismissed] = useState(
    () => localStorage.getItem(LARGE_IMAGE_WARNING_KEY) === "1",
  )
  const [pendingPhoto, setPendingPhoto] = useState<PendingPhoto | null>(null)
  const [imagePending, setImagePending] = useState(false)
  const [imageStatus, setImageStatus] = useState<string | null>(null)
  const [rpcError, setRpcError] = useState<string | null>(null)
  const [profilePending, setProfilePending] = useState(false)
  const [identityConfirmed, setIdentityConfirmed] = useState(false)
  const [profile, setProfile] = useState<OpenAlmaProfile>({
    baseUrl: "",
    bearer: "",
    userId: "",
    soulId: "",
    deviceSessionId: "",
  })
  const startOwner = useRef(0)
  const imageOwner = useRef(0)

  useEffect(() => () => {
    if (pendingPhoto?.previewUrl) URL.revokeObjectURL(pendingPhoto.previewUrl)
  }, [pendingPhoto])

  useEffect(() => {
    setSoulName(snapshot?.soulId ?? "")
    setSoulDirty(!(snapshot?.soulConfirmed ?? false))
    setPendingNewSoul(null)
    setShowNewSoulInfo(false)
    imageOwner.current += 1
    setPendingPhoto(null)
    setImagePending(false)
    setImageStatus(null)
  }, [snapshot?.soulId, snapshot?.soulConfirmed])

  const discardPhoto = () => {
    setPendingPhoto(null)
  }

  const connection = snapshot?.connection ?? "idle"
  const mode = snapshot?.mode ?? "continuous"
  const manualPhase = snapshot?.manualPhase ?? "idle"
  const photoRetryPending = snapshot?.photoRetryPending ?? false
  const microphoneEnabled = snapshot?.microphoneEnabled ?? true
  const cameraEnabled = snapshot?.cameraEnabled ?? true
  const visible = visibleConnection(connection, startPending, stopPending)
  const starting = visible === "starting"
  const stopping = visible === "stopping"
  const reconnecting = visible === "reconnecting"
  const active = starting || reconnecting || visible === "listening" || visible === "speaking"
  const modeDisabled = active || stopping || startPending || stopPending || modePending
  const soulLocked = snapshot?.soulLocked ?? true
  const soulReady = !soulDirty && snapshot?.soulConfirmed && soulName.trim() === snapshot.soulId
  const knownSoul = snapshot?.souls.includes(soulName.trim()) ?? false

  const selectSoul = async (soulId: string, useExisting: boolean): Promise<boolean> => {
    setRpcError(null)
    setSoulPending(true)
    try {
      const result = await soulRpc({soulId, useExisting}) as SelectSoulResult
      if ("confirmationRequired" in result) {
        setConfirmationSoul(result.soulId)
        return false
      }
      setSoulName(result.soulId)
      setSoulDirty(false)
      setPendingNewSoul(null)
      setConfirmationSoul(null)
      return true
    } catch (error) {
      setRpcError(error instanceof Error ? error.message : String(error))
      return false
    } finally {
      setSoulPending(false)
    }
  }

  const submitSoul = async (): Promise<void> => {
    const soulId = soulName.trim()
    if (knownSoul) {
      setPendingNewSoul(null)
      await selectSoul(soulId, true)
    } else {
      setRpcError(null)
      setSoulDirty(false)
      setPendingNewSoul(soulId)
      setShowNewSoulInfo(false)
    }
  }

  const onStart = async () => {
    const owner = ++startOwner.current
    setRpcError(null)
    setStartPending(true)
    try {
      if (!soulReady) {
        if (pendingNewSoul !== soulName.trim() || !await selectSoul(soulName.trim(), false)) return
      }
      if (owner !== startOwner.current) return
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

  const onCapability = async (
    capability: "microphoneEnabled" | "cameraEnabled",
    enabled: boolean,
  ) => {
    setRpcError(null)
    setCapabilitiesPending(true)
    try {
      await capabilitiesRpc({[capability]: enabled})
    } catch (error) {
      setRpcError(error instanceof Error ? error.message : String(error))
    } finally {
      setCapabilitiesPending(false)
    }
  }

  const submitPhoto = async (photo: PendingPhoto) => {
    const owner = ++imageOwner.current
    setRpcError(null)
    setImageStatus(null)
    setImagePending(true)
    try {
      const request = await imageRequest(photo.file, photo.imageId, speakPhotoDescriptions)
      if (owner !== imageOwner.current) return
      await imageRpc(request)
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
    const warnLarge = shouldWarnLargeImage(file.size, largeImageWarningDismissed)
    const photo = {
      file,
      imageId: newImageId(),
      previewUrl: previewImages || warnLarge ? URL.createObjectURL(file) : null,
    }
    setPendingPhoto(photo)
    if (!previewImages && !warnLarge) void submitPhoto(photo)
  }

  const dismissLargeImageWarning = () => {
    localStorage.setItem(LARGE_IMAGE_WARNING_KEY, "1")
    setLargeImageWarningDismissed(true)
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

  const saveProfile = async () => {
    setProfilePending(true)
    setRpcError(null)
    try {
      await profileRpc({...profile, confirmIdentity: identityConfirmed})
    } catch (error) {
      setRpcError(error instanceof Error ? error.message : String(error))
    } finally {
      setProfilePending(false)
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
  const soulSubmitted = soulReady || pendingNewSoul === soulName.trim()
  const sittingDisabled = stopping || stopPending || modePending || soulPending || snapshot?.soulLoading !== false ||
    (!active && (startPending || !soulSubmitted))
  const showSpinner = starting || reconnecting || stopping
  const manualDisabled = manualPending || visible === "speaking"
  const voiceReady = visible === "listening" || visible === "speaking"

  if (!snapshot) return <main><p className="status">Loading Iris...</p></main>
  if (!snapshot.configured) {
    const field = (name: keyof OpenAlmaProfile, label: string, type = "text") => (
      <label>{label}<input type={type} value={profile[name]} disabled={profilePending}
        onChange={(event) => setProfile({...profile, [name]: event.target.value})} /></label>
    )
    return (
      <main>
        <header><p className="eyebrow">OpenAlma voice</p><h1>Iris setup</h1></header>
        <section className="soul-control" aria-label="OpenAlma connection setup">
          {field("baseUrl", "OpenAlma address")}
          {field("bearer", "Connection key", "password")}
          {field("userId", "Your name")}
          {field("soulId", "Soul name")}
          {field("deviceSessionId", "Phone ID")}
          <label><input type="checkbox" checked={identityConfirmed} disabled={profilePending}
            onChange={(event) => setIdentityConfirmed(event.target.checked)} /> Confirm new owner and Soul spellings</label>
          <button type="button" disabled={profilePending} onClick={() => void saveProfile()}>
            {profilePending ? "Connecting..." : "Save and connect"}
          </button>
          {snapshot.lastError ? <p role="alert">{snapshot.lastError}</p> : null}
          {rpcError ? <p role="alert">{rpcError}</p> : null}
        </section>
      </main>
    )
  }

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
      {snapshot?.memuAvailable === false ? (
        <p className="memu-status" role="status">
          <img src={memuIcon} alt="" />
          <span>memU is unavailable. Start memU, or <button type="button" onClick={() => void clearProfileRpc({})}>change connection</button>.</span>
        </p>
      ) : null}
      <section className="soul-control" aria-label="Soul selection">
        <label>
          <span>Soul</span>
          <span className="soul-entry">
            <span className="soul-combobox" onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) setSoulMenuOpen(false)
            }}>
              <input
                value={soulName}
                disabled={soulLocked || soulPending}
                onFocus={() => setSoulMenuOpen(true)}
                onChange={(event) => {
                  setSoulName(event.target.value)
                  setSoulDirty(true)
                  setConfirmationSoul(null)
                  setPendingNewSoul(null)
                  setShowNewSoulInfo(false)
                  setSoulMenuOpen(true)
                }}
              />
              {soulMenuOpen && snapshot?.souls.length ? (
                <span className="soul-options" role="listbox">
                  {snapshot.souls.map((soul) => (
                    <button key={soul} type="button" role="option" aria-selected={soul === soulName}
                      onClick={() => {
                        setSoulName(soul)
                        setSoulDirty(true)
                        setConfirmationSoul(null)
                        setPendingNewSoul(null)
                        setShowNewSoulInfo(false)
                        setSoulMenuOpen(false)
                        void selectSoul(soul, true)
                      }}>
                      {soul}
                    </button>
                  ))}
                </span>
              ) : null}
            </span>
            <button type="button" aria-label="Use soul"
              title={knownSoul ? "Select existing soul" : "Create new soul"}
              disabled={soulLocked || soulPending || !soulName.trim() || !soulDirty}
              onClick={() => void submitSoul()}>➤</button>
            {soulReady ? <span className="soul-ready" title="Soul exists and is ready">✓</span> : null}
            {pendingNewSoul === soulName.trim() ? (
              <button type="button" className="soul-new" aria-label="New soul information"
                title="New soul will be created" onClick={() => setShowNewSoulInfo((shown) => !shown)}>!</button>
            ) : null}
          </span>
        </label>
        {showNewSoulInfo ? <p className="soul-info">A new soul will be created when you press Start.</p> : null}
        {confirmationSoul ? (
          <div role="alert">
            <p>{confirmationSoul} already exists. Use its existing database?</p>
            <button type="button" disabled={soulPending} onClick={() => void selectSoul(confirmationSoul, true)}>
              Use existing soul
            </button>
          </div>
        ) : null}
        {soulLocked ? <p>Finish this sitting before changing souls.</p> : null}
      </section>
      <section className="mode-control" aria-label="Speech mode">
        <span>Speech mode</span>
        <div className="mode-options">
          <button type="button" aria-pressed={mode === "continuous"} disabled={modeDisabled}
            onClick={() => void onMode("continuous")}>Continuous</button>
          <button type="button" aria-pressed={mode === "manual"} disabled={modeDisabled}
            onClick={() => void onMode("manual")}>Manual</button>
        </div>
      </section>
      <label className="preview-control">
        <input
          type="checkbox"
          checked={microphoneEnabled}
          disabled={capabilitiesPending || stopping}
          onChange={(event) => void onCapability("microphoneEnabled", event.target.checked)}
        />
        Microphone enabled
      </label>
      <label className="preview-control">
        <input
          type="checkbox"
          checked={cameraEnabled}
          disabled={capabilitiesPending || stopping}
          onChange={(event) => void onCapability("cameraEnabled", event.target.checked)}
        />
        Camera enabled
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
              <button type="button" disabled={manualDisabled || !microphoneEnabled} onClick={() => void onManual("talk")}>
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
                <button type="button" disabled={manualDisabled || !microphoneEnabled} onClick={() => void onManual("redo")}>
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
      <label className="preview-control">
        <input
          type="checkbox"
          checked={speakPhotoDescriptions}
          onChange={(event) => setSpeakPhotoDescriptions(event.target.checked)}
        />
        Speak photo descriptions
      </label>
      <div className="image-actions">
        <label className="image-picker">
          <span>Take photo</span>
          <input
            type="file"
            accept="image/*"
            capture="environment"
            disabled={!cameraEnabled || !voiceReady || imagePending || stopping || photoRetryPending}
            onChange={(event) => onImagePicked(event.currentTarget)}
          />
        </label>
        <label className="image-picker">
          <span>Choose image</span>
          <input
            type="file"
            accept="image/*"
            disabled={!cameraEnabled || !voiceReady || imagePending || stopping || photoRetryPending}
            onChange={(event) => onImagePicked(event.currentTarget)}
          />
        </label>
      </div>
      {pendingPhoto?.previewUrl ? <img className="image-preview" src={pendingPhoto.previewUrl} alt="Selected photo preview" /> : null}
      {pendingPhoto && shouldWarnLargeImage(pendingPhoto.file.size, largeImageWarningDismissed) ? (
        <div role="alert">
          <p>This photo is over 1 MB and may take longer or cost more to process.</p>
          <label>
            <input type="checkbox" onChange={(event) => event.target.checked && dismissLargeImageWarning()} />
            Don't warn again
          </label>
        </div>
      ) : null}
      {pendingPhoto && !photoRetryPending ? (
        <div className="image-review">
          <button type="button" disabled={!cameraEnabled || imagePending || !voiceReady} onClick={() => void submitPhoto(pendingPhoto)}>
            {imagePending ? "Sending..." : imageStatus ? "Retry" : "Send"}
          </button>
          <button type="button" disabled={imagePending} onClick={() => discardPhoto()}>Retake</button>
        </div>
      ) : null}
      {imageStatus ? <p role="status">{imageStatus}</p> : null}
      {photoRetryPending ? (
        <div>
          <p role="status">{PHOTO_RETRY_MESSAGE}</p>
          <div className="image-review">
            <button type="button" disabled={imagePending || !voiceReady} onClick={() => void handleStoredPhoto("retry")}>Retry</button>
            <button type="button" disabled={imagePending} onClick={() => void handleStoredPhoto("discard")}>Discard</button>
          </div>
        </div>
      ) : null}
      {snapshot?.memuAvailable !== false && snapshot?.lastError && snapshot.lastError !== PHOTO_RETRY_MESSAGE
        ? <p role="alert">{snapshot.lastError}</p> : null}
      {snapshot?.durationWarning ? <p role="status">Session duration warning</p> : null}
      {snapshot?.usageTotalTokens !== null && snapshot?.usageTotalTokens !== undefined ? (
        <p>Provider tokens: {snapshot.usageTotalTokens.toLocaleString()}</p>
      ) : null}
      {rpcError ? <p role="alert">{rpcError}</p> : null}
    </main>
  )
}
